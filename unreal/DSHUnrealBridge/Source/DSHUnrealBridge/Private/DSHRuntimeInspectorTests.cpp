#include "DSHRuntimeInspector.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Components/SceneComponent.h"
#include "DSHEditorSelection.h"
#include "Editor.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Misc/AutomationTest.h"
#include "Selection.h"
#include "UObject/Package.h"

namespace
{
// Temporary worlds have real engine world contexts, but never start a game or touch project assets.
struct FRuntimeTestWorld
{
    UWorld* World = nullptr;
    explicit FRuntimeTestWorld(EWorldType::Type Type, int32 Instance = 0)
    {
        const UWorld::InitializationValues Values = UWorld::InitializationValues().CreatePhysicsScene(false)
            .CreateNavigation(false).CreateAISystem(false).ShouldSimulatePhysics(false).AllowAudioPlayback(false);
        World = UWorld::CreateWorld(Type, false, NAME_None, nullptr, true, ERHIFeatureLevel::Num, &Values);
        if (World && GEngine)
        {
            World->GetOutermost()->SetPIEInstanceID(Instance);
            FWorldContext& Context = GEngine->CreateNewWorldContext(Type);
            Context.PIEInstance = Instance;
            Context.SetCurrentWorld(World);
        }
    }
    ~FRuntimeTestWorld()
    {
        if (World)
        {
            World->DestroyWorld(false);
            if (GEngine) GEngine->DestroyWorldContext(World);
        }
    }
};

TSharedPtr<FJsonObject> SnapshotArgs(const TSharedPtr<FJsonObject>& Target)
{
    auto Args = MakeShared<FJsonObject>();
    Args->SetObjectField(TEXT("target"), Target);
    return Args;
}

struct FSelectionRestore
{
    TArray<TWeakObjectPtr<UObject>> Actors, Components;
    FSelectionRestore()
    {
        for (FSelectionIterator It(*GEditor->GetSelectedActors()); It; ++It) Actors.Add(*It);
        for (FSelectionIterator It(*GEditor->GetSelectedComponents()); It; ++It) Components.Add(*It);
        Clear();
    }
    static void Clear()
    {
        for (USelection* Set : { GEditor->GetSelectedActors(), GEditor->GetSelectedComponents() })
        {
            Set->BeginBatchSelectOperation(); Set->DeselectAll(); Set->EndBatchSelectOperation(false);
        }
    }
    ~FSelectionRestore()
    {
        Clear();
        for (const auto& Object : Actors) if (Object.IsValid()) GEditor->GetSelectedActors()->Select(Object.Get());
        for (const auto& Object : Components) if (Object.IsValid()) GEditor->GetSelectedComponents()->Select(Object.Get());
    }
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHRuntimeIdentityTest, "DSHUnrealBridge.Runtime.IdentityAndLifecycle",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHRuntimeIdentityTest::RunTest(const FString& Parameters)
{
    if (!TestNotNull(TEXT("Engine available"), GEngine)) return false;
    FRuntimeTestWorld First(EWorldType::PIE, 17), Second(EWorldType::PIE, 18), Preview(EWorldType::EditorPreview);
    if (!TestNotNull(TEXT("First PIE world"), First.World) || !TestNotNull(TEXT("Second PIE world"), Second.World)
        || !TestNotNull(TEXT("Preview world"), Preview.World)) return false;
    AActor* Actor = First.World->SpawnActor<AActor>();
    AActor* Other = Second.World->SpawnActor<AActor>();
    AActor* PreviewActor = Preview.World->SpawnActor<AActor>();
    if (!TestNotNull(TEXT("Actor"), Actor) || !TestNotNull(TEXT("Other actor"), Other)) return false;
    FDSHRuntimeInspector Inspector;
    TestFalse(TEXT("No runtime identity outside a session"), Inspector.Describe(Actor).IsValid());
    Inspector.Begin(false);
    auto Target = Inspector.Describe(Actor);
    auto OtherTarget = Inspector.Describe(Other);
    if (!TestTrue(TEXT("PIE identities accepted"), Target.IsValid() && OtherTarget.IsValid())) return false;
    TestEqual(TEXT("Repeated describe keeps instance identity"), Inspector.Describe(Actor)->GetStringField(TEXT("objectId")), Target->GetStringField(TEXT("objectId")));
    TestNotEqual(TEXT("Different PIE worlds have different identities"), Target->GetStringField(TEXT("worldId")), OtherTarget->GetStringField(TEXT("worldId")));
    TestEqual(TEXT("PIE instance exposed"), static_cast<int32>(Target->GetNumberField(TEXT("pieInstance"))), 17);
    TestFalse(TEXT("Preview actors never acquire runtime identity"), Inspector.Describe(PreviewActor).IsValid());
    TestFalse(TEXT("Templates never acquire runtime identity"), Inspector.Describe(AActor::StaticClass()->GetDefaultObject()).IsValid());
    auto Args = SnapshotArgs(Target);
    FString Code, Message;
    auto CrossWorld = MakeShared<FJsonObject>(*Target);
    CrossWorld->SetStringField(TEXT("worldId"), OtherTarget->GetStringField(TEXT("worldId")));
    TestFalse(TEXT("World identity mismatch refused"), Inspector.Snapshot(SnapshotArgs(CrossWorld), Code, Message).IsValid());
    TestEqual(TEXT("Mismatch is expired"), Code, FString(TEXT("RUNTIME_TARGET_EXPIRED")));
    auto Unknown = MakeShared<FJsonObject>(*Target);
    Unknown->SetStringField(TEXT("objectId"), FGuid::NewGuid().ToString());
    TestFalse(TEXT("Unknown handles are not resolved by paths"), Inspector.Snapshot(SnapshotArgs(Unknown), Code, Message).IsValid());
    TestEqual(TEXT("Unknown handle code"), Code, FString(TEXT("RUNTIME_TARGET_UNKNOWN")));
    USceneComponent* Component = NewObject<USceneComponent>(Actor);
    Actor->AddInstanceComponent(Component);
    auto ComponentTarget = Inspector.Describe(Component);
    TestTrue(TEXT("Owned PIE component accepted"), ComponentTarget.IsValid());
    Component->DestroyComponent();
    Inspector.GetEvent();
    TestTrue(TEXT("Component destruction detected on tick"), Inspector.Tick());
    auto Event = Inspector.GetEvent();
    TestEqual(TEXT("Component invalidation reason"), Event->GetArrayField(TEXT("invalidated"))[0]->AsObject()->GetStringField(TEXT("reason")), FString(TEXT("object_destroyed")));
    TestFalse(TEXT("Draining events clears pending state"), Inspector.Tick());
    First.World->DestroyActor(Actor, true);
    TestFalse(TEXT("Destroyed actor refused before the next tick"), Inspector.Snapshot(Args, Code, Message).IsValid());
    TestEqual(TEXT("Destroyed actor is expired"), Code, FString(TEXT("RUNTIME_TARGET_EXPIRED")));
    Event = Inspector.GetEvent();
    TestEqual(TEXT("Actor invalidation reason"), Event->GetArrayField(TEXT("invalidated"))[0]->AsObject()->GetStringField(TEXT("reason")), FString(TEXT("actor_destroyed")));
    // Losing the world context is enough to expire a still allocated instance.
    GEngine->DestroyWorldContext(Second.World);
    Inspector.Tick();
    Event = Inspector.GetEvent();
    TestEqual(TEXT("World unload invalidation reason"), Event->GetArrayField(TEXT("invalidated"))[0]->AsObject()->GetStringField(TEXT("reason")), FString(TEXT("world_unloaded")));
    AActor* Survivor = First.World->SpawnActor<AActor>();
    auto PreviousRun = Inspector.Describe(Survivor);
    Inspector.End(false);
    Event = Inspector.GetEvent();
    TestEqual(TEXT("Stop state"), Event->GetStringField(TEXT("status")), FString(TEXT("stopped")));
    TestEqual(TEXT("PIE stop invalidation reason"), Event->GetArrayField(TEXT("invalidated"))[0]->AsObject()->GetStringField(TEXT("reason")), FString(TEXT("pie_ended")));
    Inspector.Begin(false);
    auto NewRun = Inspector.Describe(Survivor);
    TestNotEqual(TEXT("Restart creates a new session"), NewRun->GetStringField(TEXT("playSessionId")), PreviousRun->GetStringField(TEXT("playSessionId")));
    TestNotEqual(TEXT("Restart never reuses instance identity"), NewRun->GetStringField(TEXT("objectId")), PreviousRun->GetStringField(TEXT("objectId")));
    TestFalse(TEXT("Old run cannot read the new run"), Inspector.Snapshot(SnapshotArgs(PreviousRun), Code, Message).IsValid());
    TestEqual(TEXT("Old run is expired"), Code, FString(TEXT("RUNTIME_TARGET_EXPIRED")));
    // A disconnected client cannot grow tracking without bound, while new selections remain
    // usable. Sampling a target refreshes its access order without requiring another Describe.
    USceneComponent* FirstTracked = nullptr;
    TSharedPtr<FJsonObject> FirstTrackedTarget;
    for (int32 Index = 1; Index < FDSHRuntimeInspector::MaxTrackedTargets; ++Index)
    {
        USceneComponent* Extra = NewObject<USceneComponent>(Survivor);
        Survivor->AddInstanceComponent(Extra);
        auto ExtraTarget = Inspector.Describe(Extra);
        if (!FirstTracked) { FirstTracked = Extra; FirstTrackedTarget = ExtraTarget; }
        if (!ExtraTarget) { AddError(TEXT("Tracking filled before its documented limit")); return false; }
    }
    auto RecentArgs = SnapshotArgs(NewRun);
    RecentArgs->SetBoolField(TEXT("includeComponents"), false);
    RecentArgs->SetArrayField(TEXT("properties"), { MakeShared<FJsonValueString>(TEXT("Tags")) });
    TestTrue(TEXT("Sampling refreshes an old target at capacity"), Inspector.Snapshot(RecentArgs, Code, Message).IsValid());
    Inspector.GetEvent();
    USceneComponent* Overflow = NewObject<USceneComponent>(Survivor);
    Survivor->AddInstanceComponent(Overflow);
    TestTrue(TEXT("New selections remain available at tracking capacity"), Inspector.Describe(Overflow).IsValid());
    TestEqual(TEXT("Tracking remains bounded after eviction"), Inspector.Targets.Num(), FDSHRuntimeInspector::MaxTrackedTargets);
    Event = Inspector.GetEvent();
    if (TestEqual(TEXT("One oldest target evicted"), Event->GetArrayField(TEXT("invalidated")).Num(), 1))
    {
        auto Evicted = Event->GetArrayField(TEXT("invalidated"))[0]->AsObject();
        TestEqual(TEXT("Least recently accessed target evicted"), Evicted->GetStringField(TEXT("objectId")), FirstTrackedTarget->GetStringField(TEXT("objectId")));
        TestEqual(TEXT("Tracking eviction has an explicit reason"), Evicted->GetStringField(TEXT("reason")), FString(TEXT("tracking_evicted")));
    }
    TestEqual(TEXT("Recently sampled target retains its identity"), Inspector.Describe(Survivor)->GetStringField(TEXT("objectId")), NewRun->GetStringField(TEXT("objectId")));
    TestFalse(TEXT("An evicted handle is explicitly expired"), Inspector.Snapshot(SnapshotArgs(FirstTrackedTarget), Code, Message).IsValid());
    TestEqual(TEXT("Evicted handle error code"), Code, FString(TEXT("RUNTIME_TARGET_EXPIRED")));
    auto Reselected = Inspector.Describe(FirstTracked);
    if (!TestTrue(TEXT("Reselecting an evicted instance creates a usable target"), Reselected.IsValid())) return false;
    TestNotEqual(TEXT("Reselecting never revives the old handle"), Reselected->GetStringField(TEXT("objectId")), FirstTrackedTarget->GetStringField(TEXT("objectId")));
    for (int32 Index = 0; Index < 32; ++Index)
    {
        USceneComponent* Extra = NewObject<USceneComponent>(Survivor, *FString::Printf(TEXT("AAA_Snapshot_%02d"), Index));
        Survivor->AddInstanceComponent(Extra);
    }
    RecentArgs->SetBoolField(TEXT("includeComponents"), true);
    RecentArgs->SetNumberField(TEXT("maxComponents"), 32);
    auto AtCapacity = Inspector.Snapshot(RecentArgs, Code, Message);
    if (TestTrue(TEXT("Actor snapshot can allocate component handles at capacity"), AtCapacity.IsValid()))
        TestEqual(TEXT("Component capture remains available under eviction pressure"), AtCapacity->GetArrayField(TEXT("components")).Num(), 32);
    TestEqual(TEXT("Component sampling preserves the explicit actor target"), Inspector.Describe(Survivor)->GetStringField(TEXT("objectId")), NewRun->GetStringField(TEXT("objectId")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHRuntimeSnapshotTest, "DSHUnrealBridge.Runtime.SnapshotBoundsAndEvidence",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHRuntimeSnapshotTest::RunTest(const FString& Parameters)
{
    FRuntimeTestWorld TestWorld(EWorldType::PIE, 19);
    if (!TestNotNull(TEXT("PIE test world"), TestWorld.World)) return false;
    AActor* Actor = TestWorld.World->SpawnActor<AActor>();
    if (!TestNotNull(TEXT("Actor"), Actor)) return false;
    for (int32 Index = 0; Index < 24; ++Index) Actor->Tags.Add(FName(*FString::Printf(TEXT("Runtime_%d"), Index)));
    for (int32 Index = 0; Index < 3; ++Index)
    {
        USceneComponent* Component = NewObject<USceneComponent>(Actor);
        Actor->AddInstanceComponent(Component);
        if (Index == 0)
        {
            Actor->SetRootComponent(Component);
            Component->SetRelativeLocation(FVector(12, 34, 56));
            Component->SetHiddenInGame(true);
        }
    }
    FDSHRuntimeInspector Inspector;
    Inspector.Begin(false);
    auto Args = SnapshotArgs(Inspector.Describe(Actor));
    Args->SetArrayField(TEXT("properties"), { MakeShared<FJsonValueString>(TEXT("Tags")) });
    Args->SetNumberField(TEXT("maxComponents"), 1);
    FString Code, Message;
    auto Snapshot = Inspector.Snapshot(Args, Code, Message);
    if (!TestTrue(TEXT("Snapshot captured"), Snapshot.IsValid())) return false;
    TestTrue(TEXT("Runtime evidence marked"), Snapshot->GetBoolField(TEXT("runtimeEvidence")));
    TestFalse(TEXT("Frame is a lossless decimal string"), Snapshot->GetStringField(TEXT("sampledFrame")).IsEmpty());
    TestFalse(TEXT("Capture timestamp present"), Snapshot->GetStringField(TEXT("capturedAt")).IsEmpty());
    TestEqual(TEXT("Actual transform sampled"), Snapshot->GetObjectField(TEXT("actorTransform"))->GetObjectField(TEXT("location"))->GetNumberField(TEXT("x")), 12.0);
    auto Values = Snapshot->GetObjectField(TEXT("object"))->GetArrayField(TEXT("properties"));
    TestEqual(TEXT("Requested property only"), Values.Num(), 1);
    auto Page = Values[0]->AsObject()->GetObjectField(TEXT("value"));
    TestEqual(TEXT("Actual collection count"), static_cast<int32>(Page->GetNumberField(TEXT("count"))), 24);
    TestEqual(TEXT("Default collection page bounded at 20"), Page->GetArrayField(TEXT("items")).Num(), 20);
    TestTrue(TEXT("Partial collection marked"), Page->GetBoolField(TEXT("truncated")));
    TestEqual(TEXT("Component snapshot limit applied"), Snapshot->GetArrayField(TEXT("components")).Num(), 1);
    TestTrue(TEXT("Partial component snapshot marked"), Snapshot->GetBoolField(TEXT("componentsTruncated")));
    TestTrue(TEXT("Component snapshot carries its own identity"), Snapshot->GetArrayField(TEXT("components"))[0]->AsObject()->HasTypedField<EJson::Object>(TEXT("target")));
    Args->SetNumberField(TEXT("collectionOffset"), 20);
    Snapshot = Inspector.Snapshot(Args, Code, Message);
    Page = Snapshot->GetObjectField(TEXT("object"))->GetArrayField(TEXT("properties"))[0]->AsObject()->GetObjectField(TEXT("value"));
    TestEqual(TEXT("Follow-up page reads actual tail"), Page->GetArrayField(TEXT("items")).Num(), 4);
    TestEqual(TEXT("Actual final item retained"), Page->GetArrayField(TEXT("items"))[3]->AsString(), FString(TEXT("Runtime_23")));
    const TPair<const TCHAR*, double> InvalidLimits[] = {
        { TEXT("maxProperties"), 201 }, { TEXT("maxComponents"), 33 }, { TEXT("collectionOffset"), -1 },
        { TEXT("collectionLimit"), 101 }, { TEXT("maxProperties"), 0.5 }
    };
    for (const auto& Invalid : InvalidLimits)
    {
        auto Bad = MakeShared<FJsonObject>(*Args);
        Bad->SetNumberField(Invalid.Key, Invalid.Value);
        TestFalse(TEXT("Out-of-range limit refused"), Inspector.Snapshot(Bad, Code, Message).IsValid());
        TestEqual(TEXT("Bounds report invalid request"), Code, FString(TEXT("INVALID_REQUEST")));
    }
    Args->SetBoolField(TEXT("includeComponents"), false);
    TestEqual(TEXT("Component expansion can be disabled"), Inspector.Snapshot(Args, Code, Message)->GetArrayField(TEXT("components")).Num(), 0);
    // Read-time validation must run even when no expiry tick was delivered.
    TestWorld.World->bIsTearingDown = true;
    TestFalse(TEXT("World teardown blocks capture immediately"), Inspector.Snapshot(Args, Code, Message).IsValid());
    TestEqual(TEXT("World teardown is expired"), Code, FString(TEXT("RUNTIME_TARGET_EXPIRED")));
    TestWorld.World->bIsTearingDown = false;
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHRuntimeSelectionTest, "DSHUnrealBridge.Runtime.SelectionIntegration",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHRuntimeSelectionTest::RunTest(const FString& Parameters)
{
    if (!TestNotNull(TEXT("Editor available"), GEditor)) return false;
    FRuntimeTestWorld PIE(EWorldType::PIE, 20), Preview(EWorldType::EditorPreview);
    if (!PIE.World || !Preview.World) return false;
    AActor* Actor = PIE.World->SpawnActor<AActor>();
    AActor* PreviewActor = Preview.World->SpawnActor<AActor>();
    if (!Actor || !PreviewActor) return false;
    USceneComponent* Component = NewObject<USceneComponent>(Actor);
    Actor->AddInstanceComponent(Component);
    FDSHRuntimeInspector Inspector;
    Inspector.Begin(false);
    FDSHEditorSelection Selection;
    Selection.SetRuntimeInspector(&Inspector);
    FSelectionRestore Restore;
    GEditor->GetSelectedActors()->Select(Actor);
    auto Entries = Selection.ReadLevelSelection();
    if (!TestEqual(TEXT("Selected PIE actor included"), Entries.Num(), 1)) return false;
    TestTrue(TEXT("Selected actor includes runtime metadata"), Entries[0]->AsObject()->HasTypedField<EJson::Object>(TEXT("runtime")));
    GEditor->GetSelectedComponents()->Select(Component);
    Entries = Selection.ReadLevelSelection();
    if (!TestEqual(TEXT("Component takes precedence over actor"), Entries.Num(), 1)) return false;
    TestEqual(TEXT("Selected component kind"), Entries[0]->AsObject()->GetStringField(TEXT("kind")), FString(TEXT("component")));
    const auto Runtime = Entries[0]->AsObject()->GetObjectField(TEXT("runtime"));
    TestEqual(TEXT("Selection and inspector share component identity"), Runtime->GetStringField(TEXT("objectId")), Inspector.Describe(Component)->GetStringField(TEXT("objectId")));
    FSelectionRestore::Clear();
    GEditor->GetSelectedActors()->Select(PreviewActor);
    TestEqual(TEXT("Asset editor preview selection excluded"), Selection.ReadLevelSelection().Num(), 0);
    FSelectionRestore::Clear();
    GEditor->GetSelectedActors()->Select(Actor);
    Inspector.End(false);
    TestEqual(TEXT("Stopped PIE selection excluded"), Selection.ReadLevelSelection().Num(), 0);
    return true;
}
#endif
