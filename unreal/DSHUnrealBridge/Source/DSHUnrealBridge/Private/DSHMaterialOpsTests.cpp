#if WITH_DEV_AUTOMATION_TESTS

#include "DSHMaterialOps.h"
#include "DSHMaterialOpsTestTypes.h"
#include "Editor.h"
#include "MaterialEditingLibrary.h"
#include "MaterialShared.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionLayerStack.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialFunction.h"
#include "Misc/AutomationTest.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "RHI.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

namespace
{
struct FMaterialFixture
{
    TStrongObjectPtr<UObject> Asset;
    explicit FMaterialFixture(bool bFunction = false, const FString& Mount = TEXT("/Game/"))
    {
        const FString Name = TEXT("DSHMaterial_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        UPackage* Package = CreatePackage(*(Mount + TEXT("DSHTests/") + Name));
        if (bFunction) Asset.Reset(NewObject<UMaterialFunction>(Package, *Name, RF_Public | RF_Standalone | RF_Transactional));
        else
        {
            UMaterial* Material = NewObject<UMaterial>(Package, *Name, RF_Public | RF_Standalone | RF_Transactional);
            Material->SetShadingModel(MSM_Unlit);
            Asset.Reset(Material);
        }
        Package->SetDirtyFlag(false);
    }
    ~FMaterialFixture()
    {
        FDSHMaterialOps::TestAfterApply = nullptr;
        Asset->ClearFlags(RF_Public | RF_Standalone);
        Asset->GetOutermost()->SetDirtyFlag(false);
    }
};
TSharedPtr<FJsonObject> Parse(const FString& Text)
{
    TSharedPtr<FJsonObject> Result;
    FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Result);
    return Result;
}
TSharedPtr<FJsonObject> Parameters(UObject* Asset, const FString& Body, bool bDryRun)
{
    auto Params = Parse(Body);
    Params->SetStringField(TEXT("assetPath"), Asset->GetPathName());
    Params->SetStringField(TEXT("baseRevision"), FDSHMaterialOps::Revision(Asset));
    Params->SetBoolField(TEXT("dryRun"), bDryRun);
    return Params;
}
TSharedPtr<FJsonObject> Run(const TSharedPtr<FJsonObject>& Params, FString& Code, FString& Message, TSharedPtr<FJsonObject>& Details)
{
    return FDSHMaterialOps::Execute(TEXT("material_patch"), Params, Code, Message, Details);
}
UMaterialExpressionConstant* Constant(UMaterial* Material, float Value)
{
    auto* Node = Cast<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Material, nullptr,
        UMaterialExpressionConstant::StaticClass(), nullptr, 700, 800, false));
    Node->R = Value;
    return Node;
}
bool RequireRHI(FAutomationTestBase& Test)
{
    if (!GUsingNullRHI) return true;
    Test.AddError(TEXT("Material compilation tests require a real RHI; do not run this group with -NullRHI"));
    return false;
}
const TCHAR* BasicBatch = TEXT(R"JSON({
  "operations":[
    {"op":"add","id":"amount","expressionClass":"/Script/Engine.MaterialExpressionScalarParameter","properties":{"ParameterName":"Amount","DefaultValue":0.5,"Group":"Batch Test","Desc":"A named parameter"}},
    {"op":"add","id":"multiply","expressionClass":"/Script/Engine.MaterialExpressionMultiply","properties":{"ConstB":0.5}},
    {"op":"connect","from":{"id":"amount","pin":0},"to":{"id":"multiply","pin":"A"}},
    {"op":"output","from":{"id":"multiply","pin":0},"property":"MP_EmissiveColor"},
    {"op":"add","id":"note","expressionClass":"/Script/Engine.MaterialExpressionComment","properties":{"Text":"Batch function","SizeX":500,"SizeY":300},"position":{"x":-900,"y":-200}},
    {"op":"add","id":"unused","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.75}}
  ],
  "cleanupNodeIds":["unused"],
  "layout":"all"
})JSON");
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialRead, "DSH.Bridge.MaterialBatch.ReadAndMount", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialRead::RunTest(const FString&)
{
    FPackageName::RegisterMountPoint(TEXT("/DSHBatchTest/"), FPaths::ProjectSavedDir() / TEXT("DSHBatchMount/"));
    FMaterialFixture Fixture(false, TEXT("/DSHBatchTest/"));
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    auto* First = Constant(Material, .2f);
    Constant(Material, .7f);
    const FString Before = FDSHMaterialOps::Revision(Material);
    auto Params = MakeShared<FJsonObject>(); Params->SetStringField(TEXT("assetPath"), Material->GetPathName());
    Params->SetArrayField(TEXT("expressionClasses"), {MakeShared<FJsonValueString>(TEXT("/Script/Engine.MaterialExpressionCustom"))});
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = FDSHMaterialOps::Execute(TEXT("material_read"), Params, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestTrue(TEXT("Unfiltered read is complete"), Result->GetBoolField(TEXT("nodesComplete")));
    TestEqual(TEXT("Both expressions returned"), Result->GetArrayField(TEXT("nodes")).Num(), 2);
    TestEqual(TEXT("Owner evidence is exact"), Result->GetArrayField(TEXT("nodes"))[0]->AsObject()->GetStringField(TEXT("ownerPath")), Material->GetPathName());
    Params->SetArrayField(TEXT("nodeIds"), {MakeShared<FJsonValueString>(First->MaterialExpressionGuid.ToString(EGuidFormats::DigitsWithHyphens))});
    Result = FDSHMaterialOps::Execute(TEXT("material_read"), Params, Code, Message, Details);
    TestTrue(TEXT("Filtered read succeeds"), Result.IsValid());
    if (Result)
    {
        TestFalse(TEXT("Filtered read is not complete"), Result->GetBoolField(TEXT("nodesComplete")));
        TestEqual(TEXT("Filtering does not include subsequent nodes"), Result->GetArrayField(TEXT("nodes")).Num(), 1);
    }
    Params->SetArrayField(TEXT("nodeIds"), {});
    Result = FDSHMaterialOps::Execute(TEXT("material_read"), Params, Code, Message, Details);
    TestTrue(TEXT("Empty filter succeeds"), Result.IsValid());
    if (Result) TestEqual(TEXT("Empty explicit filter returns no nodes"), Result->GetArrayField(TEXT("nodes")).Num(), 0);
    TestEqual(TEXT("Reads do not edit graph"), FDSHMaterialOps::Revision(Material), Before);
    FPackageName::UnRegisterMountPoint(TEXT("/DSHBatchTest/"), FPaths::ProjectSavedDir() / TEXT("DSHBatchMount/"));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialPreflight, "DSH.Bridge.MaterialBatch.PinPreflight", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialPreflight::RunTest(const FString&)
{
    FMaterialFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    auto* Existing = Constant(Material, .42f);
    Material->GetOutermost()->SetDirtyFlag(true);
    const FString Before = FDSHMaterialOps::Revision(Material);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Params = Parameters(Material, TEXT(R"({"operations":[
      {"op":"add","id":"new","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.2}},
      {"op":"add","id":"mul","expressionClass":"/Script/Engine.MaterialExpressionMultiply"},
      {"op":"connect","from":{"id":"new","pin":"does-not-exist"},"to":{"id":"mul","pin":"A"}}
    ]})"), false);
    auto Result = Run(Params, Code, Message, Details);
    TestFalse(TEXT("Invalid output pin is rejected"), Result.IsValid());
    TestEqual(TEXT("Preflight reports validation failure"), Code, FString(TEXT("MATERIAL_VALIDATION_FAILED")));
    TestEqual(TEXT("Failure identifies operation"), Message.Contains(TEXT("operations[2]")), true);
    TestEqual(TEXT("Original topology and properties unchanged"), FDSHMaterialOps::Revision(Material), Before);
    TestTrue(TEXT("Original unsaved dirty state preserved"), Material->GetOutermost()->IsDirty());
    TestTrue(TEXT("Original object identity preserved"), Material->GetExpressions()[0] == Existing);
    TestEqual(TEXT("No original write"), Details->GetStringField(TEXT("rollback")), FString(TEXT("not_needed")));
    Params = Parameters(Material, TEXT(R"({"operations":[{"op":"add","id":"a","expressionClass":"/Script/Engine.MaterialExpressionMultiply"},{"op":"connect","from":{"id":"a","pin":0},"to":{"id":"a","pin":0}}]})"), false);
    Result = Run(Params, Code, Message, Details);
    TestFalse(TEXT("Cycles are rejected before recursive layout/compile"), Result.IsValid());
    TestTrue(TEXT("Cycle reason is explicit"), Message.Contains(TEXT("cycle")));
    TestEqual(TEXT("Cycle rejection leaves original unchanged"), FDSHMaterialOps::Revision(Material), Before);
    FMaterialFixture FunctionFixture(true);
    auto Recursive = Parameters(FunctionFixture.Asset.Get(), FString::Printf(TEXT(R"JSON({"operations":[
      {"op":"add","id":"recursive","expressionClass":"/Script/Engine.MaterialExpressionMaterialFunctionCall","properties":{"MaterialFunction":"%s"}}
    ]})JSON"), *FunctionFixture.Asset->GetPathName()), false);
    Result = Run(Recursive, Code, Message, Details);
    TestFalse(TEXT("Recursive function reference is rejected without a modal setter"), Result.IsValid());
    TestTrue(TEXT("Dependency error is explicit"), Message.Contains(TEXT("circular dependency")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialRoundTrip, "DSH.Bridge.MaterialBatch.RoundTrip", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialRoundTrip::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    auto* Experimental = Constant(Material, .123f);
    auto* UserData = NewObject<UDSHMaterialBatchTestData>(Material, TEXT("FixtureMetadata"), RF_Transactional);
    UserData->Labels.Add(TEXT("keep"), TEXT("unsaved"));
    Material->AddAssetUserData(UserData);
    Material->GetOutermost()->SetDirtyFlag(false);
    const FString Before = FDSHMaterialOps::Revision(Material);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Preview = Run(Parameters(Material, BasicBatch, true), Code, Message, Details);
    if (!TestTrue(*Message, Preview.IsValid())) return false;
    TestTrue(TEXT("Preview compiled and verified"), Preview->GetBoolField(TEXT("verified")));
    TestEqual(TEXT("Preview retains original revision"), FDSHMaterialOps::Revision(Material), Before);
    TestFalse(TEXT("Preview preserves clean package"), Material->GetOutermost()->IsDirty());
    auto Applied = Run(Parameters(Material, BasicBatch, false), Code, Message, Details);
    if (!TestTrue(*Message, Applied.IsValid())) return false;
    TestFalse(TEXT("Batch never automatically saves"), Applied->GetBoolField(TEXT("saved")));
    TestTrue(TEXT("Applied batch is dirty"), Material->GetOutermost()->IsDirty());
    TestEqual(TEXT("Only explicit unused candidate removed"), Applied->GetObjectField(TEXT("counts"))->GetIntegerField(TEXT("cleaned")), 1);
    TestTrue(TEXT("Existing unused experimental expression retained"), Material->GetExpressions().Contains(Experimental));
    TestEqual(TEXT("Owned instanced metadata survives staged commit"), UserData->Labels.FindChecked(TEXT("keep")), FString(TEXT("unsaved")));
    TestEqual(TEXT("Three remaining non-comment expressions"), Material->GetExpressions().Num(), 3);
    TestEqual(TEXT("Comment retained separately"), Material->GetExpressionCollection().EditorComments.Num(), 1);
    TestNotEqual(TEXT("Applied revision changes"), FDSHMaterialOps::Revision(Material), Before);
    TestTrue(TEXT("Single editor undo accepted"), GEditor->UndoTransaction());
    TestEqual(TEXT("Single undo restores graph"), FDSHMaterialOps::Revision(Material), Before);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialCustom, "DSH.Bridge.MaterialBatch.CustomAndDynamicPins", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialCustom::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture Fixture;
    auto Params = Parameters(Fixture.Asset.Get(), TEXT(R"JSON({"operations":[
      {"op":"add","id":"uv","expressionClass":"/Script/Engine.MaterialExpressionTextureCoordinate"},
      {"op":"add","id":"custom","expressionClass":"/Script/Engine.MaterialExpressionCustom","properties":{"Code":"return UV.x;","OutputType":"CMOT_Float1","Inputs":[{"InputName":"UV"}]}},
      {"op":"connect","from":{"id":"uv","pin":0},"to":{"id":"custom","pin":"UV"}},
      {"op":"output","from":{"id":"custom","pin":0},"property":"MP_EmissiveColor"}
    ]})JSON"), false);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = Run(Params, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    UMaterialExpressionCustom* Custom = nullptr;
    for (UMaterialExpression* Node : Material->GetExpressions()) if (auto* Found = Cast<UMaterialExpressionCustom>(Node)) Custom = Found;
    if (!TestNotNull(TEXT("Custom expression exists"), Custom)) return false;
    TestEqual(TEXT("Custom Inputs array configured atomically"), Custom->Inputs.Num(), 1);
    TestNotNull(TEXT("Custom input is connected"), Custom->Inputs[0].Input.Expression);
    TestTrue(TEXT("Output routes to custom expression"), Material->GetExpressionInputForProperty(MP_EmissiveColor)->Expression == Custom);
    TestTrue(TEXT("Shader verified"), Result->GetObjectField(TEXT("compile"))->GetBoolField(TEXT("verified")));
    UMaterialExpression* OriginalUV = Custom->Inputs[0].Input.Expression;
    const FString CustomId = Custom->MaterialExpressionGuid.ToString(EGuidFormats::DigitsWithHyphens);
    auto Append = Parameters(Material, FString::Printf(TEXT(R"JSON({"operations":[
      {"op":"set","id":"%s","properties":{"Code":"return UV.x + Extra;","Inputs":[{"InputName":"UV"},{"InputName":"Extra"}]}},
      {"op":"add","id":"extra","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.1}},
      {"op":"connect","from":{"id":"extra","pin":0},"to":{"id":"%s","pin":"Extra"}}
    ]})JSON"), *CustomId, *CustomId), false);
    Result = Run(Append, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestEqual(TEXT("Custom input array extended"), Custom->Inputs.Num(), 2);
    TestTrue(TEXT("Retained array index preserves original hidden connection"), Custom->Inputs[0].Input.Expression == OriginalUV);
    TestNotNull(TEXT("New appended input connected"), Custom->Inputs[1].Input.Expression);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialFunction, "DSH.Bridge.MaterialBatch.FunctionOutput", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialFunction::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture Fixture(true);
    const FGuid StateBefore = CastChecked<UMaterialFunction>(Fixture.Asset.Get())->StateId;
    auto Params = Parameters(Fixture.Asset.Get(), TEXT(R"JSON({"operations":[
      {"op":"add","id":"input","expressionClass":"/Script/Engine.MaterialExpressionFunctionInput","properties":{"InputName":"Intensity","InputType":"FunctionInput_Scalar","PreviewValue":{"X":0.5,"Y":0,"Z":0,"W":0}}},
      {"op":"add","id":"multiply","expressionClass":"/Script/Engine.MaterialExpressionMultiply","properties":{"ConstB":0.25}},
      {"op":"add","id":"output","expressionClass":"/Script/Engine.MaterialExpressionFunctionOutput","properties":{"OutputName":"Result"}},
      {"op":"connect","from":{"id":"input","pin":0},"to":{"id":"multiply","pin":"A"}},
      {"op":"connect","from":{"id":"multiply","pin":0},"to":{"id":"output","pin":0}}
    ]})JSON"), false);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = Run(Params, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestEqual(TEXT("Function graph committed"), CastChecked<UMaterialFunction>(Fixture.Asset.Get())->GetExpressions().Num(), 3);
    TestEqual(TEXT("Function scope is explicit"), Result->GetObjectField(TEXT("compile"))->GetStringField(TEXT("scope")), FString(TEXT("each_function_output_with_preview_inputs")));
    TestFalse(TEXT("Function remains unsaved"), Result->GetBoolField(TEXT("saved")));
    TestTrue(TEXT("Real function shader state refreshed"), CastChecked<UMaterialFunction>(Fixture.Asset.Get())->StateId != StateBefore);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialRollback, "DSH.Bridge.MaterialBatch.RollbackPreservesMemory", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialRollback::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    auto* Original = Constant(Material, .381f);
    auto* UserData = NewObject<UDSHMaterialBatchTestData>(Material, TEXT("RollbackMetadata"), RF_Transactional);
    UserData->Labels.Add(TEXT("keep"), TEXT("original unsaved"));
    Material->AddAssetUserData(UserData);
    Material->GetExpressionInputForProperty(MP_EmissiveColor)->Connect(0, Original);
    Material->GetOutermost()->SetDirtyFlag(true);
    const FString Before = FDSHMaterialOps::Revision(Material);
    const FString OldId = Original->MaterialExpressionGuid.ToString(EGuidFormats::DigitsWithHyphens);
    auto Params = Parameters(Material, FString::Printf(TEXT(R"JSON({"operations":[
      {"op":"set","id":"%s","properties":{"R":0.8}},
      {"op":"add","id":"added","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.4}},
      {"op":"output","from":{"id":"added","pin":0},"property":"MP_EmissiveColor"}
    ]})JSON"), *OldId), false);
    FDSHMaterialOps::TestAfterApply = [UserData](UObject* Asset)
    {
        // Valid but unauthorized post-apply mutation must be caught by stage equivalence.
        CastChecked<UMaterial>(Asset)->TwoSided = true;
        UserData->Labels[TEXT("keep")] = TEXT("unexpected");
    };
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = Run(Params, Code, Message, Details);
    FDSHMaterialOps::TestAfterApply = nullptr;
    TestFalse(TEXT("Injected mismatch fails"), Result.IsValid());
    TestEqual(TEXT("Recovered failure is explicit"), Code, FString(TEXT("MATERIAL_APPLY_FAILED")));
    TestEqual(TEXT("Rollback is verified"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
    TestEqual(TEXT("Original in-memory unsaved values restored"), FDSHMaterialOps::Revision(Material), Before);
    TestEqual(TEXT("Existing expression value restored"), Original->R, .381f);
    TestEqual(TEXT("New expressions removed"), Material->GetExpressions().Num(), 1);
    TestTrue(TEXT("Existing object identity retained"), Material->GetExpressions()[0] == Original);
    TestTrue(TEXT("Original output connection restored"), Material->GetExpressionInputForProperty(MP_EmissiveColor)->Expression == Original);
    TestTrue(TEXT("Unsaved dirty state retained"), Material->GetOutermost()->IsDirty());
    TestEqual(TEXT("Owned metadata restored from memory"), UserData->Labels.FindChecked(TEXT("keep")), FString(TEXT("original unsaved")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialUI, "DSH.Bridge.MaterialBatch.UIDomain", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialUI::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture Fixture;
    auto Params = Parameters(Fixture.Asset.Get(), TEXT(R"JSON({"operations":[
      {"op":"asset_properties","properties":{"MaterialDomain":"MD_UI","BlendMode":"BLEND_Translucent"}},
      {"op":"add","id":"value","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.5}},
      {"op":"output","from":{"id":"value","pin":0},"property":"MP_EmissiveColor"},
      {"op":"output","from":{"id":"value","pin":0},"property":"MP_Opacity"}
    ]})JSON"), false);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = Run(Params, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestEqual(TEXT("UI material domain applied"), static_cast<int32>(CastChecked<UMaterial>(Fixture.Asset.Get())->MaterialDomain), static_cast<int32>(MD_UI));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialCompileFailure, "DSH.Bridge.MaterialBatch.InvalidShaderRejected", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialCompileFailure::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    Constant(Material, .6f);
    Material->GetOutermost()->SetDirtyFlag(true);
    const FString Before = FDSHMaterialOps::Revision(Material);
    auto Params = Parameters(Material, TEXT(R"JSON({"operations":[
      {"op":"add","id":"invalid","expressionClass":"/Script/Engine.MaterialExpressionCustom","properties":{"Code":"return DSH_INTENTIONAL_INVALID_SYMBOL;","OutputType":"CMOT_Float1","Inputs":[]}},
      {"op":"output","from":{"id":"invalid","pin":0},"property":"MP_EmissiveColor"}
    ]})JSON"), false);
    AddExpectedError(TEXT("DSH_INTENTIONAL_INVALID_SYMBOL"), EAutomationExpectedErrorFlags::Contains, 0);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = Run(Params, Code, Message, Details);
    TestFalse(TEXT("Invalid HLSL cannot be committed"), Result.IsValid());
    TestEqual(TEXT("Shader compilation failure is reported"), Code, FString(TEXT("MATERIAL_COMPILE_FAILED")));
    TestTrue(TEXT("Compiler error details retained"), Message.Contains(TEXT("DSH_INTENTIONAL_INVALID_SYMBOL")));
    TestEqual(TEXT("Failed shader leaves original graph unchanged"), FDSHMaterialOps::Revision(Material), Before);
    TestTrue(TEXT("Failed shader leaves original dirty state unchanged"), Material->GetOutermost()->IsDirty());
    TestEqual(TEXT("No original write occurred"), Details->GetStringField(TEXT("rollback")), FString(TEXT("not_needed")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialFunctionCaller, "DSH.Bridge.MaterialBatch.FunctionCallerSafety", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialFunctionCaller::RunTest(const FString&)
{
    if (!RequireRHI(*this)) return false;
    FMaterialFixture FunctionFixture(true), CallerFixture;
    UMaterialFunction* Function = CastChecked<UMaterialFunction>(FunctionFixture.Asset.Get());
    UMaterial* Caller = CastChecked<UMaterial>(CallerFixture.Asset.Get());
    auto Create = Parameters(Function, TEXT(R"JSON({"operations":[
      {"op":"add","id":"input","expressionClass":"/Script/Engine.MaterialExpressionFunctionInput","properties":{"InputName":"Input","InputType":"FunctionInput_Scalar","PreviewValue":{"X":0.5,"Y":0,"Z":0,"W":0}}},
      {"op":"add","id":"multiply","expressionClass":"/Script/Engine.MaterialExpressionMultiply","properties":{"ConstB":0.25}},
      {"op":"add","id":"output","expressionClass":"/Script/Engine.MaterialExpressionFunctionOutput","properties":{"OutputName":"Result"}},
      {"op":"connect","from":{"id":"input","pin":0},"to":{"id":"multiply","pin":"A"}},
      {"op":"connect","from":{"id":"multiply","pin":0},"to":{"id":"output","pin":0}}
    ]})JSON"), false);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Created = Run(Create, Code, Message, Details);
    if (!TestTrue(*Message, Created.IsValid())) return false;
    const auto Ids = Created->GetObjectField(TEXT("nodeMap"));
    auto* Call = CastChecked<UMaterialExpressionMaterialFunctionCall>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Caller, nullptr,
        UMaterialExpressionMaterialFunctionCall::StaticClass(), nullptr, 0, 0, false));
    if (!TestTrue(TEXT("Caller binds function"), Call->SetMaterialFunction(Function))) return false;
    auto* Source = Constant(Caller, .75f);
    Call->GetInputsView()[0]->Connect(0, Source);
    Caller->GetExpressionInputForProperty(MP_EmissiveColor)->Connect(0, Call);
    Caller->BuildEditorParameterList();
    {
        FMaterialUpdateContext UpdateContext;
        UpdateContext.AddMaterial(Caller);
        Caller->StateId = FGuid::NewGuid();
        Caller->ForceRecompileForRendering();
    }
    FMaterialResource* CallerResource = Caller->GetMaterialResource(GMaxRHIShaderPlatform);
    if (!TestNotNull(TEXT("Caller has a real compiled material resource"), CallerResource)) return false;
    CallerResource->FinishCompilation();
    if (!TestTrue(TEXT("Initial caller compiles"), CallerResource->GetCompileErrors().IsEmpty())) return false;
    TRefCountPtr<FMaterialShaderMap> InitialCallerShader = CallerResource->GetGameThreadShaderMap();
    if (!TestTrue(TEXT("Initial caller has an actual shader map"), InitialCallerShader.IsValid())) return false;
    Caller->GetOutermost()->SetDirtyFlag(false);
    Function->GetOutermost()->SetDirtyFlag(true);
    FString FunctionBefore = FDSHMaterialOps::Revision(Function);
    const FString CallerBefore = FDSHMaterialOps::Revision(Caller);
    auto Remove = Parameters(Function, FString::Printf(TEXT(R"({"operations":[{"op":"delete","id":"%s"}]})"),
        *Ids->GetStringField(TEXT("input"))), false);
    auto Result = Run(Remove, Code, Message, Details);
    TestFalse(TEXT("Used interface removal is refused"), Result.IsValid());
    TestEqual(TEXT("Caller-aware migration boundary is explicit"), Code, FString(TEXT("MATERIAL_FUNCTION_INTERFACE_IN_USE")));
    TestEqual(TEXT("Rejected interface leaves function unchanged"), FDSHMaterialOps::Revision(Function), FunctionBefore);
    TestEqual(TEXT("Rejected interface leaves caller topology unchanged"), FDSHMaterialOps::Revision(Caller), CallerBefore);
    TestTrue(TEXT("Caller input link survives rejection"), Call->GetInputsView()[0]->Expression == Source);
    TestFalse(TEXT("Caller clean state survives rejection"), Caller->GetOutermost()->IsDirty());
    TestTrue(TEXT("Function dirty state survives rejection"), Function->GetOutermost()->IsDirty());
    auto ValueOnly = Parameters(Function, FString::Printf(TEXT(R"({"operations":[{"op":"set","id":"%s","properties":{"ConstB":0.75}}]})"),
        *Ids->GetStringField(TEXT("multiply"))), false);
    Result = Run(ValueOnly, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestEqual(TEXT("Stable interface edit preserves caller authored state"), FDSHMaterialOps::Revision(Caller), CallerBefore);
    TestTrue(TEXT("Stable interface edit preserves input link"), Call->GetInputsView()[0]->Expression == Source);
    TestTrue(TEXT("Stable interface edit refreshes the loaded caller shader"), CallerResource->GetGameThreadShaderMap() != InitialCallerShader.GetReference());
    FunctionBefore = FDSHMaterialOps::Revision(Function);
    FDSHMaterialOps::TestAfterApply = [](UObject* Asset) { CastChecked<UMaterialFunction>(Asset)->Description = TEXT("Injected mismatch"); };
    ValueOnly = Parameters(Function, FString::Printf(TEXT(R"({"operations":[{"op":"set","id":"%s","properties":{"ConstB":0.1}}]})"),
        *Ids->GetStringField(TEXT("multiply"))), false);
    Result = Run(ValueOnly, Code, Message, Details);
    FDSHMaterialOps::TestAfterApply = nullptr;
    TestFalse(TEXT("Injected function commit mismatch fails"), Result.IsValid());
    TestEqual(TEXT("Function rollback is verified"), Details->GetStringField(TEXT("rollback")), FString(TEXT("restored")));
    TestEqual(TEXT("Function in-memory state restored"), FDSHMaterialOps::Revision(Function), FunctionBefore);
    TestEqual(TEXT("Caller state survives function rollback"), FDSHMaterialOps::Revision(Caller), CallerBefore);
    TestTrue(TEXT("Caller input link survives function rollback"), Call->GetInputsView()[0]->Expression == Source);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialRevision, "DSH.Bridge.MaterialBatch.RevisionCompleteness", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMaterialRevision::RunTest(const FString&)
{
    FMaterialFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    auto* Scalar = Cast<UMaterialExpressionScalarParameter>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Material, nullptr,
        UMaterialExpressionScalarParameter::StaticClass(), nullptr, 0, 0, false));
    Scalar->Enumeration = TSoftObjectPtr<UObject>(FSoftObjectPath(TEXT("/Game/NotLoadedA.NotLoadedA")));
    FString Before = FDSHMaterialOps::Revision(Material);
    Scalar->Enumeration = TSoftObjectPtr<UObject>(FSoftObjectPath(TEXT("/Game/NotLoadedB.NotLoadedB")));
    TestNotEqual(TEXT("Unresolved soft reference paths participate in revision"), FDSHMaterialOps::Revision(Material), Before);
    auto* Data = NewObject<UDSHMaterialBatchTestData>(Material, TEXT("NestedData"), RF_Transactional);
    Data->Labels.Add(TEXT("a"), TEXT("first")); Data->Labels.Add(TEXT("b"), TEXT("second"));
    Data->Tags.Add(TEXT("one")); Data->Tags.Add(TEXT("two"));
    Material->AddAssetUserData(Data);
    Before = FDSHMaterialOps::Revision(Material);
    Data->Labels.Empty(); Data->Labels.Add(TEXT("b"), TEXT("second")); Data->Labels.Add(TEXT("a"), TEXT("first"));
    Data->Tags.Empty(); Data->Tags.Add(TEXT("two")); Data->Tags.Add(TEXT("one"));
    TestEqual(TEXT("Map/set insertion order does not alter revision"), FDSHMaterialOps::Revision(Material), Before);
    Data->Reference = FSoftObjectPath(TEXT("/Game/NestedPath.NestedPath"));
    TestNotEqual(TEXT("Native soft-path struct participates in revision"), FDSHMaterialOps::Revision(Material), Before);
    auto* Custom = Cast<UMaterialExpressionCustom>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Material, nullptr,
        UMaterialExpressionCustom::StaticClass(), nullptr, 0, 0, false));
    Custom->IncludeFilePaths.SetNum(513);
    Before = FDSHMaterialOps::Revision(Material);
    Custom->IncludeFilePaths[512] = TEXT("/Engine/Private/Changed.ush");
    TestNotEqual(TEXT("Arrays larger than display limit remain fully hashed"), FDSHMaterialOps::Revision(Material), Before);
    auto* Layers = NewObject<UMaterialExpressionLayerStack>(Material, NAME_None, RF_Transactional);
    Layers->MaterialExpressionGuid = FGuid::NewGuid();
    Material->GetExpressionCollection().AddExpression(Layers);
    FMaterialFixture FunctionFixture(true);
    Before = FDSHMaterialOps::Revision(Material);
    Layers->AvailableLayers.Add(CastChecked<UMaterialFunction>(FunctionFixture.Asset.Get()));
    TestNotEqual(TEXT("Editable sets participate in revision"), FDSHMaterialOps::Revision(Material), Before);
    return true;
}

#endif
