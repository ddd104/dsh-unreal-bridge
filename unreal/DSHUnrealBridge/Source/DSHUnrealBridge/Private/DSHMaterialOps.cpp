#include "DSHMaterialOps.h"
#include "DSHAssetPresentation.h"

#include "Editor.h"
#include "MaterialEditingLibrary.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "Materials/MaterialExpressionComment.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionCustomOutput.h"
#include "Materials/MaterialExpressionFunctionInput.h"
#include "Materials/MaterialExpressionFunctionOutput.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialFunction.h"
#include "Misc/PackageName.h"
#include "Misc/SecureHash.h"
#include "ScopedTransaction.h"
#include "RHI.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "UObject/GCObject.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UObjectIterator.h"
#include "UObject/UnrealType.h"

namespace
{
// Unity builds combine source files into one translation unit, including their
// anonymous namespaces. Keep all material implementation names in their own scope.
namespace DSHMaterialOpsPrivate
{
constexpr int32 MaxNodes = 2048, MaxOperations = 256, MaxArray = 512;
constexpr int64 MaxSnapshotBytes = 64 * 1024 * 1024;
TSharedPtr<FJsonObject> Obj() { return MakeShared<FJsonObject>(); }
TSharedPtr<FJsonValue> J(const TSharedPtr<FJsonObject>& Value) { return MakeShared<FJsonValueObject>(Value); }
FString Str(const TSharedPtr<FJsonObject>& Value, const TCHAR* Key)
{
    FString Result;
    if (Value) Value->TryGetStringField(Key, Result);
    return Result;
}
bool Keys(const TSharedPtr<FJsonObject>& Value, std::initializer_list<const TCHAR*> Allowed, FString& Error)
{
    if (!Value) { Error = TEXT("Expected an object"); return false; }
    for (const auto& Pair : Value->Values)
    {
        bool bFound = false;
        for (const TCHAR* Key : Allowed) if (Pair.Key == Key) { bFound = true; break; }
        if (!bFound) { Error = TEXT("Unknown field: ") + FString(Pair.Key); return false; }
    }
    return true;
}
bool Path(const FString& Value)
{
    const FString Package = FPackageName::ObjectPathToPackageName(Value);
    const FName Mount = FPackageName::GetPackageMountPoint(Package);
    return !Mount.IsNone() && Mount != TEXT("Script") && Mount != TEXT("Memory") && Mount != TEXT("Temp")
        && FPackageName::IsValidLongPackageName(Package) && !Package.Contains(TEXT(".."))
        && !Value.Contains(TEXT(":")) && (Value == Package || FPackageName::IsValidObjectPath(Value));
}
FMaterialExpressionCollection& Collection(UObject* Asset)
{
    if (UMaterial* Material = Cast<UMaterial>(Asset)) return Material->GetExpressionCollection();
    return CastChecked<UMaterialFunction>(Asset)->GetExpressionCollection();
}
UObject* EditorData(UObject* Asset)
{
    if (UMaterial* Material = Cast<UMaterial>(Asset)) return Material->GetEditorOnlyData();
    return CastChecked<UMaterialFunction>(Asset)->GetEditorOnlyData();
}
TArray<UMaterialExpression*> Expressions(UObject* Asset)
{
    TArray<UMaterialExpression*> Result;
    for (UMaterialExpression* Node : Collection(Asset).Expressions) if (Node) Result.AddUnique(Node);
    for (UMaterialExpressionComment* Node : Collection(Asset).EditorComments) if (Node) Result.AddUnique(Node);
    return Result;
}
FString NodeId(UMaterialExpression* Node) { return Node->MaterialExpressionGuid.ToString(EGuidFormats::DigitsWithHyphens); }
bool Supported(UObject* Asset, FString& Error)
{
    if (!Asset || (Asset->GetClass() != UMaterial::StaticClass() && Asset->GetClass() != UMaterialFunction::StaticClass()))
    {
        Error = TEXT("Supported targets are existing UMaterial and ordinary UMaterialFunction assets; instances and function layer/blend subclasses are not supported");
        return false;
    }
    if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
        if (Function->GetMaterialFunctionUsage() != EMaterialFunctionUsage::Default)
        { Error = TEXT("Material layer/blend function graphs require a caller context and are not supported"); return false; }
    if (Collection(Asset).ExpressionExecBegin || Collection(Asset).ExpressionExecEnd)
    { Error = TEXT("Material execution-wire graphs are not supported"); return false; }
    const auto Nodes = Expressions(Asset);
    if (Nodes.Num() > MaxNodes) { Error = TEXT("The material exceeds the 2048-expression batch limit"); return false; }
    TSet<FGuid> Ids;
    for (UMaterialExpression* Node : Nodes)
    {
        if (Node->GetOuter() != Asset || Node->SubgraphExpression || Node->GetClass()->GetName().Contains(TEXT("Composite")))
        { Error = TEXT("Nested/composite material graphs are not supported by this batch version"); return false; }
        if (!Node->MaterialExpressionGuid.IsValid() || Ids.Contains(Node->MaterialExpressionGuid))
        { Error = TEXT("Existing expression GUIDs must be valid and unique; repair the graph before using a batch"); return false; }
        Ids.Add(Node->MaterialExpressionGuid);
    }
    return true;
}

bool Editable(FProperty* Property)
{
    if (!Property || Property->HasAnyPropertyFlags(CPF_Transient | CPF_Deprecated | CPF_EditConst)) return false;
    const FName Name = Property->GetFName();
    // These presentation properties intentionally lack CPF_Edit in the engine.
    return Property->HasAnyPropertyFlags(CPF_Edit)
        || Name == TEXT("MaterialExpressionEditorX") || Name == TEXT("MaterialExpressionEditorY")
        || Name == TEXT("SizeX") || Name == TEXT("SizeY");
}

TSharedPtr<FJsonValue> ExportValue(FProperty* Property, const void* Value, int32 Depth = 0)
{
    if (Depth > 12) return MakeShared<FJsonValueNull>();
    if (const FBoolProperty* Bool = CastField<FBoolProperty>(Property)) return MakeShared<FJsonValueBoolean>(Bool->GetPropertyValue(Value));
    if (const FEnumProperty* Enum = CastField<FEnumProperty>(Property))
        return MakeShared<FJsonValueString>(Enum->GetEnum()->GetNameStringByValue(Enum->GetUnderlyingProperty()->GetSignedIntPropertyValue(Value)));
    if (const FByteProperty* Byte = CastField<FByteProperty>(Property))
        if (Byte->Enum) return MakeShared<FJsonValueString>(Byte->Enum->GetNameStringByValue(Byte->GetPropertyValue(Value)));
    if (const FNumericProperty* Number = CastField<FNumericProperty>(Property))
    {
        double Numeric = Number->IsInteger() ? static_cast<double>(Number->GetSignedIntPropertyValue(Value)) : Number->GetFloatingPointPropertyValue(Value);
        if (!FMath::IsFinite(Numeric))
        {
            auto Unsupported = Obj(); Unsupported->SetStringField(TEXT("unsupportedValue"), TEXT("non-finite number"));
            return J(Unsupported);
        }
        if (Numeric == 0.0) Numeric = 0.0; // Normalize negative zero for strict host JSON.
        return MakeShared<FJsonValueNumber>(Numeric);
    }
    if (const FStrProperty* Text = CastField<FStrProperty>(Property)) return MakeShared<FJsonValueString>(Text->GetPropertyValue(Value));
    if (const FNameProperty* Name = CastField<FNameProperty>(Property)) return MakeShared<FJsonValueString>(Name->GetPropertyValue(Value).ToString());
    if (const FTextProperty* Text = CastField<FTextProperty>(Property)) return MakeShared<FJsonValueString>(Text->GetPropertyValue(Value).ToString());
    if (const FSoftObjectProperty* Soft = CastField<FSoftObjectProperty>(Property))
        return MakeShared<FJsonValueString>(Soft->GetPropertyValue(Value).ToSoftObjectPath().ToString());
    if (const FObjectPropertyBase* Reference = CastField<FObjectPropertyBase>(Property))
    {
        UObject* Object = Reference->GetObjectPropertyValue(Value);
        if (Object) return MakeShared<FJsonValueString>(Object->GetPathName());
        return MakeShared<FJsonValueNull>();
    }
    if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
    {
        auto Result = Obj();
        for (TFieldIterator<FProperty> It(Struct->Struct); It; ++It)
            if (Editable(*It) && It->ArrayDim == 1)
                Result->SetField(It->GetName(), ExportValue(*It, It->ContainerPtrToValuePtr<void>(Value), Depth + 1));
        return J(Result);
    }
    if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
    {
        TArray<TSharedPtr<FJsonValue>> Result;
        FScriptArrayHelper Helper(Array, Value);
        if (Helper.Num() > MaxArray) return MakeShared<FJsonValueNull>();
        for (int32 Index = 0; Index < Helper.Num(); ++Index) Result.Add(ExportValue(Array->Inner, Helper.GetRawPtr(Index), Depth + 1));
        return MakeShared<FJsonValueArray>(Result);
    }
    return MakeShared<FJsonValueNull>();
}

bool ImportValue(FProperty* Property, void* Value, const TSharedPtr<FJsonValue>& Json, FString& Error, int32 Depth = 0)
{
    if (!Json || Depth > 12 || Property->ArrayDim != 1) { Error = TEXT("Unsupported or excessive property nesting"); return false; }
    if (FBoolProperty* Bool = CastField<FBoolProperty>(Property))
    {
        bool In = false;
        if (!Json->TryGetBool(In)) { Error = TEXT("Expected a boolean"); return false; }
        Bool->SetPropertyValue(Value, In); return true;
    }
    UEnum* EnumType = nullptr;
    FNumericProperty* EnumNumber = nullptr;
    if (FEnumProperty* Enum = CastField<FEnumProperty>(Property)) { EnumType = Enum->GetEnum(); EnumNumber = Enum->GetUnderlyingProperty(); }
    else if (FByteProperty* Byte = CastField<FByteProperty>(Property)) if (Byte->Enum) { EnumType = Byte->Enum; EnumNumber = Byte; }
    if (EnumType)
    {
        FString In;
        if (!Json->TryGetString(In)) { Error = TEXT("Expected an exact enum name"); return false; }
        const int64 Number = EnumType->GetValueByNameString(In);
        if (Number == INDEX_NONE || !EnumType->IsValidEnumValue(Number)) { Error = TEXT("Unknown enum value: ") + In; return false; }
        EnumNumber->SetIntPropertyValue(Value, Number); return true;
    }
    if (FNumericProperty* Number = CastField<FNumericProperty>(Property))
    {
        double In = 0;
        if (!Json->TryGetNumber(In) || !FMath::IsFinite(In)) { Error = TEXT("Expected a finite number"); return false; }
        if (Number->IsInteger())
        {
            if (FMath::FloorToDouble(In) != In || FMath::Abs(In) > 9007199254740991.0)
            { Error = TEXT("Expected an exactly representable integer"); return false; }
            const int32 Bits = Property->ElementSize * 8;
            const bool bUnsigned = Property->IsA<FByteProperty>() || Property->IsA<FUInt16Property>() || Property->IsA<FUInt32Property>() || Property->IsA<FUInt64Property>();
            const double Limit = FMath::Pow(2.0, bUnsigned ? Bits : Bits - 1);
            if (In < (bUnsigned ? 0.0 : -Limit) || In >= Limit) { Error = TEXT("Integer property value is out of range"); return false; }
            Number->SetIntPropertyValue(Value, static_cast<int64>(In));
        }
        else
        {
            if (Property->IsA<FFloatProperty>() && FMath::Abs(In) > MAX_flt) { Error = TEXT("Float property value is out of range"); return false; }
            Number->SetFloatingPointPropertyValue(Value, In);
        }
        return true;
    }
    if (Property->IsA<FStrProperty>() || Property->IsA<FNameProperty>() || Property->IsA<FTextProperty>())
    {
        FString In;
        if (!Json->TryGetString(In) || In.Len() > 32768) { Error = TEXT("Expected a string of at most 32768 characters"); return false; }
        if (FStrProperty* Text = CastField<FStrProperty>(Property)) Text->SetPropertyValue(Value, In);
        else if (FNameProperty* Name = CastField<FNameProperty>(Property))
        {
            if (In.Len() >= NAME_SIZE) { Error = TEXT("Name is too long"); return false; }
            Name->SetPropertyValue(Value, FName(*In));
        }
        else CastFieldChecked<FTextProperty>(Property)->SetPropertyValue(Value, FText::FromString(In));
        return true;
    }
    if (FObjectPropertyBase* Reference = CastField<FObjectPropertyBase>(Property))
    {
        if (Json->IsNull()) { Reference->SetObjectPropertyValue(Value, nullptr); return true; }
        FString In;
        if (!Json->TryGetString(In) || !FPackageName::IsValidObjectPath(In) || In.Contains(TEXT(":")))
        { Error = TEXT("Object properties require a full existing asset object path or null"); return false; }
        UObject* Object = LoadObject<UObject>(nullptr, *In);
        if (!Object || !Object->IsAsset() || !Object->IsA(Reference->PropertyClass))
        { Error = TEXT("Object reference has the wrong type or is not an existing asset: ") + In; return false; }
        Reference->SetObjectPropertyValue(Value, Object); return true;
    }
    if (FStructProperty* Struct = CastField<FStructProperty>(Property))
    {
        const TSharedPtr<FJsonObject>* Fields = nullptr;
        if (!Json->TryGetObject(Fields) || !Fields || !Fields->IsValid()) { Error = TEXT("Expected a struct object"); return false; }
        for (const auto& Pair : (*Fields)->Values)
        {
            FProperty* Field = FindFProperty<FProperty>(Struct->Struct, FName(*FString(Pair.Key)));
            if (!Editable(Field)) { Error = TEXT("Unknown or non-editable struct field: ") + FString(Pair.Key); return false; }
            if (!ImportValue(Field, Field->ContainerPtrToValuePtr<void>(Value), Pair.Value, Error, Depth + 1)) return false;
        }
        return true;
    }
    if (FArrayProperty* Array = CastField<FArrayProperty>(Property))
    {
        const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
        if (!Json->TryGetArray(Items) || !Items || Items->Num() > MaxArray) { Error = TEXT("Expected an array with at most 512 items"); return false; }
        FScriptArrayHelper Helper(Array, Value);
        // Arrays use positional update semantics. Preserve existing non-editable
        // nested connection storage (notably Custom.Inputs[i].Input) at retained
        // indices; initialize only newly appended elements.
        Helper.Resize(Items->Num());
        for (int32 Index = 0; Index < Items->Num(); ++Index)
            if (!ImportValue(Array->Inner, Helper.GetRawPtr(Index), (*Items)[Index], Error, Depth + 1)) return false;
        return true;
    }
    Error = TEXT("This property type is not supported by material batches: ") + Property->GetCPPType();
    return false;
}

TSharedPtr<FJsonObject> Properties(UObject* Object)
{
    auto Result = Obj();
    for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
        if (Editable(*It) && It->ArrayDim == 1)
            Result->SetField(It->GetName(), ExportValue(*It, It->ContainerPtrToValuePtr<void>(Object)));
    return Result;
}

bool SetProperties(UObject* Object, const TSharedPtr<FJsonObject>& Values, UObject* OriginalAsset, FString& Error)
{
    if (!Values || Values->Values.Num() > 128) { Error = TEXT("properties must be an object with at most 128 fields"); return false; }
    for (const auto& Pair : Values->Values)
    {
        UObject* Owner = Object;
        FProperty* Property = FindFProperty<FProperty>(Owner->GetClass(), FName(*FString(Pair.Key)));
        if (!Property && (Object->IsA<UMaterial>() || Object->IsA<UMaterialFunction>()))
        {
            Owner = EditorData(Object);
            Property = FindFProperty<FProperty>(Owner->GetClass(), FName(*FString(Pair.Key)));
        }
        if (!Editable(Property)) { Error = TEXT("Unknown or non-editable property: ") + FString(Pair.Key); return false; }
        if (Property->GetFName() == TEXT("AttributeGetTypes") || Property->GetFName() == TEXT("AttributeSetTypes"))
        {
            Error = TEXT("Dynamic Get/SetMaterialAttributes pin-array edits are not supported by this batch version; existing nodes can still be connected using their current pins");
            return false;
        }
        auto* Call = Cast<UMaterialExpressionMaterialFunctionCall>(Object);
        UMaterialFunctionInterface* OldFunction = Call ? Call->MaterialFunction.Get() : nullptr;
        if (!ImportValue(Property, Property->ContainerPtrToValuePtr<void>(Owner), Pair.Value, Error))
        { Error = FString(Pair.Key) + TEXT(": ") + Error; return false; }
        // Refresh dynamically generated pins without publishing a partially edited
        // material through PostEditChange callbacks after each property.
        if (UMaterialExpressionCustom* Custom = Cast<UMaterialExpressionCustom>(Object)) Custom->RebuildOutputs();
        if (Call)
            if (Property->GetFName() == TEXT("MaterialFunction"))
            {
                UMaterialFunctionInterface* NewFunction = Call->MaterialFunction;
                Call->MaterialFunction = OldFunction;
                auto* OriginalFunction = Cast<UMaterialFunction>(OriginalAsset);
                if (NewFunction && OriginalFunction && (NewFunction == OriginalFunction || NewFunction->IsDependent(OriginalFunction)))
                { Error = TEXT("The function reference would cause a circular dependency"); return false; }
                // Precheck against the real target before the engine setter:
                // its circular-dependency path opens a modal error dialog.
                Call->Function = Cast<UMaterialFunction>(Object->GetOuter());
                if (!Call->SetMaterialFunctionEx(OldFunction, NewFunction) && NewFunction)
                { Error = TEXT("Cannot bind this material function"); return false; }
            }
    }
    return true;
}

TSharedPtr<FJsonObject> NodeData(UMaterialExpression* Node, UObject* Asset)
{
    auto Result = Obj();
    Result->SetStringField(TEXT("id"), NodeId(Node));
    Result->SetStringField(TEXT("objectPath"), Node->GetPathName());
    Result->SetStringField(TEXT("classPath"), Node->GetClass()->GetPathName());
    Result->SetStringField(TEXT("ownerPath"), Asset->GetPathName());
    Result->SetObjectField(TEXT("properties"), Properties(Node));
    TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
    const auto InputNames = UMaterialEditingLibrary::GetMaterialExpressionInputNames(Node);
    const auto OutputNames = UMaterialEditingLibrary::GetMaterialExpressionOutputNames(Node);
    const auto InputView = Node->GetInputsView();
    for (int32 Index = 0; Index < InputView.Num(); ++Index)
    {
        auto Pin = Obj(); Pin->SetNumberField(TEXT("index"), Index);
        Pin->SetStringField(TEXT("name"), InputNames.IsValidIndex(Index) ? InputNames[Index] : Node->GetInputName(Index).ToString());
        Pin->SetNumberField(TEXT("valueType"), static_cast<uint32>(Node->GetInputValueType(Index)));
        if (InputView[Index] && InputView[Index]->Expression)
        {
            auto From = Obj(); From->SetStringField(TEXT("id"), NodeId(InputView[Index]->Expression)); From->SetNumberField(TEXT("pin"), InputView[Index]->OutputIndex);
            Pin->SetObjectField(TEXT("from"), From);
        }
        Inputs.Add(J(Pin));
    }
    for (int32 Index = 0; Index < Node->GetOutputs().Num(); ++Index)
    {
        auto Pin = Obj(); Pin->SetNumberField(TEXT("index"), Index);
        Pin->SetStringField(TEXT("name"), OutputNames.IsValidIndex(Index) ? OutputNames[Index] : FString());
        Pin->SetNumberField(TEXT("valueType"), static_cast<uint32>(Node->GetOutputValueType(Index)));
        Outputs.Add(J(Pin));
    }
    Result->SetArrayField(TEXT("inputs"), Inputs); Result->SetArrayField(TEXT("outputs"), Outputs);
    return Result;
}

TSharedPtr<FJsonObject> OutputData(UObject* Asset)
{
    auto Result = Obj();
    if (UMaterial* Material = Cast<UMaterial>(Asset))
        for (int32 Index = 0; Index < MP_MAX; ++Index)
            if (FExpressionInput* Input = Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(Index)))
                if (Input->Expression)
                {
                    auto From = Obj(); From->SetStringField(TEXT("id"), NodeId(Input->Expression)); From->SetNumberField(TEXT("pin"), Input->OutputIndex);
                    Result->SetObjectField(StaticEnum<EMaterialProperty>()->GetNameStringByValue(Index), From);
                }
    return Result;
}

/** Lossless revision serialization is separate from the bounded display JSON.
 *  Walk all persistent nested fields, including connection storage, maps/sets
 *  and unresolved soft references; only actual UObject references are replaced
 *  with stable graph identities, never matching text inside authored strings. */
bool CanonicalValue(FProperty* Property, const void* Value, UObject* Asset,
    const TMap<UMaterialExpression*, FString>& StableIds, FString& Out, int64& Budget, int32 Depth = 0,
    TSet<UObject*>* SeenObjects = nullptr)
{
    TSet<UObject*> LocalSeen;
    if (!SeenObjects) SeenObjects = &LocalSeen;
    if (Depth > 32 || Budget <= 0) return false;
    auto Append = [&](const FString& Text)
    {
        Budget -= static_cast<int64>(Text.Len()) * sizeof(TCHAR) + 16;
        if (Budget < 0) return false;
        Out += FString::FromInt(Text.Len()) + TEXT(":") + Text;
        return true;
    };
    if (CastField<FSoftObjectProperty>(Property))
    {
        FString Text; Property->ExportTextItem_Direct(Text, Value, nullptr, Asset, PPF_None);
        return Append(TEXT("soft:") + Text);
    }
    if (const FObjectPropertyBase* Reference = CastField<FObjectPropertyBase>(Property))
    {
        UObject* Target = Reference->GetObjectPropertyValue(Value);
        if (Target == Asset) return Append(TEXT("owner"));
        if (UMaterialExpression* Node = Cast<UMaterialExpression>(Target))
        {
            if (Node->GetOuter() == Asset)
            {
                const FString* Stable = StableIds.Find(Node);
                return Append(TEXT("node:") + (Stable ? *Stable : NodeId(Node)));
            }
        }
        if (Target && Target->IsIn(Asset))
        {
            if (!Append(TEXT("owned:") + Target->GetClass()->GetPathName() + TEXT(":") + Target->GetPathName(Asset))) return false;
            if (SeenObjects->Contains(Target)) return true;
            SeenObjects->Add(Target);
            for (TFieldIterator<FProperty> It(Target->GetClass()); It; ++It)
            {
                if (It->HasAnyPropertyFlags(CPF_Transient | CPF_DuplicateTransient | CPF_NonPIEDuplicateTransient)) continue;
                if (!Append(It->GetName())) return false;
                for (int32 Index = 0; Index < It->ArrayDim; ++Index)
                    if (!CanonicalValue(*It, It->ContainerPtrToValuePtr<void>(Target, Index), Asset, StableIds, Out, Budget, Depth + 1, SeenObjects)) return false;
            }
            return true;
        }
        return Append(TEXT("object:") + GetPathNameSafe(Target));
    }
    if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
    {
        FScriptArrayHelper Helper(Array, Value);
        if (!Append(TEXT("array:") + FString::FromInt(Helper.Num()))) return false;
        for (int32 Index = 0; Index < Helper.Num(); ++Index)
            if (!CanonicalValue(Array->Inner, Helper.GetRawPtr(Index), Asset, StableIds, Out, Budget, Depth + 1, SeenObjects)) return false;
        return true;
    }
    if (const FSetProperty* Set = CastField<FSetProperty>(Property))
    {
        FScriptSetHelper Helper(Set, Value);
        TArray<FString> Items;
        for (FScriptSetHelper::FIterator It(Helper); It; ++It)
        {
            FString Item;
            if (!CanonicalValue(Set->ElementProp, Helper.GetElementPtr(It), Asset, StableIds, Item, Budget, Depth + 1, SeenObjects)) return false;
            Items.Add(MoveTemp(Item));
        }
        Items.Sort();
        if (!Append(TEXT("set:") + FString::FromInt(Items.Num()))) return false;
        for (const FString& Item : Items) Out += Item;
        return true;
    }
    if (const FMapProperty* Map = CastField<FMapProperty>(Property))
    {
        FScriptMapHelper Helper(Map, Value);
        TArray<FString> Items;
        for (FScriptMapHelper::FIterator It(Helper); It; ++It)
        {
            FString Item;
            if (!CanonicalValue(Map->KeyProp, Helper.GetKeyPtr(It), Asset, StableIds, Item, Budget, Depth + 1, SeenObjects)
                || !CanonicalValue(Map->ValueProp, Helper.GetValuePtr(It), Asset, StableIds, Item, Budget, Depth + 1, SeenObjects)) return false;
            Items.Add(MoveTemp(Item));
        }
        Items.Sort();
        if (!Append(TEXT("map:") + FString::FromInt(Items.Num()))) return false;
        for (const FString& Item : Items) Out += Item;
        return true;
    }
    if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
    {
        bool bFields = false;
        for (TFieldIterator<FProperty> It(Struct->Struct); It; ++It)
        {
            if (It->HasAnyPropertyFlags(CPF_Transient | CPF_DuplicateTransient | CPF_NonPIEDuplicateTransient)) continue;
            bFields = true;
            if (!Append(It->GetName())) return false;
            for (int32 Index = 0; Index < It->ArrayDim; ++Index)
                if (!CanonicalValue(*It, It->ContainerPtrToValuePtr<void>(Value, Index), Asset, StableIds, Out, Budget, Depth + 1, SeenObjects)) return false;
        }
        if (bFields) return true;
        // Native structs such as FSoftObjectPath have no reflected member list.
    }
    FString Text; Property->ExportTextItem_Direct(Text, Value, nullptr, Asset, PPF_None);
    return Append(Property->GetCPPType() + TEXT(":") + Text);
}

/** Revision covers authored properties, node identities, topology and positions,
 *  but deliberately excludes shader caches and compiler-generated state IDs. */
FString AuthoredRevision(UObject* Asset, const TMap<FString, UMaterialExpression*>* Aliases = nullptr)
{
    TArray<FString> Lines;
    TMap<UMaterialExpression*, FString> StableIds;
    if (Aliases) for (const auto& Pair : *Aliases) StableIds.Add(Pair.Value, Pair.Key);
    auto Id = [&StableIds](UMaterialExpression* Node)
    {
        if (const FString* Stable = StableIds.Find(Node)) return *Stable;
        return NodeId(Node);
    };
    int64 Budget = MaxSnapshotBytes;
    bool bValid = true;
    auto AppendProperties = [&](UObject* Object, const FString& Prefix)
    {
        for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
            if (Editable(*It))
            {
                FString Text;
                for (int32 Index = 0; Index < It->ArrayDim; ++Index)
                    if (!CanonicalValue(*It, It->ContainerPtrToValuePtr<void>(Object, Index), Asset, StableIds, Text, Budget)) { bValid = false; return; }
                Lines.Add(Prefix + It->GetName() + TEXT("=") + Text);
            }
    };
    AppendProperties(Asset, TEXT("asset/")); AppendProperties(EditorData(Asset), TEXT("editor/"));
    for (UMaterialExpression* Node : Expressions(Asset))
    {
        const FString Prefix = Id(Node) + TEXT("/");
        Lines.Add(Prefix + Node->GetClass()->GetPathName());
        AppendProperties(Node, Prefix);
        int32 Index = 0;
        for (FExpressionInput* Input : Node->GetInputsView())
        {
            FString Link = Input && Input->Expression ? Id(Input->Expression) + TEXT(":") + FString::FromInt(Input->OutputIndex) : TEXT("-");
            if (Input) Link += FString::Printf(TEXT(":%d:%d:%d:%d:%d"), Input->Mask, Input->MaskR, Input->MaskG, Input->MaskB, Input->MaskA);
            Lines.Add(Prefix + FString::FromInt(Index++) + TEXT("->") + Link);
        }
    }
    if (UMaterial* Material = Cast<UMaterial>(Asset))
        for (int32 Index = 0; Index < MP_MAX; ++Index)
            if (FExpressionInput* Input = Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(Index)))
                if (Input->Expression) Lines.Add(TEXT("output/") + FString::FromInt(Index) + TEXT("=") + Id(Input->Expression) + TEXT(":") + FString::FromInt(Input->OutputIndex));
    Lines.Sort();
    if (!bValid) return {};
    const FTCHARToUTF8 Bytes(*FString::Join(Lines, TEXT("\n")));
    return FMD5::HashBytes(reinterpret_cast<const uint8*>(Bytes.Get()), Bytes.Length());
}

