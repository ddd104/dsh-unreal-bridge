#if WITH_DEV_AUTOMATION_TESTS
#include "DSHEditorSelection.h"
#include "DSHBlueprintOps.h"
#include "AssetRegistry/AssetData.h"
#include "BlueprintEditor.h"
#include "Components/SceneComponent.h"
#include "ContentBrowserModule.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/AutomationTest.h"
#include "Modules/ModuleManager.h"
#include "SSubobjectEditor.h"
#include "Subsystems/AssetEditorSubsystem.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintComponentSelection, "DSH.Bridge.BlueprintComponentSelection", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintComponentSelection::RunTest(const FString&)
{
    FDSHBlueprintOps Ops; FString Code, Error;
    auto Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("assetPath"), TEXT("/Game/DSHBridgeTests/BP_ComponentSelection_") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    Params->SetStringField(TEXT("parent"), TEXT("Actor"));
    const auto Created = Ops.Execute(TEXT("create_blueprint"), Params, Code, Error);
    UBlueprint* Blueprint = Created ? LoadObject<UBlueprint>(nullptr, *Created->GetStringField(TEXT("assetPath"))) : nullptr;
    if (!TestNotNull(TEXT("Actor Blueprint fixture"), Blueprint)) return false;
    USimpleConstructionScript* SCS = Blueprint->SimpleConstructionScript;
    USCS_Node* Root = SCS->CreateNode(USceneComponent::StaticClass(), TEXT("SensorRoot"));
    USCS_Node* Child = SCS->CreateNode(USceneComponent::StaticClass(), TEXT("SensorChild"));
    Root->AddChildNode(Child); SCS->AddNode(Root);
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
    FKismetEditorUtilities::CompileBlueprint(Blueprint);
    Blueprint->bForceFullEditor = true;
    FDSHEditorSelection Tracker; Tracker.Start();
    UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    Editors->OpenEditorForAsset(Blueprint);
    IAssetEditorInstance* Instance = Editors->FindEditorForAsset(Blueprint, false);
    if (!TestNotNull(TEXT("Blueprint editor opened"), Instance)) return false;
    if (!TestEqual(TEXT("Full Blueprint editor"), Instance->GetEditorName(), FName(TEXT("BlueprintEditor")))) return false;
    auto* Editor = static_cast<FBlueprintEditor*>(Instance);
    auto Node = Editor->FindAndSelectSubobjectEditorTreeNode(Root->ComponentTemplate, false);
    if (!TestTrue(TEXT("Selected component through Blueprint Components panel"), Node.IsValid())) return false;
    Tracker.Tick();
    if (!TestEqual(TEXT("One Blueprint component selected"), Tracker.GetSelection().Num(), 1)) return false;
    auto Entry = Tracker.GetSelection()[0]->AsObject();
    TestEqual(TEXT("Component kind"), Entry->GetStringField(TEXT("kind")), FString(TEXT("component")));
    TestEqual(TEXT("Blueprint context"), Entry->GetStringField(TEXT("source")), FString(TEXT("blueprint_editor")));
    TestEqual(TEXT("Template object path"), Entry->GetStringField(TEXT("path")), Root->ComponentTemplate->GetPathName());
    TestEqual(TEXT("Variable name"), Entry->GetStringField(TEXT("componentVariableName")), FString(TEXT("SensorRoot")));
    TestEqual(TEXT("Owning Actor Blueprint"), Entry->GetStringField(TEXT("ownerBlueprintPath")), Blueprint->GetPathName());
    TestFalse(TEXT("Template is not a level instance"), Entry->HasField(TEXT("worldPath")) || Entry->HasField(TEXT("ownerPath")));
    TestFalse(TEXT("Locally defined component is not inherited"), Entry->GetBoolField(TEXT("isInherited")));
    Editor->FindAndSelectSubobjectEditorTreeNode(Child->ComponentTemplate, true); Tracker.Tick();
    TestEqual(TEXT("Multiple Blueprint components"), Tracker.GetSelection().Num(), 2);
    Editor->FindAndSelectSubobjectEditorTreeNode(Child->ComponentTemplate, false); Tracker.Tick();
    if (TestEqual(TEXT("Component switch selects one"), Tracker.GetSelection().Num(), 1))
        TestEqual(TEXT("Component switch updates variable"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("componentVariableName")), FString(TEXT("SensorChild")));
    FDSHEditorSelection Existing; Existing.Start();
    if (TestEqual(TEXT("Startup captures existing Blueprint component"), Existing.GetSelection().Num(), 1))
        TestEqual(TEXT("Existing selection has Blueprint context"), Existing.GetSelection()[0]->AsObject()->GetStringField(TEXT("source")), FString(TEXT("blueprint_editor")));
    Existing.Stop();
    Editors->CloseAllEditorsForAsset(Blueprint); Tracker.Tick();
    TestTrue(TEXT("Closing the current Blueprint clears its selection"), Tracker.GetSelection().IsEmpty());
    Editors->OpenEditorForAsset(Blueprint);
    Editor = static_cast<FBlueprintEditor*>(Editors->FindEditorForAsset(Blueprint, false));
    if (Editor)
    {
        Editor->FindAndSelectSubobjectEditorTreeNode(Root->ComponentTemplate, false); Tracker.Tick();
        auto& Browser = FModuleManager::GetModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
        Browser.GetOnAssetSelectionChanged().Broadcast({FAssetData(Blueprint)}, true); Tracker.Tick();
        Editors->CloseAllEditorsForAsset(Blueprint); Tracker.Tick();
        if (TestEqual(TEXT("Closing an old Blueprint preserves newer Content selection"), Tracker.GetSelection().Num(), 1))
            TestEqual(TEXT("Newer asset remains selected"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("path")), Blueprint->GetPathName());
    }
    return true;
}
#endif
