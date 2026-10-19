#include "DSHDataTableOps.h"

#include "DataTableEditorUtils.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Engine/DataTable.h"
#include "Misc/PackageName.h"
#include "ScopedTransaction.h"
#include "StructUtils/InstancedStruct.h"
#include "UObject/GCObject.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/StructOnScope.h"
#include "UObject/UnrealType.h"

namespace
{
constexpr int32 MaxTargets = 4096;
constexpr int32 MaxSnapshotRows = 10000;
constexpr int64 MaxSnapshotBytes = 64 * 1024 * 1024;

struct FRowSnapshot
{
    FName Name;
    TUniquePtr<FStructOnScope> Data;
};

class FSnapshotReferences final : public FGCObject
{
public:
    explicit FSnapshotReferences(TArray<FRowSnapshot>& InRows) : Rows(InRows) {}
    void AddReferencedObjects(FReferenceCollector& Collector) override
    {
        for (const FRowSnapshot& Row : Rows)
            if (Row.Data) Row.Data->AddReferencedObjects(Collector);
    }
    FString GetReferencerName() const override { return TEXT("DSHDataTableCopySnapshots"); }
private:
    TArray<FRowSnapshot>& Rows;
};

/** Bound reflected container payloads before allocating the snapshots. */
struct FSnapshotBudget
{
    int64 Bytes = 0;
    int32 Entries = 0;

