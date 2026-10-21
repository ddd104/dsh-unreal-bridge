#include "DSHAssetPresentation.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "DSHMaterialOps.h"
#include "EdGraph/EdGraph.h"
#include "Editor.h"
#include "EditorUndoClient.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/DataTable.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Commands/UICommandList.h"
#include "GameFramework/Actor.h"
#include "K2Node_CustomEvent.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "IMaterialEditor.h"
#include "MaterialEditorActions.h"
#include "MaterialEditingLibrary.h"
#include "MaterialGraph/MaterialGraphNode.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionMaterialFunctionCall.h"
#include "Materials/MaterialFunction.h"
#include "Misc/AutomationTest.h"
#include "RHI.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonSerializer.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UObject/Package.h"
#include "UObject/GCObjectScopeGuard.h"
#include "UObject/StrongObjectPtr.h"

namespace DSHAssetPresentationTests
{
UBlueprint* MakeBlueprint()
{
    const FString Name = TEXT("BP_PresentationSafety_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    UPackage* Package = CreatePackage(*(TEXT("/Game/DSHBridgeTests/") + Name));
    Package->SetFlags(RF_Transient);
    return FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Package, FName(*Name),
        BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass(), TEXT("DSHPresentationTests"));
}

struct FTestWorld
{
    UWorld* World = nullptr;
    FTestWorld()
    {
        const FString Name = TEXT("Map_PresentationSafety_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        UPackage* Package = CreatePackage(*(TEXT("/Game/DSHBridgeTests/") + Name));
        Package->SetFlags(RF_Transient);
        const auto Values = UWorld::InitializationValues().CreatePhysicsScene(false).CreateNavigation(false)
            .CreateAISystem(false).ShouldSimulatePhysics(false).AllowAudioPlayback(false);
        World = UWorld::CreateWorld(EWorldType::Inactive, false, FName(*Name), Package, true, ERHIFeatureLevel::Num, &Values);
    }
    ~FTestWorld() { if (World) World->DestroyWorld(false); }
};

UEdGraph* MakeGraph(UBlueprint* Blueprint)
{
    UEdGraph* Graph = NewObject<UEdGraph>(Blueprint, TEXT("PresentationGraph"));
    Blueprint->UbergraphPages.Add(Graph);
    return Graph;
}

struct FMaterialEditorFixture
{
    TObjectPtr<UObject> Asset;
    TUniquePtr<FGCObjectScopeGuard> Guard;
    explicit FMaterialEditorFixture(bool bFunction = false)
    {
        const FString Name = TEXT("MaterialPresentation_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        UPackage* Package = CreatePackage(*(TEXT("/Game/DSHBridgeTests/") + Name));
        Package->SetFlags(RF_Transient);
        if (bFunction) Asset = NewObject<UMaterialFunction>(Package, FName(*Name), RF_Public | RF_Standalone | RF_Transactional);
        else
        {
            UMaterial* Material = NewObject<UMaterial>(Package, FName(*Name), RF_Public | RF_Standalone | RF_Transactional);
            Material->SetShadingModel(MSM_Unlit);
            Asset = Material;
        }
        // MaterialEditor can replace originals in-place when applying a copy.
        // Keep fixtures alive without a StrongObjectPtr reference-count pin,
        // which would independently assert during that engine replacement path.
        Guard = MakeUnique<FGCObjectScopeGuard>(Asset.Get());
        Package->SetDirtyFlag(false);
    }
    ~FMaterialEditorFixture()
    {
        if (GEditor)
            if (UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>())
                for (IAssetEditorInstance* Instance : Editors->FindEditorsForAsset(Asset.Get()))
                    if (Instance) Instance->CloseWindow(EAssetEditorCloseReason::AssetForceDeleted);
        Asset->ClearFlags(RF_Public | RF_Standalone);
        Asset->GetOutermost()->SetDirtyFlag(false);
    }
    IMaterialEditor* Open()
    {
        UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
        if (!Editors || !Editors->OpenEditorForAsset(Asset.Get())) return nullptr;
        IAssetEditorInstance* Instance = Editors->FindEditorForAsset(Asset.Get(), false);
        return Instance && Instance->GetEditorName() == TEXT("MaterialEditor") ? static_cast<IMaterialEditor*>(Instance) : nullptr;
    }
};

bool RequireMaterialEditor(FAutomationTestBase& Test)
{
    if (GEditor && !IsRunningCommandlet() && FSlateApplication::IsInitialized() && !GUsingNullRHI) return true;
    Test.AddError(TEXT("Material presentation regression requires an editor with initialized Slate and a real RHI; it cannot be verified by a commandlet or NullRHI"));
    return false;
}

TSharedPtr<FJsonObject> MaterialPatch(UObject* Asset, const FString& Body, bool bDryRun,
    FString& Code, FString& Message, TSharedPtr<FJsonObject>& Details, FDSHAssetViewHint* Hint = nullptr)
{
    TSharedPtr<FJsonObject> Params;
    if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Body), Params)) return nullptr;
    Params->SetStringField(TEXT("assetPath"), Asset->GetPathName());
    Params->SetStringField(TEXT("baseRevision"), FDSHMaterialOps::Revision(Asset));
    Params->SetBoolField(TEXT("dryRun"), bDryRun);
    return FDSHMaterialOps::Execute(TEXT("material_patch"), Params, Code, Message, Details, Hint);
}