class FPropertyCopy
{
public:
    FProperty* Property;
    void* Value;
    explicit FPropertyCopy(FProperty* InProperty, UObject* Object) : Property(InProperty)
    {
        Value = FMemory::Malloc(Property->GetSize(), Property->GetMinAlignment());
        Property->InitializeValue(Value);
        Property->CopyCompleteValue(Value, Property->ContainerPtrToValuePtr<void>(Object));
    }
    ~FPropertyCopy() { Property->DestroyValue(Value); FMemory::Free(Value); }
    FPropertyCopy(const FPropertyCopy&) = delete;
    void Restore(UObject* Object) const { Property->CopyCompleteValue(Property->ContainerPtrToValuePtr<void>(Object), Value); }
    bool Same(UObject* Object) const
    {
        for (int32 Index = 0; Index < Property->ArrayDim; ++Index)
            if (!Property->Identical(Property->ContainerPtrToValuePtr<void>(Object, Index), static_cast<const uint8*>(Value) + Index * Property->ElementSize)) return false;
        return true;
    }
};
struct FObjectCopy
{
    UObject* Object = nullptr;
    TArray<TUniquePtr<FPropertyCopy>> Properties;
};

/** Copies reflected in-memory values, never a disk package. Original objects and
 *  references stay alive; detached expressions are not destroyed during a batch. */