    bool Add(int64 Amount)
    {
        if (Amount < 0 || Amount > MaxSnapshotBytes - Bytes) return false;
        Bytes += Amount;
        return true;
    }
    bool Struct(const UStruct* Type, const void* Data, int32 Depth = 0)
    {
        if (Depth > 32) return false;
        for (TFieldIterator<FProperty> It(Type); It; ++It)
            for (int32 Index = 0; Index < It->ArrayDim; ++Index)
                if (!Value(*It, It->ContainerPtrToValuePtr<void>(Data, Index), Depth + 1)) return false;
        return true;
    }
    bool Value(const FProperty* Property, const void* Data, int32 Depth)
    {
        if (Depth > 32 || ++Entries > 1000000) return false;
        if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
        {
            FScriptArrayHelper Helper(Array, Data);
            if (!Add(static_cast<int64>(Helper.Num()) * Array->Inner->ElementSize + 32)) return false;
            for (int32 Index = 0; Index < Helper.Num(); ++Index)
                if (!Value(Array->Inner, Helper.GetRawPtr(Index), Depth + 1)) return false;
        }
        else if (const FMapProperty* Map = CastField<FMapProperty>(Property))
        {
            FScriptMapHelper Helper(Map, Data);
            if (!Add(static_cast<int64>(Helper.GetMaxIndex()) * (Map->KeyProp->ElementSize + Map->ValueProp->ElementSize + 64))) return false;
            for (FScriptMapHelper::FIterator It(Helper); It; ++It)
                if (!Value(Map->KeyProp, Helper.GetKeyPtr(It), Depth + 1)
                    || !Value(Map->ValueProp, Helper.GetValuePtr(It), Depth + 1)) return false;
        }
        else if (const FSetProperty* Set = CastField<FSetProperty>(Property))
        {
            FScriptSetHelper Helper(Set, Data);
            if (!Add(static_cast<int64>(Helper.GetMaxIndex()) * (Set->ElementProp->ElementSize + 48))) return false;
            for (FScriptSetHelper::FIterator It(Helper); It; ++It)
                if (!Value(Set->ElementProp, Helper.GetElementPtr(It), Depth + 1)) return false;
        }
        else if (const FStructProperty* Inner = CastField<FStructProperty>(Property))
        {
            if (Inner->Struct == TBaseStructure<FInstancedStruct>::Get())
            {
                const FInstancedStruct* Instanced = static_cast<const FInstancedStruct*>(Data);
                if (const UScriptStruct* Type = Instanced->GetScriptStruct())
                    return Add(Type->GetStructureSize()) && Struct(Type, Instanced->GetMemory(), Depth + 1);
            }
            else return Struct(Inner->Struct, Data, Depth + 1);
        }
        else if (CastField<FStrProperty>(Property))
            return Add(static_cast<const FString*>(Data)->GetAllocatedSize());
        return true;
    }
};

bool SameProperty(const FProperty* Property, const void* A, const void* B)
{
    // Identical_InContainer checks one static-array element at a time.
    for (int32 Index = 0; Index < Property->ArrayDim; ++Index)
        if (!Property->Identical_InContainer(A, B, Index)) return false;
    return true;
}

/** Validate every row, in its original order, and every reflected property. */
bool Verify(UDataTable* Table, const UScriptStruct* RowStruct,
    const TArray<FRowSnapshot>& Before, const TSet<FName>& Targets,
    const FProperty* CopiedProperty, const void* SourceBefore, FString& Reason)
{
    if (Table->GetRowStruct() != RowStruct || Table->GetRowMap().Num() != Before.Num())
    {
        Reason = TEXT("The row schema or row count changed during the copy");
        return false;
    }
    int32 Index = 0;
    for (const auto& Row : Table->GetRowMap())
    {
        const FRowSnapshot& Original = Before[Index++];
        if (Row.Key != Original.Name || !Row.Value)
        {
            Reason = TEXT("The row names, order or row storage changed during the copy");
            return false;
        }
        for (TFieldIterator<FProperty> It(RowStruct); It; ++It)
        {
            const FProperty* Property = *It;
            const void* Expected = Property == CopiedProperty && Targets.Contains(Row.Key)
                ? SourceBefore : Original.Data->GetStructMemory();
            if (!SameProperty(Property, Row.Value, Expected))
            {
                Reason = FString::Printf(TEXT("Verification failed for row '%s', property '%s'"),
                    *Row.Key.ToString(), *Property->GetName());
                return false;
            }
        }
    }
    return true;
}

/** Restore native values without invoking row fixups or change callbacks mid-restore. */
bool Restore(UDataTable* Table, UScriptStruct* RowStruct, const TArray<FRowSnapshot>& Before)
{
    // A third-party listener replacing the schema can also change the type of row
    // allocations. Do not destroy unknown memory using a guessed struct type.
    if (Table->GetRowStruct() != RowStruct) return false;
    bool bSameRows = Table->GetRowMap().Num() == Before.Num();
    int32 Index = 0;
    if (bSameRows)
    {
        for (const auto& Row : Table->GetRowMap())
        {
            if (Row.Key != Before[Index++].Name || !Row.Value) { bSameRows = false; break; }
        }
    }
    if (bSameRows)
    {
        for (const FRowSnapshot& Row : Before)
            RowStruct->CopyScriptStruct(Table->FindRowUnchecked(Row.Name), Row.Data->GetStructMemory());
    }
    else
    {
        // Public AddRow/EmptyTable broadcast callbacks. Restoring through the public
        // const view is deliberate: rollback must not repeatedly invoke a listener
        // that caused verification to fail in the first place.
        UScriptStruct* CurrentStruct = Table->RowStruct;
        if (!CurrentStruct && !Table->GetRowMap().IsEmpty()) return false;
        auto& Rows = const_cast<TMap<FName, uint8*>&>(Table->GetRowMap());
        for (const auto& Row : Rows)
        {
            if (Row.Value)
            {
                CurrentStruct->DestroyStruct(Row.Value);
                FMemory::Free(Row.Value);
            }
        }
        Rows.Empty(Before.Num());
        Table->RowStruct = RowStruct;
        for (const FRowSnapshot& Row : Before)
        {
            uint8* Data = static_cast<uint8*>(FMemory::Malloc(RowStruct->GetStructureSize(), RowStruct->GetMinAlignment()));
            RowStruct->InitializeStruct(Data);
            RowStruct->CopyScriptStruct(Data, Row.Data->GetStructMemory());
            Rows.Add(Row.Name, Data);
        }
    }
    FString Reason;
    return Verify(Table, RowStruct, Before, {}, nullptr, nullptr, Reason);
}

bool ValidName(const FString& Value, int32 MaxLength)
{
    return !Value.IsEmpty() && Value.Len() <= MaxLength && Value.Len() < NAME_SIZE
        && !Value.TrimStartAndEnd().IsEmpty() && !Value.Equals(TEXT("None"), ESearchCase::IgnoreCase);
}
}