UMaterialExpression* PreviewExpression(IMaterialEditor* Editor, const FString& Id)
{
    FGuid Guid;
    if (!FGuid::Parse(Id, Guid)) return nullptr;
    if (UMaterial* Preview = Cast<UMaterial>(Editor->GetMaterialInterface()))
        for (UMaterialExpression* Expression : Preview->GetExpressions())
            if (Expression && Expression->MaterialExpressionGuid == Guid) return Expression;
    return nullptr;
}

struct FMaterialUndoProbe : FSelfRegisteringEditorUndoClient
{
    int32 Undos = 0;
    int32 Redos = 0;
    virtual void PostUndo(bool bSuccess) override { if (bSuccess) ++Undos; }
    virtual void PostRedo(bool bSuccess) override { if (bSuccess) ++Redos; }
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationResolveTargets, "DSH.Bridge.PresentationSafety.LoadedTargets",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationResolveTargets::RunTest(const FString&)
{
    using namespace DSHAssetPresentationTests;
    TStrongObjectPtr<UBlueprint> Blueprint(MakeBlueprint());
    if (!TestNotNull(TEXT("Blueprint fixture"), Blueprint.Get())) return false;
    UEdGraph* Graph = MakeGraph(Blueprint.Get());
    UK2Node_CustomEvent* Node = NewObject<UK2Node_CustomEvent>(Graph, TEXT("PresentationNode"));
    Graph->AddNode(Node);
    TestTrue(TEXT("Ordinary Blueprint identity is retained"), FDSHAssetPresentation::ResolveSupportedTarget(Blueprint->GetPathName()) == Blueprint.Get());
    TestTrue(TEXT("Package shorthand resolves only the already-loaded asset"), FDSHAssetPresentation::ResolveSupportedTarget(Blueprint->GetOutermost()->GetName()) == Blueprint.Get());
    TestTrue(TEXT("Graph resolves its real owning Blueprint"), FDSHAssetPresentation::ResolveSupportedTarget(Graph->GetPathName()) == Blueprint.Get());
    TestTrue(TEXT("Node resolves its real owning Blueprint"), FDSHAssetPresentation::ResolveSupportedTarget(Node->GetPathName()) == Blueprint.Get());
    TestTrue(TEXT("Ordinary Blueprint does not require a map switch"), FDSHAssetPresentation::CanPresentInWorld(Blueprint.Get(), nullptr));
    UObject* Unknown = NewObject<UDataTable>(GetTransientPackage());
    TestNull(TEXT("Unknown UObject is not auto-opened"), FDSHAssetPresentation::ResolveSupportedTarget(Unknown->GetPathName()));
    const FString Missing = TEXT("/Game/DSHBridgeTests/BP_NotLoaded_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    TestNull(TEXT("An unavailable asset is skipped"), FDSHAssetPresentation::ResolveSupportedTarget(Missing));
    TestNull(TEXT("Presentation did not load its package"), FindPackage(nullptr, *Missing));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationLevelOwnership, "DSH.Bridge.PresentationSafety.LevelOwnership",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationLevelOwnership::RunTest(const FString&)
{
    using namespace DSHAssetPresentationTests;
    FTestWorld Owner, Other;
    if (!TestNotNull(TEXT("Owner world"), Owner.World) || !TestNotNull(TEXT("Other world"), Other.World)) return false;
    ULevelScriptBlueprint* Blueprint = Owner.World->PersistentLevel->GetLevelScriptBlueprint(false);
    if (!TestNotNull(TEXT("Level Blueprint fixture"), Blueprint)) return false;
    UEdGraph* Graph = MakeGraph(Blueprint);
    UK2Node_CustomEvent* Node = NewObject<UK2Node_CustomEvent>(Graph, TEXT("LevelPresentationNode"));
    Graph->AddNode(Node);
    Owner.World->GetOutermost()->SetDirtyFlag(false);
    UWorld* Current = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    TestTrue(TEXT("Level Blueprint keeps its exact subobject identity"), FDSHAssetPresentation::ResolveSupportedTarget(Blueprint->GetPathName()) == Blueprint);
    TestTrue(TEXT("Level graph keeps the owning level Blueprint"), FDSHAssetPresentation::ResolveSupportedTarget(Graph->GetPathName()) == Blueprint);
    TestTrue(TEXT("Level node keeps the owning level Blueprint"), FDSHAssetPresentation::ResolveSupportedTarget(Node->GetPathName()) == Blueprint);
    TestNull(TEXT("World object is never a presentation target"), FDSHAssetPresentation::ResolveSupportedTarget(Owner.World->GetPathName()));
    TestNull(TEXT("World package is never a presentation target"), FDSHAssetPresentation::ResolveSupportedTarget(Owner.World->GetOutermost()->GetName()));
    TestNull(TEXT("Level object is never a presentation target"), FDSHAssetPresentation::ResolveSupportedTarget(Owner.World->PersistentLevel->GetPathName()));
    TestTrue(TEXT("A Blueprint belonging to the current world is eligible"), FDSHAssetPresentation::CanPresentInWorld(Blueprint, Owner.World));
    TestFalse(TEXT("A changed current world makes the same Blueprint ineligible"), FDSHAssetPresentation::CanPresentInWorld(Blueprint, Other.World));
    TestFalse(TEXT("No current editor world cannot authorize opening a level"), FDSHAssetPresentation::CanPresentInWorld(Blueprint, nullptr));
    FDSHAssetViewHint Hint;
    Hint.AssetPath = Blueprint->GetPathName();
    Hint.Graph = Graph->GetPathName();
    FDSHAssetPresentation Presentation;
    Presentation.Queue(Hint);
    Hint.AssetPath = Owner.World->GetPathName();
    Presentation.Queue(Hint);
    Presentation.Tick(); Presentation.Tick();
    TestTrue(TEXT("Foreign level presentation does not switch the editor world"), !GEditor || GEditor->GetEditorWorldContext().World() == Current);
    TestFalse(TEXT("Skipped presentation does not dirty the map"), Owner.World->GetOutermost()->IsDirty());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationInvalidatedTarget, "DSH.Bridge.PresentationSafety.InvalidatedTarget",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationInvalidatedTarget::RunTest(const FString&)
{
    const FString Name = TEXT("BP_InvalidPresentation_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    UPackage* Package = CreatePackage(*(TEXT("/Game/DSHBridgeTests/") + Name));
    Package->SetFlags(RF_Transient);
    UBlueprint* Blueprint = NewObject<UBlueprint>(Package, FName(*Name));
    TWeakObjectPtr<UObject> Weak = Blueprint;
    FDSHAssetViewHint Hint; Hint.AssetPath = Blueprint->GetPathName();
    FDSHAssetPresentation Presentation;
    Presentation.Queue(Hint);
    Blueprint->MarkAsGarbage();
    TestFalse(TEXT("Queued identity becomes invalid"), Weak.IsValid());
    TestNull(TEXT("Invalid identity is not reloaded from its old path"), FDSHAssetPresentation::ResolveSupportedTarget(Hint.AssetPath));
    Presentation.Tick(); Presentation.Tick();
    TestFalse(TEXT("The queued target remains invalid after both stages"), Weak.IsValid());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationOpensOnce, "DSH.Bridge.PresentationSafety.OpensOnce",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationOpensOnce::RunTest(const FString&)
{
    if (!GEditor || IsRunningCommandlet() || !FSlateApplication::IsInitialized()) return true;
    using namespace DSHAssetPresentationTests;
    TStrongObjectPtr<UBlueprint> Blueprint(MakeBlueprint());
    if (!TestNotNull(TEXT("Editor fixture"), Blueprint.Get())) return false;
    UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    if (!TestNotNull(TEXT("Editor subsystem"), Editors)) return false;
    int32 Opens = 0;
    const FDelegateHandle Observer = Editors->OnAssetEditorOpened().AddLambda([&](UObject* Asset) { if (Asset == Blueprint.Get()) ++Opens; });
    FDSHAssetViewHint Hint; Hint.AssetPath = Blueprint->GetPathName();
    FDSHAssetPresentation Presentation;
    Presentation.Queue(Hint); Presentation.Queue(Hint);
    Presentation.Tick();
    TestEqual(TEXT("Duplicate queued hints open one editor"), Opens, 1);
    Editors->CloseAllEditorsForAsset(Blueprint.Get());
    Presentation.Tick();
    TestEqual(TEXT("Focus stage never reopens an editor closed between frames"), Opens, 1);
    Presentation.Queue(Hint); Presentation.Tick(); Presentation.Tick();
    TestEqual(TEXT("A new request can open once, then focus without another open"), Opens, 2);
    Editors->OnAssetEditorOpened().Remove(Observer);
    Editors->CloseAllEditorsForAsset(Blueprint.Get());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationMaterialSync, "DSH.Bridge.PresentationSafety.MaterialEditorSync",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationMaterialSync::RunTest(const FString&)
{
    using namespace DSHAssetPresentationTests;
    if (!RequireMaterialEditor(*this)) return false;
    FMaterialEditorFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    IMaterialEditor* Editor = Fixture.Open();
    if (!TestNotNull(TEXT("Real Material Editor opened before native nodes exist"), Editor)) return false;
    UMaterialInterface* EmptyPreview = Editor->GetMaterialInterface();
    TestTrue(TEXT("The editor owns a separate preview copy"), EmptyPreview != Material);
    const TCHAR* Batch = TEXT(R"JSON({"operations":[
      {"op":"add","id":"value","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.4},"position":{"x":-600,"y":0}},
      {"op":"add","id":"multiply","expressionClass":"/Script/Engine.MaterialExpressionMultiply","properties":{"ConstB":0.5},"position":{"x":-300,"y":0}},
      {"op":"connect","from":{"id":"value","pin":0},"to":{"id":"multiply","pin":"A"}},
      {"op":"output","from":{"id":"multiply","pin":0},"property":"MP_EmissiveColor"}
    ]})JSON");
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    FDSHAssetViewHint Hint; Hint.AssetPath = Material->GetPathName();
    auto Result = MaterialPatch(Material, Batch, true, Code, Message, Details, &Hint);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestTrue(TEXT("Dry-run retains the editor copy"), Editor->GetMaterialInterface() == EmptyPreview);
    TestEqual(TEXT("Dry-run leaves the visible graph empty"), CastChecked<UMaterial>(Editor->GetMaterialInterface())->GetExpressions().Num(), 0);
    TestTrue(TEXT("Dry-run clears any stale presentation hint"), Hint.AssetPath.IsEmpty());
    TestFalse(TEXT("Dry-run preserves original package cleanliness"), Material->GetOutermost()->IsDirty());

    Result = MaterialPatch(Material, Batch, false, Code, Message, Details, &Hint);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestTrue(TEXT("Commit synchronizes the editor before deferred navigation"), Editor->GetMaterialInterface() != EmptyPreview);
    TestEqual(TEXT("Both committed expressions are visible in the preview graph"), CastChecked<UMaterial>(Editor->GetMaterialInterface())->GetExpressions().Num(), 2);
    const auto Ids = Result->GetObjectField(TEXT("nodeMap"));
    UMaterialExpression* Value = PreviewExpression(Editor, Ids->GetStringField(TEXT("value")));
    UMaterialExpression* Multiply = PreviewExpression(Editor, Ids->GetStringField(TEXT("multiply")));
    if (!TestNotNull(TEXT("Value GUID resolves in preview"), Value) || !TestNotNull(TEXT("Multiply GUID resolves in preview"), Multiply)) return false;
    TestNotNull(TEXT("Value has a real editor graph node"), Value->GraphNode.Get());
    TestNotNull(TEXT("Multiply has a real editor graph node"), Multiply->GraphNode.Get());
    TestFalse(TEXT("Focus target is not an original-asset expression pointer"), Material->GetExpressions().Contains(Value));
    FDSHAssetPresentation Presentation;
    Presentation.Queue(Hint); Presentation.Tick(); Presentation.Tick();
    const TSet<UObject*> Selection = Editor->GetSelectedNodes();
    TestTrue(TEXT("Batch focus selects the value by native hyphenated GUID"), Selection.Contains(Value->GraphNode));
    TestTrue(TEXT("Batch focus selects the multiply in the same editor graph"), Selection.Contains(Multiply->GraphNode));
    TestTrue(TEXT("Applied but unsaved asset remains eligible"), FDSHAssetPresentation::CanEditMaterialAsset(Material, Message));

    const FString EditValue = FString::Printf(TEXT(R"JSON({"operations":[{"op":"set","id":"%s","properties":{"R":0.8}}]})JSON"), *Ids->GetStringField(TEXT("value")));
    Result = MaterialPatch(Material, EditValue, false, Code, Message, Details, &Hint);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    Value = PreviewExpression(Editor, Ids->GetStringField(TEXT("value")));
    if (!TestNotNull(TEXT("Value survives second synchronization"), Value)) return false;
    TestEqual(TEXT("Existing preview properties update as well as new nodes"), CastChecked<UMaterialExpressionConstant>(Value)->R, .8f);
    UMaterialInterface* UpdatedPreview = Editor->GetMaterialInterface();
    Result = MaterialPatch(Material, EditValue, false, Code, Message, Details, &Hint);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    TestTrue(TEXT("A no-op patch does not recreate the editor copy"), Editor->GetMaterialInterface() == UpdatedPreview);
    Result = MaterialPatch(Material, TEXT(R"JSON({"operations":[{"op":"delete","id":"missing"}]})JSON"), false, Code, Message, Details, &Hint);
    TestFalse(TEXT("Invalid native operation is refused"), Result.IsValid());
    TestTrue(TEXT("Failed patch leaves the visible graph copy intact"), Editor->GetMaterialInterface() == UpdatedPreview);
    TestTrue(TEXT("Failed patch has no presentation hint"), Hint.AssetPath.IsEmpty());

    const auto ApplyCommand = FMaterialEditorCommands::Get().Apply;
    const FUIAction SavedApply = *Editor->GetToolkitCommands()->GetActionForCommand(ApplyCommand);
    Editor->GetToolkitCommands()->UnmapAction(ApplyCommand);
    Result = MaterialPatch(Material, EditValue, false, Code, Message, Details, &Hint);
    TestFalse(TEXT("Unknown editor state is not assumed clean"), Result.IsValid());
    TestEqual(TEXT("Unknown state has an actionable conflict code"), Code, FString(TEXT("MATERIAL_EDITOR_CONFLICT")));
    Editor->GetToolkitCommands()->MapAction(ApplyCommand, SavedApply);

    auto* Manual = Cast<UMaterialExpressionConstant>(Editor->CreateNewMaterialExpression(UMaterialExpressionConstant::StaticClass(), FVector2D(-900, 300), false, false));
    if (!TestNotNull(TEXT("Manual editor-only expression fixture"), Manual)) return false;
    Manual->R = .91f;
    Editor->MarkMaterialDirty();
    UMaterialInterface* DirtyPreview = Editor->GetMaterialInterface();
    const FString OriginalRevision = FDSHMaterialOps::Revision(Material);
    FDSHAssetViewHint LateHint;
    LateHint.AssetPath = Material->GetPathName();
    LateHint.NodeIds.Add(Ids->GetStringField(TEXT("value")));
    Presentation.Queue(LateHint); Presentation.Tick(); Presentation.Tick();
    TestTrue(TEXT("Deferred navigation never refreshes a newly dirtied preview"), Editor->GetMaterialInterface() == DirtyPreview);
    TestTrue(TEXT("Manual edits survive deferred batch focus"), CastChecked<UMaterial>(DirtyPreview)->GetExpressions().Contains(Manual));
    Result = MaterialPatch(Material, EditValue, false, Code, Message, Details, &Hint);
    TestFalse(TEXT("Commit refuses unapplied editor changes"), Result.IsValid());
    TestEqual(TEXT("Dirty editor conflict is explicit"), Code, FString(TEXT("MATERIAL_EDITOR_CONFLICT")));
    TestEqual(TEXT("Conflict occurs before original writes"), Details->GetStringField(TEXT("execution")), FString(TEXT("not_started")));
    TestEqual(TEXT("Conflict preserves the original authored state"), FDSHMaterialOps::Revision(Material), OriginalRevision);
    TestTrue(TEXT("Rejected commit retains the dirty editor copy"), Editor->GetMaterialInterface() == DirtyPreview);
    TestTrue(TEXT("Manual node remains in the editable graph"), CastChecked<UMaterial>(DirtyPreview)->GetExpressions().Contains(Manual));
    TestEqual(TEXT("Manual node property survives"), Manual->R, .91f);
    TestTrue(TEXT("Rejected commit has no presentation hint"), Hint.AssetPath.IsEmpty());
    TestFalse(TEXT("Direct refresh also refuses the dirty copy"), FDSHAssetPresentation::RefreshOpenMaterialEditors(Material, Message));
    Result = MaterialPatch(Material, EditValue, true, Code, Message, Details, &Hint);
    TestTrue(TEXT("Dry-run may still validate the original without editing the pending copy"), Result.IsValid());
    TestTrue(TEXT("Dry-run does not discard unapplied changes"), Editor->GetMaterialInterface() == DirtyPreview);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationMaterialUndoRedo, "DSH.Bridge.PresentationSafety.MaterialEditorUndoRedo",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationMaterialUndoRedo::RunTest(const FString&)
{
    using namespace DSHAssetPresentationTests;
    if (!RequireMaterialEditor(*this)) return false;
    FMaterialEditorFixture Fixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    IMaterialEditor* Editor = Fixture.Open();
    if (!TestNotNull(TEXT("Material Editor is open before the native transaction"), Editor)) return false;
    const FString Before = FDSHMaterialOps::Revision(Material);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = MaterialPatch(Material, TEXT(R"JSON({"operations":[
      {"op":"add","id":"value","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.4}},
      {"op":"output","from":{"id":"value","pin":0},"property":"MP_EmissiveColor"}
    ]})JSON"), false, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    const FString After = FDSHMaterialOps::Revision(Material);
    const FString Id = Result->GetObjectField(TEXT("nodeMap"))->GetStringField(TEXT("value"));
    TestNotEqual(TEXT("Native transaction changes original authored state"), After, Before);
    TestNotNull(TEXT("Committed expression is visible before Undo"), PreviewExpression(Editor, Id));
    TestTrue(TEXT("Native transaction can be undone with its editor open"), GEditor->UndoTransaction());
    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
    TestEqual(TEXT("Undo restores original state instead of applying the stale preview back"), FDSHMaterialOps::Revision(Material), Before);
    TestEqual(TEXT("Undo removes committed nodes from the original"), Material->GetExpressions().Num(), 0);
    TestEqual(TEXT("Undo also updates the visible editor copy"), CastChecked<UMaterial>(Editor->GetMaterialInterface())->GetExpressions().Num(), 0);
    TestTrue(TEXT("Native transaction can be redone"), GEditor->RedoTransaction());
    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
    TestEqual(TEXT("Redo restores committed original state"), FDSHMaterialOps::Revision(Material), After);
    TestEqual(TEXT("Redo restores original expression count"), Material->GetExpressions().Num(), 1);
    UMaterialExpression* Visible = PreviewExpression(Editor, Id);
    if (TestNotNull(TEXT("Redo restores the same GUID in the visible editor copy"), Visible))
        TestNotNull(TEXT("Redone expression has a real graph node"), Visible->GraphNode.Get());
    TestTrue(TEXT("Undo and Redo do not invent unapplied manual edits"), FDSHAssetPresentation::CanEditMaterialAsset(Material, Message));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationMaterialUndoIsolation, "DSH.Bridge.PresentationSafety.MaterialUndoIsolation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationMaterialUndoIsolation::RunTest(const FString&)
{
    using namespace DSHAssetPresentationTests;
    if (!RequireMaterialEditor(*this)) return false;
    FMaterialEditorFixture Fixture, UnrelatedFixture;
    UMaterial* Material = CastChecked<UMaterial>(Fixture.Asset.Get());
    UMaterial* Unrelated = CastChecked<UMaterial>(UnrelatedFixture.Asset.Get());
    auto* UnrelatedSource = CastChecked<UMaterialExpressionConstant>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Unrelated, nullptr,
        UMaterialExpressionConstant::StaticClass(), nullptr, 0, 0, false));
    UnrelatedSource->R = .2f;
    IMaterialEditor* Editor = Fixture.Open();
    IMaterialEditor* UnrelatedEditor = UnrelatedFixture.Open();
    if (!TestNotNull(TEXT("Undo target editor"), Editor) || !TestNotNull(TEXT("Unrelated editor"), UnrelatedEditor)) return false;
    auto* UnrelatedManual = Cast<UMaterialExpressionConstant>(PreviewExpression(UnrelatedEditor, UnrelatedSource->MaterialExpressionGuid.ToString()));
    if (!TestNotNull(TEXT("Unrelated preview expression"), UnrelatedManual)) return false;
    UnrelatedManual->R = .91f;
    UnrelatedEditor->MarkMaterialDirty();
    UMaterialInterface* UnrelatedPreview = UnrelatedEditor->GetMaterialInterface();
    const FString UnrelatedBefore = FDSHMaterialOps::Revision(Unrelated);
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = MaterialPatch(Material, TEXT(R"JSON({"operations":[
      {"op":"add","id":"value","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.4}},
      {"op":"output","from":{"id":"value","pin":0},"property":"MP_EmissiveColor"}
    ]})JSON"), false, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    const FString Id = Result->GetObjectField(TEXT("nodeMap"))->GetStringField(TEXT("value"));
    FMaterialUndoProbe Probe;
    int32 ViewNotifications = 0;
    const FDelegateHandle ViewHandle = FEditorDelegates::PostUndoRedo.AddLambda([&]() { ++ViewNotifications; });
    const bool bOriginalSuspend = GEditor->bSuspendBroadcastPostUndoRedo;
    GEditor->bSuspendBroadcastPostUndoRedo = false;
    TestTrue(TEXT("Native Undo succeeds with an unrelated dirty editor open"), GEditor->UndoTransaction());
    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
    TestEqual(TEXT("Native Undo does not call legacy material undo clients"), Probe.Undos, 0);
    TestEqual(TEXT("Native Undo still notifies ordinary views once"), ViewNotifications, 1);
    TestFalse(TEXT("Native Undo restores an initially clear suppression flag"), GEditor->bSuspendBroadcastPostUndoRedo);
    TestEqual(TEXT("Unrelated original is not auto-Applied by native Undo"), FDSHMaterialOps::Revision(Unrelated), UnrelatedBefore);
    TestTrue(TEXT("Unrelated dirty preview identity is retained"), UnrelatedEditor->GetMaterialInterface() == UnrelatedPreview);
    TestEqual(TEXT("Unrelated pending value survives native Undo"), UnrelatedManual->R, .91f);
    TestFalse(TEXT("Unrelated editor still has its pending changes"), FDSHAssetPresentation::CanEditMaterialAsset(Unrelated, Message));

    GEditor->bSuspendBroadcastPostUndoRedo = true;
    TestTrue(TEXT("Native Redo succeeds under an existing suppression owner"), GEditor->RedoTransaction());
    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
    TestTrue(TEXT("Existing suppression ownership survives native Redo"), GEditor->bSuspendBroadcastPostUndoRedo);
    TestEqual(TEXT("Existing suppression also suppresses replacement view notifications"), ViewNotifications, 1);
    TestEqual(TEXT("Native Redo does not call legacy material undo clients"), Probe.Redos, 0);
    GEditor->bSuspendBroadcastPostUndoRedo = false;

    auto* PendingTarget = Cast<UMaterialExpressionConstant>(PreviewExpression(Editor, Id));
    if (!PendingTarget)
    {
        FEditorDelegates::PostUndoRedo.Remove(ViewHandle);
        GEditor->bSuspendBroadcastPostUndoRedo = bOriginalSuspend;
        AddError(TEXT("Redone target preview is missing"));
        return false;
    }
    PendingTarget->R = .87f;
    Editor->MarkMaterialDirty();
    UMaterialInterface* PendingPreview = Editor->GetMaterialInterface();
    AddExpectedMessage(TEXT("DSH material Undo/Redo restored the asset, but its editor view was not synchronized"),
        ELogVerbosity::Warning, EAutomationExpectedMessageFlags::Contains, 1);
    TestTrue(TEXT("Native Undo can restore the asset while manual preview changes are pending"), GEditor->UndoTransaction());
    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
    TestEqual(TEXT("Pending preview cannot overwrite the undone original"), Material->GetExpressions().Num(), 0);
    TestTrue(TEXT("Pending target editor copy is preserved rather than discarded"), Editor->GetMaterialInterface() == PendingPreview);
    TestEqual(TEXT("Pending target property is preserved"), PendingTarget->R, .87f);
    TestFalse(TEXT("An unsynchronized editor remains explicitly conflicted"), FDSHAssetPresentation::CanEditMaterialAsset(Material, Message));
    TestEqual(TEXT("Unrelated original remains untouched after another native Undo"), FDSHMaterialOps::Revision(Unrelated), UnrelatedBefore);

    // Close only our disposable dirty test windows before exercising ordinary
    // engine Undo, whose existing MaterialEditor behavior is not altered here.
    Editor->CloseWindow(EAssetEditorCloseReason::AssetForceDeleted);
    UnrelatedEditor->CloseWindow(EAssetEditorCloseReason::AssetForceDeleted);
    TStrongObjectPtr<UEdGraph> Ordinary(NewObject<UEdGraph>(GetTransientPackage(), NAME_None, RF_Transactional));
    {
        FScopedTransaction Transaction(TEXT("DSH.Test.Ordinary"), NSLOCTEXT("DSHUnrealBridge", "OrdinaryUndoProbe", "Ordinary Undo probe"), Ordinary.Get());
        Ordinary->Modify();
        Ordinary->bEditable = false;
    }
    TestTrue(TEXT("Unrelated ordinary transaction can be undone"), GEditor->UndoTransaction());
    TestEqual(TEXT("Ordinary Undo still reaches registered clients"), Probe.Undos, 1);
    TestTrue(TEXT("Ordinary transaction value is restored"), Ordinary->bEditable);
    TestFalse(TEXT("Ordinary Undo leaves the suppression flag unchanged"), GEditor->bSuspendBroadcastPostUndoRedo);
    FEditorDelegates::PostUndoRedo.Remove(ViewHandle);
    GEditor->bSuspendBroadcastPostUndoRedo = bOriginalSuspend;
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHPresentationMaterialFunctionSync, "DSH.Bridge.PresentationSafety.MaterialFunctionEditorSync",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHPresentationMaterialFunctionSync::RunTest(const FString&)
{
    using namespace DSHAssetPresentationTests;
    if (!RequireMaterialEditor(*this)) return false;
    FMaterialEditorFixture FunctionFixture(true), CallerFixture;
    UMaterialFunction* Function = CastChecked<UMaterialFunction>(FunctionFixture.Asset.Get());
    UMaterial* Caller = CastChecked<UMaterial>(CallerFixture.Asset.Get());
    FString Code, Message; TSharedPtr<FJsonObject> Details;
    auto Result = MaterialPatch(Function, TEXT(R"JSON({"operations":[
      {"op":"add","id":"value","expressionClass":"/Script/Engine.MaterialExpressionConstant","properties":{"R":0.3}},
      {"op":"add","id":"out","expressionClass":"/Script/Engine.MaterialExpressionFunctionOutput","properties":{"OutputName":"Result"}},
      {"op":"connect","from":{"id":"value","pin":0},"to":{"id":"out","pin":0}}
    ]})JSON"), false, Code, Message, Details);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    const FString ValueId = Result->GetObjectField(TEXT("nodeMap"))->GetStringField(TEXT("value"));
    auto* Call = CastChecked<UMaterialExpressionMaterialFunctionCall>(UMaterialEditingLibrary::CreateMaterialExpressionEx(Caller, nullptr,
        UMaterialExpressionMaterialFunctionCall::StaticClass(), nullptr, 0, 0, false));
    if (!TestTrue(TEXT("Caller binds function"), Call->SetMaterialFunction(Function))) return false;
    Caller->GetExpressionInputForProperty(MP_EmissiveColor)->Connect(0, Call);
    IMaterialEditor* FunctionEditor = FunctionFixture.Open();
    IMaterialEditor* CallerEditor = CallerFixture.Open();
    if (!TestNotNull(TEXT("Function editor fixture"), FunctionEditor) || !TestNotNull(TEXT("Caller editor fixture"), CallerEditor)) return false;
    auto* Manual = Cast<UMaterialExpressionConstant>(CallerEditor->CreateNewMaterialExpression(UMaterialExpressionConstant::StaticClass(), FVector2D(-500, 250), false, false));
    if (!TestNotNull(TEXT("Pending caller-only node"), Manual)) return false;
    Manual->R = .73f;
    CallerEditor->MarkMaterialDirty();
    UMaterialInterface* CallerPreview = CallerEditor->GetMaterialInterface();
    const FString CallerRevision = FDSHMaterialOps::Revision(Caller);
    const FString FunctionBefore = FDSHMaterialOps::Revision(Function);
    FDSHAssetViewHint Hint;
    Result = MaterialPatch(Function, FString::Printf(TEXT(R"JSON({"operations":[{"op":"set","id":"%s","properties":{"R":0.6}}]})JSON"), *ValueId),
        false, Code, Message, Details, &Hint);
    if (!TestTrue(*Message, Result.IsValid())) return false;
    UMaterialExpression* Updated = PreviewExpression(FunctionEditor, ValueId);
    if (!TestNotNull(TEXT("Function expression resolved in its refreshed preview"), Updated)) return false;
    TestEqual(TEXT("Function editor shows the committed value"), CastChecked<UMaterialExpressionConstant>(Updated)->R, .6f);
    TestNotNull(TEXT("Function expression has an editor graph node"), Updated->GraphNode.Get());
    FDSHAssetPresentation Presentation;
    Presentation.Queue(Hint); Presentation.Tick(); Presentation.Tick();
    TestTrue(TEXT("Function focus selects the refreshed preview node"), FunctionEditor->GetSelectedNodes().Contains(Updated->GraphNode));
    TestTrue(TEXT("Dependent shader refresh does not replace the dirty caller graph"), CallerEditor->GetMaterialInterface() == CallerPreview);
    TestTrue(TEXT("Pending caller expression survives function patch"), CastChecked<UMaterial>(CallerPreview)->GetExpressions().Contains(Manual));
    TestEqual(TEXT("Pending caller properties survive"), Manual->R, .73f);
    TestEqual(TEXT("Function edit leaves caller authored state unchanged"), FDSHMaterialOps::Revision(Caller), CallerRevision);
    TestFalse(TEXT("Caller still reports unapplied changes"), FDSHAssetPresentation::CanEditMaterialAsset(Caller, Message));
    TestTrue(TEXT("Function edit can be undone with a dirty caller editor open"), GEditor->UndoTransaction());
    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
    TestEqual(TEXT("Function Undo restores original authored state"), FDSHMaterialOps::Revision(Function), FunctionBefore);
    UMaterialExpression* Undone = PreviewExpression(FunctionEditor, ValueId);
    if (TestNotNull(TEXT("Undone function expression remains visible"), Undone))
        TestEqual(TEXT("Function Undo refreshes the visible value"), CastChecked<UMaterialExpressionConstant>(Undone)->R, .3f);
    TestEqual(TEXT("Function Undo cannot Apply unrelated pending caller changes"), FDSHMaterialOps::Revision(Caller), CallerRevision);
    TestTrue(TEXT("Function Undo retains the dirty caller preview"), CallerEditor->GetMaterialInterface() == CallerPreview);
    TestEqual(TEXT("Function Undo retains the pending caller property"), Manual->R, .73f);
    return true;
}
#endif