class FSnapshot final : public FGCObject
{
public:
    TArray<FObjectCopy> Objects;
    TArray<TObjectPtr<UObject>> References;
    UObject* Asset;
    bool bDirty;
    FString Revision;
    explicit FSnapshot(UObject* InAsset) : Asset(InAsset), bDirty(InAsset->GetOutermost()->IsDirty()), Revision(AuthoredRevision(InAsset)) {}
    bool Capture(FString& Error)
    {
        TArray<UObject*> Targets = {Asset, EditorData(Asset)};
        for (UMaterialExpression* Node : Expressions(Asset)) Targets.Add(Node);
        int64 Bytes = 0;
        for (int32 TargetIndex = 0; TargetIndex < Targets.Num(); ++TargetIndex)
        {
            UObject* Target = Targets[TargetIndex];
            if (Targets.Num() > 8192) { Error = TEXT("Material snapshot contains too many owned objects"); return false; }
            FObjectCopy& Copy = Objects.AddDefaulted_GetRef(); Copy.Object = Target;
            References.AddUnique(Target);
            TArray<UObject*> FoundReferences;
            FReferenceFinder Finder(FoundReferences, nullptr, false, true, false, false); Finder.FindReferences(Target);
            for (UObject* Reference : FoundReferences) References.AddUnique(Reference);
            TArray<UObject*> PersistentReferences;
            FReferenceFinder PersistentFinder(PersistentReferences, nullptr, false, true, false, true); PersistentFinder.FindReferences(Target);
            for (UObject* Reference : PersistentReferences)
                if (Reference && Reference->IsIn(Asset) && !Reference->HasAnyFlags(RF_Transient)) Targets.AddUnique(Reference);
            for (TFieldIterator<FProperty> It(Target->GetClass()); It; ++It)
            {
                if (It->HasAnyPropertyFlags(CPF_Transient | CPF_DuplicateTransient | CPF_NonPIEDuplicateTransient)) continue;
                // Export bounds variable-length payloads before copying them.
                FString Text; It->ExportText_InContainer(0, Text, Target, nullptr, Target, PPF_None);
                Bytes += It->GetSize() + static_cast<int64>(Text.Len()) * 4;
                if (Bytes > MaxSnapshotBytes) { Error = TEXT("Material snapshot exceeds the 64 MiB safety limit"); return false; }
                Copy.Properties.Add(MakeUnique<FPropertyCopy>(*It, Target));
            }
        }
        return true;
    }
    bool Restore(FString& Error)
    {
        for (const FObjectCopy& Copy : Objects)
        {
            if (!IsValid(Copy.Object)) { Error = TEXT("An original material object was destroyed during the edit"); return false; }
            for (const auto& Property : Copy.Properties) Property->Restore(Copy.Object);
        }
        // Validate all copied persistent properties before recompiling; compiler
        // caches/state identifiers may then legitimately be regenerated.
        for (const FObjectCopy& Copy : Objects)
            for (const auto& Property : Copy.Properties)
                if (!Property->Same(Copy.Object)) { Error = TEXT("Restored property differs: ") + Property->Property->GetName(); return false; }
        Asset->GetOutermost()->SetDirtyFlag(bDirty);
        return AuthoredRevision(Asset) == Revision;
    }
    void AddReferencedObjects(FReferenceCollector& Collector) override { Collector.AddReferencedObjects(References); }
    FString GetReferencerName() const override { return TEXT("DSHMaterialBatchSnapshot"); }
};