TSharedPtr<FJsonObject> FDSHDataTableOps::CopyProperty(const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails)
{
    ErrorCode.Reset();
    ErrorMessage.Reset();
    ErrorDetails = MakeShared<FJsonObject>();
    ErrorDetails->SetStringField(TEXT("rollback"), TEXT("not_needed"));
    ErrorDetails->SetBoolField(TEXT("retryable"), false);
    auto Fail = [&](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject>
    {
        ErrorCode = Code;
        ErrorMessage = Message;
        return nullptr;
    };
    if (!IsInGameThread()) return Fail(TEXT("INVALID_THREAD"), TEXT("DataTable copies must run on the editor game thread"));
    if (!Params.IsValid()) return Fail(TEXT("INVALID_REQUEST"), TEXT("Copy arguments must be an object"));
    static const TSet<FString> Allowed = {TEXT("assetPath"), TEXT("sourceRow"), TEXT("propertyName"), TEXT("targetRows")};
    for (const auto& Pair : Params->Values)
    {
        const FString Key(*Pair.Key);
        if (!Allowed.Contains(Key)) return Fail(TEXT("INVALID_REQUEST"), TEXT("Unknown DataTable copy argument: ") + Key);
    }

    FString AssetPath, SourceText, PropertyName;
    if (!Params->TryGetStringField(TEXT("assetPath"), AssetPath) || AssetPath.IsEmpty() || AssetPath.Len() > 1024
        || !Params->TryGetStringField(TEXT("sourceRow"), SourceText) || !ValidName(SourceText, 1024)
        || !Params->TryGetStringField(TEXT("propertyName"), PropertyName) || !ValidName(PropertyName, 160))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("assetPath, sourceRow and the exact propertyName are required"));
    for (int32 Index = 0; Index < PropertyName.Len(); ++Index)
    {
        const TCHAR Ch = PropertyName[Index];
        const bool bAsciiLetter = (Ch >= TEXT('A') && Ch <= TEXT('Z')) || (Ch >= TEXT('a') && Ch <= TEXT('z'));
        if (!(bAsciiLetter || Ch == TEXT('_') || (Index > 0 && Ch >= TEXT('0') && Ch <= TEXT('9'))))
            return Fail(TEXT("INVALID_REQUEST"), TEXT("propertyName must be an exact reflected property identifier"));
    }
    const FString PackageName = FPackageName::ObjectPathToPackageName(AssetPath);
    if (!FPackageName::IsValidLongPackageName(PackageName) || AssetPath.Contains(TEXT(":")))
        return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("assetPath must identify a DataTable asset package or object"));
    const FString ObjectPath = PackageName + TEXT(".") + FPackageName::GetShortName(PackageName);
    if (AssetPath != PackageName && AssetPath != ObjectPath)
        return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("assetPath must identify the top-level DataTable asset"));

    TStrongObjectPtr<UDataTable> Table(Cast<UDataTable>(LoadObject<UObject>(nullptr, *ObjectPath)));
    if (!Table.IsValid()) return Fail(TEXT("NOT_DATA_TABLE"), TEXT("The requested asset is not a loadable DataTable"));
    // Composite/mirror/custom tables can override their row storage or derive it
    // from other assets. This operation only owns an ordinary table's own rows.
    if (Table->GetClass() != UDataTable::StaticClass())
        return Fail(TEXT("UNSUPPORTED_DATA_TABLE_TYPE"), TEXT("Only ordinary DataTable assets support direct field copies"));
    TStrongObjectPtr<UScriptStruct> RowStruct(Table->RowStruct);
    if (!RowStruct.IsValid()) return Fail(TEXT("INVALID_ROW_STRUCT"), TEXT("The DataTable has no valid row struct"));
    if (Table->GetRowMap().Num() > MaxSnapshotRows
        || static_cast<int64>(RowStruct->GetStructureSize()) * Table->GetRowMap().Num() > MaxSnapshotBytes)
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The DataTable exceeds the native snapshot limit; no rows were changed"));

    FProperty* Property = nullptr;
    for (TFieldIterator<FProperty> It(RowStruct.Get()); It; ++It)
        if (It->GetName().Equals(PropertyName, ESearchCase::CaseSensitive)) { Property = *It; break; }
    if (!Property || Property->HasAnyPropertyFlags(CPF_Deprecated))
        return Fail(TEXT("PROPERTY_NOT_FOUND"), TEXT("propertyName must exactly match a non-deprecated top-level row property"));
    const FName SourceName(*SourceText, FNAME_Find);
    if (SourceName.IsNone() || !Table->FindRowUnchecked(SourceName))
        return Fail(TEXT("ROW_NOT_FOUND"), TEXT("The source row does not exist"));

    TSet<FName> Targets;
    if (Params->HasField(TEXT("targetRows")))
    {
        const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
        if (!Params->TryGetArrayField(TEXT("targetRows"), Values) || Values->IsEmpty() || Values->Num() > MaxTargets)
            return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("targetRows must contain between 1 and 4096 row names"));
        for (const auto& Value : *Values)
        {
            FString Text;
            if (!Value.IsValid() || !Value->TryGetString(Text) || !ValidName(Text, 1024))
                return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("Every target row must be a nonempty row-name string"));
            const FName Name(*Text, FNAME_Find);
            if (Name == SourceName) return Fail(TEXT("SOURCE_IS_TARGET"), TEXT("The source row cannot be a target"));
            if (Name.IsNone() || !Table->FindRowUnchecked(Name)) return Fail(TEXT("ROW_NOT_FOUND"), TEXT("A target row does not exist: ") + Text);
            if (Targets.Contains(Name)) return Fail(TEXT("DUPLICATE_TARGET_ROW"), TEXT("Target rows must be unique"));
            Targets.Add(Name);
        }
    }
    else
    {
        for (const auto& Row : Table->GetRowMap())
            if (Row.Key != SourceName) Targets.Add(Row.Key);
        if (Targets.IsEmpty() || Targets.Num() > MaxTargets)
            return Fail(TEXT("INVALID_TARGET_ROWS"), TEXT("The default target set must contain between 1 and 4096 other rows"));
    }
    if (GEditor && GEditor->IsTransactionActive())
        return Fail(TEXT("EDITOR_BUSY"), TEXT("Finish the active editor transaction before copying DataTable values"));

    FSnapshotBudget Budget;
    if (!Budget.Add(static_cast<int64>(RowStruct->GetStructureSize()) * Table->GetRowMap().Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The DataTable exceeds the 64 MiB reflected snapshot budget"));
    for (const auto& Row : Table->GetRowMap())
    {
        if (!Row.Value) return Fail(TEXT("INVALID_ROW_DATA"), TEXT("A DataTable row has no row storage"));
        if (!Budget.Struct(RowStruct.Get(), Row.Value))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The DataTable exceeds the native snapshot payload, depth or entry limit"));
    }
    FSnapshotBudget SourceBudget;
    for (int32 Index = 0; Index < Property->ArrayDim; ++Index)
        if (!SourceBudget.Value(Property, Property->ContainerPtrToValuePtr<void>(Table->FindRowUnchecked(SourceName), Index), 0))
            return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The source property exceeds the native payload limit"));
    if (!Budget.Add(SourceBudget.Bytes * Targets.Num()))
        return Fail(TEXT("SNAPSHOT_LIMIT"), TEXT("The planned target copies exceed the 64 MiB native payload budget"));

    // Snapshot all rows, not just targets, so read-back can prove that source and
    // every unrelated property survived. Copies include containers and references.
    TArray<FRowSnapshot> Before;
    FSnapshotReferences SnapshotReferences(Before);
    Before.Reserve(Table->GetRowMap().Num());
    const void* SourceBefore = nullptr;
    for (const auto& Row : Table->GetRowMap())
    {
        if (!Row.Value) return Fail(TEXT("INVALID_ROW_DATA"), TEXT("A DataTable row has no row storage"));
        FRowSnapshot& Snapshot = Before.AddDefaulted_GetRef();
        Snapshot.Name = Row.Key;
        Snapshot.Data = MakeUnique<FStructOnScope>(RowStruct.Get());
        RowStruct->CopyScriptStruct(Snapshot.Data->GetStructMemory(), Row.Value);
        if (Row.Key == SourceName) SourceBefore = Snapshot.Data->GetStructMemory();
    }
    FString VerificationError;
    if (!Verify(Table.Get(), RowStruct.Get(), Before, {}, nullptr, nullptr, VerificationError))
        return Fail(TEXT("SNAPSHOT_VALIDATION_FAILED"), VerificationError + TEXT("; no rows were changed"));
    int32 ChangedRows = 0;
    for (const FName Target : Targets)
        if (!SameProperty(Property, Table->FindRowUnchecked(Target), SourceBefore)) ++ChangedRows;
    UPackage* Package = Table->GetOutermost();
    const bool bDirtyBefore = Package->IsDirty();
    auto Success = [&]()
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Table->GetPathName());
        Result->SetStringField(TEXT("sourceRow"), SourceName.ToString());
        Result->SetStringField(TEXT("propertyName"), PropertyName);
        Result->SetNumberField(TEXT("targetCount"), Targets.Num());
        Result->SetNumberField(TEXT("changedRows"), ChangedRows);
        Result->SetNumberField(TEXT("unchangedRows"), Targets.Num() - ChangedRows);
        Result->SetBoolField(TEXT("verified"), true);
        Result->SetBoolField(TEXT("saved"), false);
        Result->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore);
        Result->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Result;
    };
    if (!ChangedRows) return Success();

    FScopedTransaction Transaction(NSLOCTEXT("DSHUnrealBridge", "CopyDataTableProperty", "Copy DataTable row property"));
    const bool bWasTransactional = Table->HasAnyFlags(RF_Transactional);
    Table->SetFlags(RF_Transactional);
    Table->Modify();
    auto Rollback = [&]() -> TSharedPtr<FJsonObject>
    {
        bool bRestored = Restore(Table.Get(), RowStruct.Get(), Before);
        if (bRestored)
        {
            FDataTableEditorUtils::BroadcastPostChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
            // A listener may be the reason validation failed. Restore once more
            // after notifying it, with no further callbacks or retry loop.
            bRestored = Restore(Table.Get(), RowStruct.Get(), Before);
        }
        Transaction.Cancel();
        if (!bWasTransactional) Table->ClearFlags(RF_Transactional);
        if (bRestored) Package->SetDirtyFlag(bDirtyBefore);
        ErrorDetails->SetStringField(TEXT("rollback"), bRestored ? TEXT("restored") : TEXT("failed"));
        ErrorDetails->SetBoolField(TEXT("dirtyBefore"), bDirtyBefore);
        ErrorDetails->SetBoolField(TEXT("dirtyAfter"), Package->IsDirty());
        return Fail(bRestored ? TEXT("DATA_TABLE_VERIFICATION_FAILED") : TEXT("DATA_TABLE_ROLLBACK_FAILED"),
            VerificationError + (bRestored ? TEXT("; all original rows were restored and the transaction was cancelled")
                : TEXT("; rollback could not be verified, inspect the asset before making another edit")));
    };
    FDataTableEditorUtils::BroadcastPreChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
    if (!Verify(Table.Get(), RowStruct.Get(), Before, {}, nullptr, nullptr, VerificationError)) return Rollback();
    for (const FName Target : Targets)
        Property->CopyCompleteValue_InContainer(Table->FindRowUnchecked(Target), SourceBefore);
    FDataTableEditorUtils::BroadcastPostChange(Table.Get(), FDataTableEditorUtils::EDataTableChangeInfo::RowData);
    if (!Verify(Table.Get(), RowStruct.Get(), Before, Targets, Property, SourceBefore, VerificationError)) return Rollback();
    return Success();
}
