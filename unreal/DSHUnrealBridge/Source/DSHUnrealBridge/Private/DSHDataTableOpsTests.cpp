#if WITH_DEV_AUTOMATION_TESTS
#include "DSHDataTableOps.h"
#include "DSHDataTableOpsTestTypes.h"
#include "Dom/JsonValue.h"
#include "Editor.h"
#include "Misc/AutomationTest.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/StructOnScope.h"
#include "UObject/UnrealType.h"

namespace
{
struct FTableFixture
{
    TStrongObjectPtr<UDataTable> Table;
    FString Path;

    FTableFixture()
    {
        const FString PackageName = TEXT("/Game/DSHBridgeTests/DT_Copy_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        UPackage* Package = CreatePackage(*PackageName);
        const FString Name = FPackageName::GetShortName(PackageName);
        Table.Reset(NewObject<UDataTable>(Package, *Name, RF_Public | RF_Standalone | RF_Transactional));
        Table->RowStruct = FDSHDataTableCopyTestRow::StaticStruct();
        Table->AddRow(TEXT("Predestrian"), Row(1));
        Table->AddRow(TEXT("Car"), Row(2));
        Table->AddRow(TEXT("Bus"), Row(3));
        FDSHDataTableCopyTestRow Same = Row(4);
        Same.RenderTargetColors = Row(1).RenderTargetColors;
        Table->AddRow(TEXT("Same"), Same);
        Package->SetDirtyFlag(false);
        Path = Table->GetPathName();
    }

    static FDSHDataTableCopyTestRow Row(int32 Index)
    {
        FDSHDataTableCopyTestRow Result;
        FDSHDataTableCopyTestColors Values;
        Values.Colors.Add(TEXT("Warning"), FLinearColor(Index * 0.1f, Index * 0.2f, Index * 0.3f, 0.75f));
        Values.Colors.Add(TEXT("Normal"), FLinearColor(0.123456f, 0.5f, 0.8f, 1.0f));
        Values.Samples.Add(FVector(Index * 1.23456789, -Index, 100000.25));
        Result.RenderTargetColors.Add(TEXT("Body"), Values);
        Result.FloatParameters.Add(TEXT("Warning"), Index * 1.25f);
        Result.VectorParameters.Add(TEXT("Offset"), FVector(Index, Index + 0.75, -Index));
        Result.AnimToPlay = TSoftObjectPtr<UObject>(FSoftObjectPath(TEXT("/Game/Fixture/Anim_") + FString::FromInt(Index) + TEXT(".Anim_") + FString::FromInt(Index)));
        Result.Label = FString::Printf(TEXT("Row %d"), Index);
        Result.Sentinels[0] = Index * 10;
        Result.Sentinels[1] = Index * 10 + 1;
        return Result;
    }

    FDSHDataTableCopyTestRow* Get(FName Name) const
    {
        return reinterpret_cast<FDSHDataTableCopyTestRow*>(Table->FindRowUnchecked(Name));
    }

    TSharedPtr<FJsonObject> Params() const
    {
        auto Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("assetPath"), Path);
        Result->SetStringField(TEXT("sourceRow"), TEXT("Predestrian"));
        Result->SetStringField(TEXT("propertyName"), TEXT("RenderTargetColors"));
        return Result;
    }

    static void Targets(const TSharedPtr<FJsonObject>& Params, std::initializer_list<const TCHAR*> Names)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (const TCHAR* Name : Names) Values.Add(MakeShared<FJsonValueString>(Name));
        Params->SetArrayField(TEXT("targetRows"), Values);
    }
};