UClass* ExpressionClass(const FString& Name, FString& Error)
{
    UClass* Class = FindObject<UClass>(nullptr, *Name);
    if (!Name.StartsWith(TEXT("/Script/")) || !Class || !Class->IsChildOf(UMaterialExpression::StaticClass())
        || Class->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists)
        || Class->GetName().Contains(TEXT("Composite")) || Class->GetName().Contains(TEXT("Exec")))
    { Error = TEXT("Expression class must be a loaded, concrete native MaterialExpression class (nested/execution nodes are unsupported): ") + Name; return nullptr; }
    return Class;
}
UObject* Duplicate(UObject* Asset)
{
    UObject* Copy = StaticDuplicateObject(Asset, GetTransientPackage(), MakeUniqueObjectName(GetTransientPackage(), Asset->GetClass(), TEXT("DSHMaterialPreview")));
    if (Copy)
    {
        Copy->ClearFlags(RF_Public | RF_Standalone); Copy->SetFlags(RF_Transient);
        // Material duplication can regenerate expression IDs. Batch IDs must
        // continue addressing the original expressions in the staged graph.
        const auto Original = Expressions(Asset), Duplicated = Expressions(Copy);
        if (Original.Num() != Duplicated.Num()) return nullptr;
        for (int32 Index = 0; Index < Original.Num(); ++Index) Duplicated[Index]->MaterialExpressionGuid = Original[Index]->MaterialExpressionGuid;
    }
    return Copy;
}

FString FunctionSignature(UMaterialFunction* Function)
{
    TArray<FFunctionExpressionInput> Inputs;
    TArray<FFunctionExpressionOutput> Outputs;
    Function->GetInputsAndOutputs(Inputs, Outputs);
    FString Signature;
    for (const auto& Input : Inputs)
        if (const UMaterialExpressionFunctionInput* Node = Input.ExpressionInput)
            Signature += FString::Printf(TEXT("in/%s/%s/%d/%d\n"), *Node->Id.ToString(), *Node->InputName.ToString(),
                static_cast<int32>(Node->InputType), Node->SortPriority);
    for (const auto& Output : Outputs)
        if (UMaterialExpressionFunctionOutput* Node = Output.ExpressionOutput)
            Signature += FString::Printf(TEXT("out/%s/%s/%d/%u\n"), *Node->Id.ToString(), *Node->OutputName.ToString(),
                Node->SortPriority, static_cast<uint32>(Node->GetOutputValueType(0)));
    return Signature;
}
TArray<FString> LoadedFunctionCallers(UMaterialFunction* Function)
{
    TArray<FString> Paths;
    for (TObjectIterator<UMaterialExpressionMaterialFunctionCall> It; It; ++It)
    {
        UMaterialExpressionMaterialFunctionCall* Call = *It;
        UObject* Owner = Call->GetOuter();
        if (!IsValid(Call) || Call->HasAnyFlags(RF_ClassDefaultObject | RF_ArchetypeObject) || !Owner
            || !Owner->IsAsset() || Owner->HasAnyFlags(RF_Transient) || Owner->GetOutermost() == GetTransientPackage()
            || (!Owner->IsA<UMaterial>() && !Owner->IsA<UMaterialFunction>())) continue;
        if (Call->MaterialFunction && (Call->MaterialFunction == Function || Call->MaterialFunction->IsDependent(Function)))
            Paths.AddUnique(Owner->GetPathName());
    }
    Paths.Sort();
    return Paths;
}

