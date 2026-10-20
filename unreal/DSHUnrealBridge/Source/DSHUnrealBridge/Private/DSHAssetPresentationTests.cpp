#include "DSHAssetPresentation.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "EdGraph/EdGraph.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/DataTable.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/Actor.h"
#include "K2Node_CustomEvent.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/AutomationTest.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UObject/Package.h"
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
#endif
