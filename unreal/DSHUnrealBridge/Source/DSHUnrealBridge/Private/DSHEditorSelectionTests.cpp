#if WITH_DEV_AUTOMATION_TESTS
#include "DSHEditorSelection.h"
#include "AssetRegistry/AssetData.h"
#include "Components/SceneComponent.h"
#include "ContentBrowserModule.h"
#include "DSHBlueprintOps.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Misc/AutomationTest.h"
#include "Modules/ModuleManager.h"
#include "Selection.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHLevelSelection, "DSH.Bridge.LevelSelection", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHLevelSelection::RunTest(const FString&)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!TestNotNull(TEXT("Editor world exists"), World)) return false;
    USelection* Actors = GEditor->GetSelectedActors();
    USelection* Components = GEditor->GetSelectedComponents();
    TArray<UObject*> PreviousActors, PreviousComponents;
    Actors->GetSelectedObjects(PreviousActors); Components->GetSelectedObjects(PreviousComponents);
    const bool bWasDirty = World->GetOutermost()->IsDirty();
    FActorSpawnParameters Spawn; Spawn.ObjectFlags = RF_Transient;
    AActor* Actor = World->SpawnActor<AActor>(Spawn);
    AActor* Other = World->SpawnActor<AActor>(Spawn);
    if (!TestNotNull(TEXT("Create selection fixture actor"), Actor) || !TestNotNull(TEXT("Create multiselection actor"), Other)) return false;
    Actor->SetActorLabel(TEXT("DSH selection actor"));
    USceneComponent* Component = NewObject<USceneComponent>(Actor, TEXT("SelectionComponent"), RF_Transient);
    Actor->AddInstanceComponent(Component); Component->RegisterComponent();
    Actors->DeselectAll(); Components->DeselectAll();
    FDSHEditorSelection Tracker; Tracker.Start();
    auto& Browser = FModuleManager::GetModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
    FDSHBlueprintOps Ops; FString Code, Error;
    auto Create = MakeShared<FJsonObject>();
    Create->SetStringField(TEXT("assetPath"), TEXT("/Game/DSHBridgeTests/BP_Selection_") + FGuid::NewGuid().ToString(EGuidFormats::Digits));
    Create->SetStringField(TEXT("parent"), TEXT("Actor"));
    const auto Created = Ops.Execute(TEXT("create_blueprint"), Create, Code, Error);
    UBlueprint* Blueprint = Created ? LoadObject<UBlueprint>(nullptr, *Created->GetStringField(TEXT("assetPath"))) : nullptr;
    auto Check = [this, &Tracker](const TCHAR* Kind, const UObject* Object)
    {
        if (!TestEqual(TEXT("Exactly one selected item"), Tracker.GetSelection().Num(), 1)) return;
        const auto Entry = Tracker.GetSelection()[0]->AsObject();
        TestEqual(TEXT("Selection kind"), Entry->GetStringField(TEXT("kind")), FString(Kind));
        TestEqual(TEXT("Live instance path"), Entry->GetStringField(TEXT("path")), Object->GetPathName());
    };
    if (TestNotNull(TEXT("Blueprint fixture exists"), Blueprint))
    {
        Browser.GetOnAssetSelectionChanged().Broadcast({FAssetData(Blueprint)}, true); Tracker.Tick();
        TestEqual(TEXT("Content selection reaches tracker"), Tracker.GetSelection().Num(), 1);
        TestEqual(TEXT("Content asset path"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("path")), Blueprint->GetPathName());
        // A single object notification must work without NoteSelectionChange.
        Actors->Select(Actor); TestTrue(TEXT("Actor notification changes selection"), Tracker.Tick()); Check(TEXT("actor"), Actor);
        TestEqual(TEXT("Actor display label"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("label")), Actor->GetActorLabel());
        TestFalse(TEXT("Native actor has no Blueprint path"), Tracker.GetSelection()[0]->AsObject()->HasField(TEXT("blueprintPath")));
        Actors->Select(Other); Tracker.Tick(); TestEqual(TEXT("Multiple actors"), Tracker.GetSelection().Num(), 2);
        Components->Select(Component); Tracker.Tick(); Check(TEXT("component"), Component);
        TestEqual(TEXT("Component identifies its owner"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("ownerPath")), Actor->GetPathName());
        Components->DeselectAll(); Actors->DeselectAll(); Tracker.Tick();
        TestTrue(TEXT("Clearing level selection does not restore content asset"), Tracker.GetSelection().IsEmpty());
        // The viewport API disables legacy notifications; the typed event is essential.
        GEditor->SelectActor(Actor, true, true); Tracker.Tick(); Check(TEXT("actor"), Actor);
        GEditor->SelectComponent(Component, true, true); Tracker.Tick(); Check(TEXT("component"), Component);
        Components->DeselectAll(); Actors->DeselectAll(); Tracker.Tick();
        FActorSpawnParameters BlueprintSpawn; BlueprintSpawn.ObjectFlags = RF_Transient;
        AActor* BlueprintActor = World->SpawnActor<AActor>(Blueprint->GeneratedClass, BlueprintSpawn);
        if (TestNotNull(TEXT("Blueprint actor fixture"), BlueprintActor))
        {
            Actors->Select(BlueprintActor); Tracker.Tick(); Check(TEXT("actor"), BlueprintActor);
            TestEqual(TEXT("Actor identifies Blueprint separately"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("blueprintPath")), Blueprint->GetPathName());
            USceneComponent* Owned = NewObject<USceneComponent>(BlueprintActor, TEXT("Owned"), RF_Transient);
            BlueprintActor->AddInstanceComponent(Owned); Owned->RegisterComponent();
            Components->Select(Owned); Tracker.Tick(); Check(TEXT("component"), Owned);
            TestEqual(TEXT("Native component retains owner Blueprint path"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("ownerBlueprintPath")), Blueprint->GetPathName());
            FDSHEditorSelection Reconnected; Reconnected.Start();
            TestEqual(TEXT("Startup captures existing level selection"), Reconnected.GetSelection().Num(), 1);
            Reconnected.Stop(); Components->DeselectAll(); Actors->DeselectAll(); World->DestroyActor(BlueprintActor);
        }
        Browser.GetOnAssetSelectionChanged().Broadcast({FAssetData(Blueprint)}, true); Tracker.Tick();
        TestEqual(TEXT("Returning to content replaces level context"), Tracker.GetSelection()[0]->AsObject()->GetStringField(TEXT("path")), Blueprint->GetPathName());
        Actors->NoteSelectionChanged(); Tracker.Tick();
        TestTrue(TEXT("Empty level selection clears asset context"), Tracker.GetSelection().IsEmpty());
    }
    Tracker.Stop();
    Actors->Select(Actor); TestFalse(TEXT("Stop removes delegates"), Tracker.Tick());
    Actors->DeselectAll(); Components->DeselectAll();
    for (UObject* Previous : PreviousActors) if (IsValid(Previous)) Actors->Select(Previous);
    for (UObject* Previous : PreviousComponents) if (IsValid(Previous)) Components->Select(Previous);
    World->DestroyActor(Actor); World->DestroyActor(Other); World->GetOutermost()->SetDirtyFlag(bWasDirty);
    return true;
}
#endif