bool CompileMaterial(UMaterial* Material, TArray<FString>& Errors)
{
    if (GUsingNullRHI) { Errors.Add(TEXT("NullRHI cannot verify shader compilation; use an editor with a real rendering interface")); return false; }
    Material->BuildEditorParameterList();
    // Avoid RecompileMaterial's unrelated child-instance parameter renaming and
    // texture-streaming writes. Refresh this graph's shader resources directly.
    {
        FMaterialUpdateContext UpdateContext;
        UpdateContext.AddMaterial(Material);
        Material->StateId = FGuid::NewGuid();
        Material->ForceRecompileForRendering();
    }
    FMaterialResource* Resource = Material->GetMaterialResource(GMaxRHIShaderPlatform);
    if (!Resource) { Errors.Add(TEXT("No material shader resource is available; compilation could not be verified")); return false; }
    Resource->FinishCompilation();
    Errors.Append(Resource->GetCompileErrors());
    if (Errors.IsEmpty() && (!Resource->IsCompilationFinished() || !Resource->GetGameThreadShaderMap()))
        Errors.Add(TEXT("Shader compilation did not produce a completed shader map"));
    return Errors.IsEmpty();
}
bool CompileAsset(UObject* Asset, TArray<FString>& Errors, FString& Scope)
{
    if (UMaterial* Material = Cast<UMaterial>(Asset))
    { Scope = TEXT("current_editor_shader_platform"); return CompileMaterial(Material, Errors); }
    UMaterialFunction* Function = CastChecked<UMaterialFunction>(Asset);
    Scope = TEXT("each_function_output_with_preview_inputs");
    TStrongObjectPtr<UMaterialFunction> FunctionCopy(Cast<UMaterialFunction>(Duplicate(Function)));
    if (!FunctionCopy.IsValid()) { Errors.Add(TEXT("Cannot create a function compilation preview")); return false; }
    int32 OutputCount = 0;
    for (UMaterialExpression* Node : Expressions(FunctionCopy.Get()))
    {
        if (UMaterialExpressionFunctionInput* Input = Cast<UMaterialExpressionFunctionInput>(Node)) Input->bUsePreviewValueAsDefault = true;
        if (Node->IsA<UMaterialExpressionFunctionOutput>()) ++OutputCount;
    }
    if (!OutputCount) { Errors.Add(TEXT("A material function must have at least one FunctionOutput to compile")); return false; }
    for (int32 Index = 0; Index < OutputCount; ++Index)
    {
        TStrongObjectPtr<UMaterial> Preview(NewObject<UMaterial>(GetTransientPackage(), NAME_None, RF_Transient));
        Preview->MaterialDomain = Function->PreviewMaterialDomain;
        Preview->BlendMode = Function->PreviewBlendMode;
        Preview->SetShadingModel(MSM_Unlit);
        auto* Call = Cast<UMaterialExpressionMaterialFunctionCall>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Preview.Get(), nullptr,
            UMaterialExpressionMaterialFunctionCall::StaticClass(), nullptr, 0, 0, false));
        if (!Call || !Call->SetMaterialFunction(FunctionCopy.Get()) || !Call->GetOutputs().IsValidIndex(Index))
        { Errors.Add(TEXT("Cannot bind function outputs to a compilation preview")); return false; }
        const EMaterialValueType Type = Call->GetOutputValueType(Index);
        EMaterialProperty Property = MP_EmissiveColor;
        if (Type == MCT_MaterialAttributes) { Property = MP_MaterialAttributes; Preview->bUseMaterialAttributes = true; }
        else if ((Type & MCT_Float) == 0)
        { Errors.Add(TEXT("Function output requires a specialized caller context; this batch compiler supports numeric and MaterialAttributes output previews")); return false; }
        FExpressionInput* Input = Preview->GetExpressionInputForProperty(Property);
        if (!Input) { Errors.Add(TEXT("The function preview domain has no compatible output")); return false; }
        Input->Connect(Index, Call);
        if (!CompileMaterial(Preview.Get(), Errors)) return false;
    }
    // Refresh the actual function metadata and dependent shader resources, not
    // just its disposable validation material. This engine path does not rename
    // instance parameters or save any asset. Rollback invokes it again after
    // restoring the original function to invalidate dependent cached shaders.
    {
        FMaterialUpdateContext UpdateContext;
        Function->ForceRecompileForRendering(UpdateContext, nullptr);
        for (UMaterialInterface* Dependent : UpdateContext.GetUpdatedMaterials())
        {
            Dependent->ForceRecompileForRendering();
            if (FMaterialResource* Resource = Dependent->GetMaterialResource(GMaxRHIShaderPlatform))
            {
                Resource->FinishCompilation();
                Errors.Append(Resource->GetCompileErrors());
            }
        }
    }
    if (!Errors.IsEmpty()) return false;
    return true;
}

bool ResolvePin(UMaterialExpression* Node, const TSharedPtr<FJsonValue>& Pin, bool bOutput, int32& Index, FString& Error)
{
    if (!Pin) { Error = TEXT("A pin name or index is required"); return false; }
    const int32 Count = bOutput ? Node->GetOutputs().Num() : Node->GetInputsView().Num();
    double Number = 0;
    if (Pin->TryGetNumber(Number))
    {
        if (!FMath::IsFinite(Number) || Number != FMath::FloorToDouble(Number) || Number < 0 || Number >= Count)
        { Error = TEXT("Pin index is out of range for ") + Node->GetClass()->GetName(); return false; }
        Index = static_cast<int32>(Number); return true;
    }
    FString Name;
    if (!Pin->TryGetString(Name)) { Error = TEXT("Pin must be an exact name or integer index"); return false; }
    const auto Names = bOutput ? UMaterialEditingLibrary::GetMaterialExpressionOutputNames(Node) : UMaterialEditingLibrary::GetMaterialExpressionInputNames(Node);
    Index = INDEX_NONE;
    for (int32 Candidate = 0; Candidate < Names.Num(); ++Candidate)
        if (Names[Candidate] == Name)
        {
            if (Index != INDEX_NONE) { Error = TEXT("Pin name is ambiguous; use its index"); return false; }
            Index = Candidate;
        }
    if (Index == INDEX_NONE) { Error = TEXT("Unknown pin '") + Name + TEXT("' on ") + Node->GetClass()->GetName(); return false; }
    return true;
}

bool Acyclic(UObject* Asset, FString& Error)
{
    TMap<UMaterialExpression*, uint8> Colors;
    TSet<UMaterialExpression*> Nodes;
    for (UMaterialExpression* Node : Expressions(Asset)) Nodes.Add(Node);
    TFunction<bool(UMaterialExpression*)> Visit = [&](UMaterialExpression* Node)
    {
        uint8& Color = Colors.FindOrAdd(Node);
        if (Color == 1) { Error = TEXT("Material graph has a connection cycle"); return false; }
        if (Color == 2) return true;
        Color = 1;
        for (FExpressionInput* Input : Node->GetInputsView())
            if (Input && Input->Expression)
            {
                if (!Nodes.Contains(Input->Expression)) { Error = TEXT("An expression connects outside the target material graph"); return false; }
                if (!Input->Expression->GetOutputs().IsValidIndex(Input->OutputIndex)) { Error = TEXT("An existing connection references an invalid output pin"); return false; }
                if (!Visit(Input->Expression)) return false;
            }
        Colors.FindChecked(Node) = 2;
        return true;
    };
    for (UMaterialExpression* Node : Nodes) if (!Visit(Node)) return false;
    return true;
}
void RemoveNode(UObject* Asset, UMaterialExpression* Node)
{
    for (UMaterialExpression* Other : Expressions(Asset))
        for (FExpressionInput* Input : Other->GetInputsView())
            if (Input && Input->Expression == Node) *Input = FExpressionInput();
    if (UMaterial* Material = Cast<UMaterial>(Asset))
        for (int32 Index = 0; Index < MP_MAX; ++Index)
            if (FExpressionInput* Input = Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(Index)))
                if (Input->Expression == Node) *Input = FExpressionInput();
    if (auto* Comment = Cast<UMaterialExpressionComment>(Node)) Collection(Asset).RemoveComment(Comment);
    else Collection(Asset).RemoveExpression(Node);
    // Do not MarkAsGarbage: the snapshot/undo must preserve original identity.
}
TSet<UMaterialExpression*> Reachable(UObject* Asset)
{
    TSet<UMaterialExpression*> Seen;
    TFunction<void(UMaterialExpression*)> Visit = [&](UMaterialExpression* Node)
    {
        if (!Node || Seen.Contains(Node)) return;
        Seen.Add(Node);
        for (FExpressionInput* Input : Node->GetInputsView()) if (Input) Visit(Input->Expression);
    };
    if (UMaterial* Material = Cast<UMaterial>(Asset))
        for (int32 Index = 0; Index < MP_MAX; ++Index)
            if (FExpressionInput* Input = Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(Index))) Visit(Input->Expression);
    for (UMaterialExpression* Node : Expressions(Asset))
        if (Node->IsA<UMaterialExpressionFunctionOutput>() || Node->IsA<UMaterialExpressionFunctionInput>()
            || Node->IsA<UMaterialExpressionCustomOutput>()) Visit(Node);
    return Seen;
}
struct FApplied
{
    TMap<FString, UMaterialExpression*> Ids;
    TSet<FString> AddedAliases;
    TSet<UMaterialExpression*> Changed;
    int32 Added = 0, Deleted = 0, Connected = 0, Properties = 0, Cleaned = 0;
    TArray<FString> Warnings;
};