bool SameRow(const FDSHDataTableCopyTestRow* A, const FDSHDataTableCopyTestRow& B)
{
    return FDSHDataTableCopyTestRow::StaticStruct()->CompareScriptStruct(A, &B, PPF_None);
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyPreservation, "DSH.Bridge.DataTableCopy.Preservation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyPreservation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow SourceBefore = *Fixture.Get(TEXT("Predestrian"));
    FDSHDataTableCopyTestRow CarExpected = *Fixture.Get(TEXT("Car"));
    FDSHDataTableCopyTestRow BusExpected = *Fixture.Get(TEXT("Bus"));
    const FDSHDataTableCopyTestRow SameBefore = *Fixture.Get(TEXT("Same"));
    CarExpected.RenderTargetColors = SourceBefore.RenderTargetColors;
    BusExpected.RenderTargetColors = SourceBefore.RenderTargetColors;
    FString Code, Error;
    TSharedPtr<FJsonObject> Details;
    const auto Result = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
    if (!TestTrue(TEXT("Batch copy succeeds: ") + Error, Result.IsValid())) return false;
    TestEqual(TEXT("All other rows targeted"), Result->GetNumberField(TEXT("targetCount")), 3.0);
    TestEqual(TEXT("Only differing rows changed"), Result->GetNumberField(TEXT("changedRows")), 2.0);
    TestEqual(TEXT("Already-matching row counted"), Result->GetNumberField(TEXT("unchangedRows")), 1.0);
    TestTrue(TEXT("Native read-back verified"), Result->GetBoolField(TEXT("verified")));
    TestFalse(TEXT("No save"), Result->GetBoolField(TEXT("saved")));
    TestTrue(TEXT("Source entire row preserved"), SameRow(Fixture.Get(TEXT("Predestrian")), SourceBefore));
    TestTrue(TEXT("Car maps, soft object, strings and static array preserved"), SameRow(Fixture.Get(TEXT("Car")), CarExpected));
    TestTrue(TEXT("Bus maps, soft object, strings and static array preserved"), SameRow(Fixture.Get(TEXT("Bus")), BusExpected));
    TestTrue(TEXT("Already-matching entire row preserved"), SameRow(Fixture.Get(TEXT("Same")), SameBefore));
    TestTrue(TEXT("Successful edit marks package dirty"), Fixture.Table->GetOutermost()->IsDirty());

    const auto NoOp = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
    if (TestTrue(TEXT("Second copy is a verified no-op"), NoOp.IsValid()))
        TestEqual(TEXT("No additional changes"), NoOp->GetNumberField(TEXT("changedRows")), 0.0);
    Fixture.Get(TEXT("Predestrian"))->RenderTargetColors[TEXT("Body")].Colors[TEXT("Warning")].R = 0.999f;
    TestTrue(TEXT("Containers were deep copied"), SameRow(Fixture.Get(TEXT("Car")), CarExpected));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyValidation, "DSH.Bridge.DataTableCopy.Validation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyValidation::RunTest(const FString&)
{
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow Source = *Fixture.Get(TEXT("Predestrian"));
    const FDSHDataTableCopyTestRow Car = *Fixture.Get(TEXT("Car"));
    const FDSHDataTableCopyTestRow Bus = *Fixture.Get(TEXT("Bus"));
    FString Code, Error;
    TSharedPtr<FJsonObject> Details;
    auto Reject = [&](const TCHAR* Label, const TSharedPtr<FJsonObject>& Params)
    {
        TestFalse(Label, FDSHDataTableOps::CopyProperty(Params, Code, Error, Details).IsValid());
        TestEqual(TEXT("Validation failure never entered a mutation"), Details->GetStringField(TEXT("rollback")), FString(TEXT("not_needed")));
        TestTrue(TEXT("Validation preserves source"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
        TestTrue(TEXT("Validation preserves first target"), SameRow(Fixture.Get(TEXT("Car")), Car));
        TestTrue(TEXT("Validation preserves other rows"), SameRow(Fixture.Get(TEXT("Bus")), Bus));
        TestFalse(TEXT("Validation does not mark dirty"), Fixture.Table->GetOutermost()->IsDirty());
    };
    auto Params = Fixture.Params(); FTableFixture::Targets(Params, {}); Reject(TEXT("Empty target list rejected"), Params);
    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Car"), TEXT("car")}); Reject(TEXT("Case-insensitive duplicate targets rejected"), Params);
    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Car"), TEXT("Missing")}); Reject(TEXT("All targets validated before any write"), Params);
    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Predestrian")}); Reject(TEXT("Source cannot be target"), Params);
    Params = Fixture.Params(); Params->SetStringField(TEXT("sourceRow"), TEXT("Missing")); Reject(TEXT("Missing source rejected"), Params);
    Params = Fixture.Params(); Params->SetStringField(TEXT("propertyName"), TEXT("renderTargetColors")); Reject(TEXT("Property casing is exact"), Params);
    Params = Fixture.Params(); Params->SetField(TEXT("targetRows"), MakeShared<FJsonValueNull>()); Reject(TEXT("Null targets rejected"), Params);
    Params = Fixture.Params(); Params->SetBoolField(TEXT("unexpected"), true); Reject(TEXT("Unknown arguments rejected"), Params);
    Params = Fixture.Params(); Params->SetStringField(TEXT("assetPath"), FDSHDataTableCopyTestRow::StaticStruct()->GetPathName()); Reject(TEXT("Non-DataTable asset rejected"), Params);
    Params = Fixture.Params();
    TArray<TSharedPtr<FJsonValue>> Excess;
    for (int32 Index = 0; Index < 4097; ++Index) Excess.Add(MakeShared<FJsonValueString>(TEXT("Car")));
    Params->SetArrayField(TEXT("targetRows"), Excess); Reject(TEXT("Oversize target list rejected"), Params);

    Params = Fixture.Params(); FTableFixture::Targets(Params, {TEXT("Car")});
    const auto Result = FDSHDataTableOps::CopyProperty(Params, Code, Error, Details);
    if (!TestTrue(TEXT("Explicit subset copy succeeds: ") + Error, Result.IsValid())) return false;
    TestEqual(TEXT("Exactly one target"), Result->GetNumberField(TEXT("targetCount")), 1.0);
    TestTrue(TEXT("Non-target row preserved"), SameRow(Fixture.Get(TEXT("Bus")), Bus));
    TestTrue(TEXT("Subset source preserved"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyRollback, "DSH.Bridge.DataTableCopy.Rollback",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyRollback::RunTest(const FString&)
{
    for (const bool bInitiallyDirty : {false, true})
    {
        FTableFixture Fixture;
        Fixture.Table->GetOutermost()->SetDirtyFlag(bInitiallyDirty);
        const FDSHDataTableCopyTestRow Source = *Fixture.Get(TEXT("Predestrian"));
        const FDSHDataTableCopyTestRow Car = *Fixture.Get(TEXT("Car"));
        const FDSHDataTableCopyTestRow Bus = *Fixture.Get(TEXT("Bus"));
        int32 CallbackCount = 0;
        const FDelegateHandle Handle = Fixture.Table->OnDataTableChanged().AddLambda([&]()
        {
            ++CallbackCount;
            // Simulate a listener changing an unrelated field. It does so again
            // when rollback announces restoration, exercising the final restore.
            Fixture.Get(TEXT("Predestrian"))->FloatParameters.Empty();
            Fixture.Get(TEXT("Car"))->Sentinels[1] = -999;
            if (CallbackCount == 1) Fixture.Table->AddRow(TEXT("Unexpected"), FTableFixture::Row(99));
        });
        FString Code, Error;
        TSharedPtr<FJsonObject> Details;
        const auto Result = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
        Fixture.Table->OnDataTableChanged().Remove(Handle);
        TestFalse(TEXT("Unrelated listener changes fail verification"), Result.IsValid());
        TestEqual(TEXT("Explicit verification error"), Code, FString(TEXT("DATA_TABLE_VERIFICATION_FAILED")));
        TestEqual(TEXT("Verified rollback reported"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
        TestEqual(TEXT("Original row count restored"), Fixture.Table->GetRowMap().Num(), 4);
        TestTrue(TEXT("Source maps fully restored"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
        TestTrue(TEXT("Changed target and static-array second element restored"), SameRow(Fixture.Get(TEXT("Car")), Car));
        TestTrue(TEXT("Every other row restored"), SameRow(Fixture.Get(TEXT("Bus")), Bus));
        TestEqual(TEXT("Original dirty state restored"), Fixture.Table->GetOutermost()->IsDirty(), bInitiallyDirty);
        TestTrue(TEXT("Rollback callback is bounded"), CallbackCount <= 3);
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHDataTableCopyUndo, "DSH.Bridge.DataTableCopy.Undo",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHDataTableCopyUndo::RunTest(const FString&)
{
    if (!GEditor) return false;
    FTableFixture Fixture;
    const FDSHDataTableCopyTestRow Source = *Fixture.Get(TEXT("Predestrian"));
    const FDSHDataTableCopyTestRow Car = *Fixture.Get(TEXT("Car"));
    const FDSHDataTableCopyTestRow Bus = *Fixture.Get(TEXT("Bus"));
    FString Code, Error;
    TSharedPtr<FJsonObject> Details;
    const auto Result = FDSHDataTableOps::CopyProperty(Fixture.Params(), Code, Error, Details);
    if (!TestTrue(TEXT("Copy creates one transaction: ") + Error, Result.IsValid())) return false;
    TestTrue(TEXT("One undo succeeds"), GEditor->UndoTransaction());
    TestTrue(TEXT("Single undo restores every target"), SameRow(Fixture.Get(TEXT("Car")), Car) && SameRow(Fixture.Get(TEXT("Bus")), Bus));
    TestTrue(TEXT("Undo preserves source"), SameRow(Fixture.Get(TEXT("Predestrian")), Source));
    return true;
}
#endif