bool Apply(UObject* Asset, UObject* OriginalAsset, const TSharedPtr<FJsonObject>& Params, FApplied& Applied, FString& Error)
{
    for (UMaterialExpression* Node : Expressions(Asset)) Applied.Ids.Add(NodeId(Node), Node);
    auto Resolve = [&](const FString& Id) -> UMaterialExpression*
    {
        UMaterialExpression** Found = Applied.Ids.Find(Id);
        if (!Found || !*Found || !Expressions(Asset).Contains(*Found)) { Error = TEXT("Unknown or deleted expression ID: ") + Id; return nullptr; }
        return *Found;
    };
    auto Endpoint = [&](const TSharedPtr<FJsonObject>& Operation, const TCHAR* Key, bool bOutput, UMaterialExpression*& Node, int32& Pin) -> bool
    {
        const TSharedPtr<FJsonObject>* End = nullptr;
        if (!Operation->TryGetObjectField(Key, End) || !End || !Keys(*End, {TEXT("id"), TEXT("pin")}, Error)) { if (Error.IsEmpty()) Error = TEXT("Missing endpoint: ") + FString(Key); return false; }
        Node = Resolve(Str(*End, TEXT("id")));
        return Node && ResolvePin(Node, (*End)->TryGetField(TEXT("pin")), bOutput, Pin, Error);
    };
    const TArray<TSharedPtr<FJsonValue>>* Operations = nullptr;
    if (!Params->TryGetArrayField(TEXT("operations"), Operations) || !Operations || Operations->Num() > MaxOperations)
    { Error = TEXT("operations must be an array with at most 256 operations"); return false; }
    for (int32 Index = 0; Index < Operations->Num(); ++Index)
    {
        const TSharedPtr<FJsonObject>* Value = nullptr;
        if (!(*Operations)[Index]->TryGetObject(Value) || !Value || !Value->IsValid()) { Error = TEXT("Each operation must be an object"); return false; }
        const auto Operation = *Value;
        const FString Op = Str(Operation, TEXT("op"));
        auto Failure = [&]() { Error = FString::Printf(TEXT("operations[%d] (%s): %s"), Index, *Op, *Error); return false; };
        if (Op == TEXT("add"))
        {
            if (!Keys(Operation, {TEXT("op"), TEXT("id"), TEXT("expressionClass"), TEXT("properties"), TEXT("position")}, Error)) return Failure();
            const FString Id = Str(Operation, TEXT("id"));
            if (Id.IsEmpty() || Id.Len() > 80 || Applied.Ids.Contains(Id)) { Error = TEXT("add.id must be a unique local alias of at most 80 characters"); return Failure(); }
            UClass* Class = ExpressionClass(Str(Operation, TEXT("expressionClass")), Error);
            if (!Class) return Failure();
            auto* Default = Class->GetDefaultObject<UMaterialExpression>();
            if (!Class->IsChildOf(UMaterialExpressionComment::StaticClass()) && !Default->IsAllowedIn(Asset)) { Error = TEXT("This expression class is not allowed in the target graph"); return Failure(); }
            int32 X = 0, Y = 0;
            const TSharedPtr<FJsonObject>* Position = nullptr;
            if (Operation->HasField(TEXT("position")))
            {
                double DX = 0, DY = 0;
                if (!Operation->TryGetObjectField(TEXT("position"), Position) || !Position || !Keys(*Position, {TEXT("x"), TEXT("y")}, Error)
                    || !(*Position)->TryGetNumberField(TEXT("x"), DX) || !(*Position)->TryGetNumberField(TEXT("y"), DY)
                    || !FMath::IsFinite(DX) || !FMath::IsFinite(DY) || FMath::Abs(DX) > 1000000 || FMath::Abs(DY) > 1000000
                    || FMath::FloorToDouble(DX) != DX || FMath::FloorToDouble(DY) != DY)
                { Error = TEXT("position needs integer x/y within +/- 1000000"); return Failure(); }
                X = static_cast<int32>(DX); Y = static_cast<int32>(DY);
            }
            UMaterialExpression* Node = nullptr;
            if (Class->IsChildOf(UMaterialExpressionComment::StaticClass()))
            {
                auto* Comment = NewObject<UMaterialExpressionComment>(Asset, Class, NAME_None, RF_Transactional);
                Comment->Material = Cast<UMaterial>(Asset); Comment->MaterialExpressionGuid = FGuid::NewGuid();
                Comment->MaterialExpressionEditorX = X; Comment->MaterialExpressionEditorY = Y;
                Comment->SizeX = 400; Comment->SizeY = 240; Collection(Asset).AddComment(Comment); Node = Comment;
            }
            else Node = UMaterialEditingLibrary::CreateMaterialExpressionEx(Cast<UMaterial>(Asset), Cast<UMaterialFunction>(Asset), Class, nullptr, X, Y, false);
            if (!Node) { Error = TEXT("Expression creation failed"); return Failure(); }
            const TSharedPtr<FJsonObject>* Values = nullptr;
            if (Operation->HasField(TEXT("properties")) && (!Operation->TryGetObjectField(TEXT("properties"), Values) || !Values || !SetProperties(Node, *Values, OriginalAsset, Error))) return Failure();
            Applied.Ids.Add(Id, Node); Applied.AddedAliases.Add(Id); Applied.Changed.Add(Node); ++Applied.Added;
        }
        else if (Op == TEXT("set") || Op == TEXT("asset_properties"))
        {
            if (Op == TEXT("set") ? !Keys(Operation, {TEXT("op"), TEXT("id"), TEXT("properties")}, Error) : !Keys(Operation, {TEXT("op"), TEXT("properties")}, Error)) return Failure();
            UObject* Target = Op == TEXT("set") ? Resolve(Str(Operation, TEXT("id"))) : Asset;
            const TSharedPtr<FJsonObject>* Values = nullptr;
            if (!Target || !Operation->TryGetObjectField(TEXT("properties"), Values) || !Values || !SetProperties(Target, *Values, OriginalAsset, Error)) return Failure();
            if (UMaterialExpression* Node = Cast<UMaterialExpression>(Target)) Applied.Changed.Add(Node);
            Applied.Properties += (*Values)->Values.Num();
        }
        else if (Op == TEXT("connect") || Op == TEXT("output"))
        {
            if (Op == TEXT("connect") ? !Keys(Operation, {TEXT("op"), TEXT("from"), TEXT("to")}, Error) : !Keys(Operation, {TEXT("op"), TEXT("from"), TEXT("property")}, Error)) return Failure();
            UMaterialExpression *From = nullptr, *To = nullptr; int32 Output = 0, InputIndex = 0;
            if (!Endpoint(Operation, TEXT("from"), true, From, Output)) return Failure();
            FExpressionInput* Input = nullptr;
            if (Op == TEXT("connect"))
            {
                if (!Endpoint(Operation, TEXT("to"), false, To, InputIndex)) return Failure();
                Input = To->GetInputsView()[InputIndex]; Applied.Changed.Add(To);
            }
            else
            {
                UMaterial* Material = Cast<UMaterial>(Asset);
                const int64 Property = StaticEnum<EMaterialProperty>()->GetValueByNameString(Str(Operation, TEXT("property")));
                if (!Material || Property < 0 || Property >= MP_MAX || !(Input = Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(Property))))
                { Error = TEXT("output requires a valid MP_* material property on a UMaterial target"); return Failure(); }
            }
            if (!Input) { Error = TEXT("Resolved input pin has no storage"); return Failure(); }
            Input->Connect(Output, From); Applied.Changed.Add(From); ++Applied.Connected;
        }
        else if (Op == TEXT("disconnect"))
        {
            if (!Keys(Operation, {TEXT("op"), TEXT("to")}, Error)) return Failure();
            UMaterialExpression* To = nullptr; int32 Pin = 0;
            if (!Endpoint(Operation, TEXT("to"), false, To, Pin)) return Failure();
            FExpressionInput* Input = To->GetInputsView()[Pin];
            if (!Input) { Error = TEXT("Resolved input pin has no storage"); return Failure(); }
            *Input = FExpressionInput(); Applied.Changed.Add(To);
        }
        else if (Op == TEXT("delete"))
        {
            if (!Keys(Operation, {TEXT("op"), TEXT("id")}, Error)) return Failure();
            UMaterialExpression* Node = Resolve(Str(Operation, TEXT("id")));
            if (!Node) return Failure();
            RemoveNode(Asset, Node); Applied.Changed.Remove(Node); ++Applied.Deleted;
        }
        else { Error = TEXT("Unknown material operation: ") + Op; return Failure(); }
        if (Expressions(Asset).Num() > MaxNodes) { Error = TEXT("The batch would exceed 2048 expressions"); return Failure(); }
    }
    if (!Acyclic(Asset, Error)) return false;
    const TArray<TSharedPtr<FJsonValue>>* Cleanup = nullptr;
    if (Params->HasField(TEXT("cleanupNodeIds")))
    {
        if (!Params->TryGetArrayField(TEXT("cleanupNodeIds"), Cleanup) || !Cleanup || Cleanup->Num() > MaxNodes)
        { Error = TEXT("cleanupNodeIds must be a bounded explicit list"); return false; }
        const TSet<UMaterialExpression*> Used = Reachable(Asset);
        for (const auto& Value : *Cleanup)
        {
            FString Id;
            if (!Value->TryGetString(Id)) { Error = TEXT("cleanupNodeIds entries must be expression IDs"); return false; }
            UMaterialExpression* Node = Resolve(Id);
            if (!Node) return false;
            if (Used.Contains(Node) || Node->IsA<UMaterialExpressionComment>())
            { Applied.Warnings.Add(TEXT("Kept cleanup candidate because it is reachable, a function interface, custom output, or comment: ") + Id); continue; }
            RemoveNode(Asset, Node); Applied.Changed.Remove(Node); ++Applied.Cleaned;
        }
    }
    FString Layout = Str(Params, TEXT("layout"));
    if (Layout.IsEmpty()) Layout = TEXT("none");
    if (Layout != TEXT("none") && Layout != TEXT("all")) { Error = TEXT("layout must be 'none' or explicit 'all'"); return false; }
    if (Layout == TEXT("all"))
    {
        if (UMaterial* Material = Cast<UMaterial>(Asset)) UMaterialEditingLibrary::LayoutMaterialExpressions(Material);
        else UMaterialEditingLibrary::LayoutMaterialFunctionExpressions(CastChecked<UMaterialFunction>(Asset));
        Applied.Warnings.Add(TEXT("Explicit all layout may move existing expressions; comment bounds are preserved and should be checked"));
    }
    return true;
}

TSharedPtr<FJsonObject> Read(UObject* Asset, const TSharedPtr<FJsonObject>& Params, FString& Error)
{
    auto Result = Obj();
    Result->SetStringField(TEXT("assetPath"), Asset->GetPathName()); Result->SetStringField(TEXT("assetClass"), Asset->GetClass()->GetPathName());
    Result->SetStringField(TEXT("revision"), AuthoredRevision(Asset)); Result->SetBoolField(TEXT("dirty"), Asset->GetOutermost()->IsDirty());
    Result->SetObjectField(TEXT("properties"), Properties(Asset)); Result->SetObjectField(TEXT("editorProperties"), Properties(EditorData(Asset)));
    Result->SetObjectField(TEXT("materialOutputs"), OutputData(Asset));
    TSet<FString> Filter;
    const TArray<TSharedPtr<FJsonValue>>* Ids = nullptr;
    if (Params->HasField(TEXT("nodeIds")))
    {
        if (!Params->TryGetArrayField(TEXT("nodeIds"), Ids) || !Ids || Ids->Num() > MaxNodes) { Error = TEXT("nodeIds must be a bounded array"); return nullptr; }
        for (const auto& Value : *Ids) { FString Id; if (!Value->TryGetString(Id)) { Error = TEXT("nodeIds entries must be strings"); return nullptr; } Filter.Add(Id); }
    }
    TSet<FString> Missing = Filter;
    TArray<TSharedPtr<FJsonValue>> Nodes;
    for (UMaterialExpression* Node : Expressions(Asset)) if (!Ids || Filter.Contains(NodeId(Node))) { Nodes.Add(J(NodeData(Node, Asset))); Missing.Remove(NodeId(Node)); }
    if (!Missing.IsEmpty()) { Error = TEXT("One or more requested nodeIds do not exist"); return nullptr; }
    Result->SetArrayField(TEXT("nodes"), Nodes);
    Result->SetBoolField(TEXT("nodesComplete"), !Ids);
    const TArray<TSharedPtr<FJsonValue>>* Classes = nullptr;
    if (Params->HasField(TEXT("expressionClasses")))
    {
        if (!Params->TryGetArrayField(TEXT("expressionClasses"), Classes) || !Classes || Classes->Num() > 32) { Error = TEXT("expressionClasses must contain at most 32 class paths"); return nullptr; }
        TArray<TSharedPtr<FJsonValue>> Data;
        for (const auto& Value : *Classes)
        {
            FString Name;
            if (!Value->TryGetString(Name)) { Error = TEXT("expressionClasses entries must be strings"); return nullptr; }
            UClass* Class = ExpressionClass(Name, Error); if (!Class) return nullptr;
            UMaterialExpression* Default = Class->GetDefaultObject<UMaterialExpression>();
            auto Item = Obj(); Item->SetStringField(TEXT("classPath"), Name);
            Item->SetObjectField(TEXT("defaultProperties"), Properties(Default));
            TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
            for (const FString& Pin : UMaterialEditingLibrary::GetMaterialExpressionInputNames(Default)) Inputs.Add(MakeShared<FJsonValueString>(Pin));
            for (const FString& Pin : UMaterialEditingLibrary::GetMaterialExpressionOutputNames(Default)) Outputs.Add(MakeShared<FJsonValueString>(Pin));
            Item->SetArrayField(TEXT("inputs"), Inputs); Item->SetArrayField(TEXT("outputs"), Outputs);
            Item->SetBoolField(TEXT("allowedInTarget"), Class->IsChildOf(UMaterialExpressionComment::StaticClass()) || Default->IsAllowedIn(Asset));
            Data.Add(J(Item));
        }
        Result->SetArrayField(TEXT("expressionClasses"), Data);
    }
    return Result;
}
} // namespace DSHMaterialOpsPrivate
} // namespace

#if WITH_DEV_AUTOMATION_TESTS
TFunction<void(UObject*)> FDSHMaterialOps::TestAfterApply;
#endif

FString FDSHMaterialOps::Revision(UObject* Asset) { return DSHMaterialOpsPrivate::AuthoredRevision(Asset); }

TSharedPtr<FJsonObject> FDSHMaterialOps::Execute(const FString& Method, const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails, FDSHAssetViewHint* ViewHint)
{
    // Function-local declarations keep these helpers out of other unity inputs.
    using DSHMaterialOpsPrivate::Acyclic;
    using DSHMaterialOpsPrivate::Apply;
    using DSHMaterialOpsPrivate::AuthoredRevision;
    using DSHMaterialOpsPrivate::CompileAsset;
    using DSHMaterialOpsPrivate::Duplicate;
    using DSHMaterialOpsPrivate::Expressions;
    using DSHMaterialOpsPrivate::FApplied;
    using DSHMaterialOpsPrivate::FObjectCopy;
    using DSHMaterialOpsPrivate::FSnapshot;
    using DSHMaterialOpsPrivate::FunctionSignature;
    using DSHMaterialOpsPrivate::Keys;
    using DSHMaterialOpsPrivate::LoadedFunctionCallers;
    using DSHMaterialOpsPrivate::NodeId;
    using DSHMaterialOpsPrivate::Obj;
    using DSHMaterialOpsPrivate::Path;
    using DSHMaterialOpsPrivate::Read;
    using DSHMaterialOpsPrivate::Str;
    using DSHMaterialOpsPrivate::Supported;

    ErrorCode.Reset(); ErrorMessage.Reset(); ErrorDetails = Obj();
    if (ViewHint) *ViewHint = FDSHAssetViewHint();
    ErrorDetails->SetStringField(TEXT("execution"), TEXT("not_started")); ErrorDetails->SetStringField(TEXT("rollback"), TEXT("not_needed"));
    ErrorDetails->SetBoolField(TEXT("retryable"), false);
    auto Fail = [&](const TCHAR* Code, const FString& Message) -> TSharedPtr<FJsonObject> { ErrorCode = Code; ErrorMessage = Message; return nullptr; };
    if (!IsInGameThread() || !GEditor) return Fail(TEXT("EDITOR_UNAVAILABLE"), TEXT("Material operations require the editor game thread"));
    const bool bRead = Method == TEXT("material_read");
    if (!bRead && Method != TEXT("material_patch")) return Fail(TEXT("UNSUPPORTED_METHOD"), TEXT("Unsupported material operation"));
    if (bRead ? !Keys(Params, {TEXT("assetPath"), TEXT("nodeIds"), TEXT("expressionClasses")}, ErrorMessage)
        : !Keys(Params, {TEXT("assetPath"), TEXT("baseRevision"), TEXT("dryRun"), TEXT("operations"), TEXT("layout"), TEXT("cleanupNodeIds")}, ErrorMessage))
        return Fail(TEXT("INVALID_REQUEST"), ErrorMessage);
    const FString AssetPath = Str(Params, TEXT("assetPath"));
    if (!Path(AssetPath)) return Fail(TEXT("INVALID_ASSET_PATH"), TEXT("Use an existing asset package or object path in a registered content mount"));
    UObject* Asset = LoadObject<UObject>(nullptr, *AssetPath);
    if (!Asset) return Fail(TEXT("ASSET_NOT_FOUND"), TEXT("Material asset was not found"));
    if (!Supported(Asset, ErrorMessage)) return Fail(TEXT("UNSUPPORTED_MATERIAL"), ErrorMessage);
    if (AuthoredRevision(Asset).IsEmpty()) return Fail(TEXT("MATERIAL_STATE_TOO_LARGE"), TEXT("The complete authored state exceeds the 64 MiB/depth-32 verification limit"));
    if (bRead)
    {
        auto Result = Read(Asset, Params, ErrorMessage);
        return Result ? Result : Fail(TEXT("INVALID_REQUEST"), ErrorMessage);
    }
    bool bDryRun = true;
    if (Params->HasField(TEXT("dryRun")) && !Params->TryGetBoolField(TEXT("dryRun"), bDryRun)) return Fail(TEXT("INVALID_REQUEST"), TEXT("dryRun must be a boolean"));
    const FString Base = Str(Params, TEXT("baseRevision"));
    if (Base.IsEmpty() || Base != AuthoredRevision(Asset)) return Fail(TEXT("CONFLICT"), TEXT("Material changed since it was read; read it again before preparing a batch"));
    if (GEditor->PlayWorld || GEditor->IsTransactionActive()) return Fail(TEXT("BUSY"), TEXT("Stop PIE or finish the active editor transaction first"));
    if (!bDryRun && !FDSHAssetPresentation::PrepareMaterialTransaction(ErrorMessage))
        return Fail(TEXT("EDITOR_UNAVAILABLE"), ErrorMessage);
    if (!bDryRun && !FDSHAssetPresentation::CanEditMaterialAsset(Asset, ErrorMessage))
        return Fail(TEXT("MATERIAL_EDITOR_CONFLICT"), ErrorMessage);
    TStrongObjectPtr<UObject> Stage(Duplicate(Asset));
    if (!Stage.IsValid()) return Fail(TEXT("PREVIEW_FAILED"), TEXT("Cannot duplicate the material graph for staging"));
    FApplied Staged;
    if (!Apply(Stage.Get(), Asset, Params, Staged, ErrorMessage)) return Fail(TEXT("MATERIAL_VALIDATION_FAILED"), ErrorMessage);
    if (AuthoredRevision(Stage.Get(), &Staged.Ids).IsEmpty()) return Fail(TEXT("MATERIAL_STATE_TOO_LARGE"), TEXT("The staged authored state exceeds the verification limit"));
    if (UMaterialFunction* Function = Cast<UMaterialFunction>(Asset))
    {
        if (FunctionSignature(Function) != FunctionSignature(CastChecked<UMaterialFunction>(Stage.Get())))
        {
            const TArray<FString> Callers = LoadedFunctionCallers(Function);
            if (!Callers.IsEmpty())
            {
                TArray<TSharedPtr<FJsonValue>> CallerPaths;
                for (int32 Index = 0; Index < FMath::Min(Callers.Num(), 32); ++Index) CallerPaths.Add(MakeShared<FJsonValueString>(Callers[Index]));
                ErrorDetails->SetArrayField(TEXT("loadedCallers"), CallerPaths);
                return Fail(TEXT("MATERIAL_FUNCTION_INTERFACE_IN_USE"),
                    TEXT("This batch changes a function input/output signature used by loaded callers. Caller-aware interface migration is not supported; no original asset was changed"));
            }
        }
    }
    TArray<FString> CompileErrors; FString CompileScope;
    if (!CompileAsset(Stage.Get(), CompileErrors, CompileScope))
    {
        ErrorDetails->SetBoolField(TEXT("retryable"), true);
        return Fail(TEXT("MATERIAL_COMPILE_FAILED"), FString::Join(CompileErrors, TEXT("\n")));
    }
    FApplied Applied;
    if (!bDryRun)
    {
        // Staging may finish shader jobs and dispatch editor callbacks. Recheck
        // at the write boundary; an unsaved package itself is not a conflict.
        if (!FDSHAssetPresentation::CanEditMaterialAsset(Asset, ErrorMessage))
            return Fail(TEXT("MATERIAL_EDITOR_CONFLICT"), ErrorMessage);
        FSnapshot Snapshot(Asset);
        if (!Snapshot.Capture(ErrorMessage)) return Fail(TEXT("MATERIAL_SNAPSHOT_FAILED"), ErrorMessage);
        bool bSuccess = false;
        {
            FScopedTransaction Transaction(FDSHAssetPresentation::MaterialTransactionContext(),
                NSLOCTEXT("DSHUnrealBridge", "MaterialBatch", "DSH Material Batch"), Asset);
            for (const FObjectCopy& Object : Snapshot.Objects) { Object.Object->SetFlags(RF_Transactional); Object.Object->Modify(); }
            bSuccess = Apply(Asset, Asset, Params, Applied, ErrorMessage);
#if WITH_DEV_AUTOMATION_TESTS
            if (bSuccess && TestAfterApply) TestAfterApply(Asset);
#endif
            CompileErrors.Reset();
            if (bSuccess) bSuccess = Acyclic(Asset, ErrorMessage) && CompileAsset(Asset, CompileErrors, CompileScope);
            if (bSuccess && AuthoredRevision(Asset, &Applied.Ids) != AuthoredRevision(Stage.Get(), &Staged.Ids))
            { bSuccess = false; ErrorMessage = TEXT("The applied authoring state does not match the compiled staged batch"); }
            if (!bSuccess)
            {
                if (ErrorMessage.IsEmpty()) ErrorMessage = FString::Join(CompileErrors, TEXT("\n"));
                const FString OriginalError = ErrorMessage;
                FString RecoveryError;
                bool bRestored = Snapshot.Restore(RecoveryError);
                if (bRestored)
                {
                    CompileErrors.Reset();
                    bRestored = CompileAsset(Asset, CompileErrors, CompileScope)
                        && AuthoredRevision(Asset) == Snapshot.Revision;
                    Asset->GetOutermost()->SetDirtyFlag(Snapshot.bDirty);
                    bRestored = bRestored && Asset->GetOutermost()->IsDirty() == Snapshot.bDirty;
                    if (!bRestored && RecoveryError.IsEmpty()) RecoveryError = FString::Join(CompileErrors, TEXT("\n"));
                }
                Transaction.Cancel();
                ErrorDetails->SetStringField(TEXT("execution"), TEXT("failed"));
                ErrorDetails->SetStringField(TEXT("rollback"), bRestored ? TEXT("restored") : TEXT("failed"));
                ErrorDetails->SetBoolField(TEXT("retryable"), bRestored);
                ErrorDetails->SetBoolField(TEXT("snapshotVerified"), bRestored);
                ErrorDetails->SetBoolField(TEXT("recompiled"), bRestored);
                return Fail(bRestored ? TEXT("MATERIAL_APPLY_FAILED") : TEXT("ROLLBACK_FAILED"),
                    OriginalError + (RecoveryError.IsEmpty() ? FString() : TEXT("\nRecovery: ") + RecoveryError));
            }
        }
        Asset->MarkPackageDirty();
        if (AuthoredRevision(Asset) != Snapshot.Revision)
        {
            FString RefreshReason;
            if (!FDSHAssetPresentation::RefreshOpenMaterialEditors(Asset, RefreshReason))
                Applied.Warnings.Add(TEXT("The native edit committed, but editor synchronization was skipped: ") + RefreshReason);
        }
        if (ViewHint)
        {
            ViewHint->AssetPath = Asset->GetPathName();
            for (UMaterialExpression* Node : Applied.Changed) ViewHint->NodeIds.Add(NodeId(Node));
        }
    }
    FApplied& Done = bDryRun ? Staged : Applied;
    auto Result = Obj();
    Result->SetBoolField(TEXT("verified"), true); Result->SetBoolField(TEXT("dryRun"), bDryRun); Result->SetBoolField(TEXT("saved"), false);
    Result->SetStringField(TEXT("assetPath"), Asset->GetPathName()); Result->SetStringField(TEXT("assetClass"), Asset->GetClass()->GetPathName());
    Result->SetStringField(TEXT("revision"), AuthoredRevision(Asset)); Result->SetStringField(TEXT("baseRevision"), Base);
    auto Compile = Obj(); Compile->SetBoolField(TEXT("verified"), true); Compile->SetStringField(TEXT("scope"), CompileScope);
    Compile->SetBoolField(TEXT("visualMatchVerified"), false); Result->SetObjectField(TEXT("compile"), Compile);
    auto Counts = Obj();
    Counts->SetNumberField(TEXT("added"), Done.Added); Counts->SetNumberField(TEXT("deleted"), Done.Deleted);
    Counts->SetNumberField(TEXT("connected"), Done.Connected); Counts->SetNumberField(TEXT("properties"), Done.Properties);
    Counts->SetNumberField(TEXT("cleaned"), Done.Cleaned); Result->SetObjectField(TEXT("counts"), Counts);
    auto Map = Obj();
    const auto Remaining = Expressions(bDryRun ? Stage.Get() : Asset);
    for (const auto& Pair : Done.Ids) if (Done.AddedAliases.Contains(Pair.Key) && Remaining.Contains(Pair.Value)) Map->SetStringField(Pair.Key, NodeId(Pair.Value));
    Result->SetObjectField(TEXT("nodeMap"), Map);
    TArray<TSharedPtr<FJsonValue>> Warnings;
    for (const FString& Warning : Done.Warnings) Warnings.Add(MakeShared<FJsonValueString>(Warning));
    if (bDryRun) Warnings.Add(MakeShared<FJsonValueString>(TEXT("Dry-run node IDs belong to the transient preview; apply returns the actual new IDs")));
    if (Asset->IsA<UMaterialFunction>()) Warnings.Add(MakeShared<FJsonValueString>(TEXT("Function outputs compiled with preview input values; caller-specific usage and all parameter combinations require separate validation")));
    Result->SetArrayField(TEXT("warnings"), Warnings);
    return Result;
}
