#include "DSHRuntimeInspector.h"

#include "Components/ActorComponent.h"
#include "Components/MeshComponent.h"
#include "Components/SceneComponent.h"
#include "Components/SkinnedMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/Engine.h"
#include "Engine/SkinnedAsset.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Materials/MaterialInterface.h"
#include "Misc/DateTime.h"
#include "ProjectKnowledgeService.h"
#include "UObject/Package.h"

namespace
{
FString NewId() { return FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphensLower); }

bool ReadInteger(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field, int32 Default, int32 Min, int32 Max, int32& Out)
{
    double Value = Default;
    if ((Params->HasField(Field) && !Params->TryGetNumberField(Field, Value)) || !FMath::IsFinite(Value)
        || Value < Min || Value > Max || Value != FMath::FloorToDouble(Value)) return false;
    Out = static_cast<int32>(Value);
    return true;
}

TSharedPtr<FJsonObject> Vector(const FVector& Value)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetNumberField(TEXT("x"), Value.X);
    Result->SetNumberField(TEXT("y"), Value.Y);
    Result->SetNumberField(TEXT("z"), Value.Z);
    return Result;
}

TSharedPtr<FJsonObject> Transform(const FTransform& Value)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetObjectField(TEXT("location"), Vector(Value.GetLocation()));
    Result->SetObjectField(TEXT("scale"), Vector(Value.GetScale3D()));
    auto Rotation = MakeShared<FJsonObject>();
    const FRotator Angles = Value.Rotator();
    Rotation->SetNumberField(TEXT("pitch"), Angles.Pitch);
    Rotation->SetNumberField(TEXT("yaw"), Angles.Yaw);
    Rotation->SetNumberField(TEXT("roll"), Angles.Roll);
    Result->SetObjectField(TEXT("rotation"), Rotation);
    return Result;
}

TSharedPtr<FJsonValue> Reference(const UObject* Object)
{
    if (!IsValid(Object)) return MakeShared<FJsonValueNull>();
    auto Value = MakeShared<FJsonObject>();
    Value->SetStringField(TEXT("path"), Object->GetPathName());
    Value->SetStringField(TEXT("class"), Object->GetClass()->GetPathName());
    return MakeShared<FJsonValueObject>(Value);
}

void Blueprint(const UObject* Object, const TCHAR* Field, const TSharedPtr<FJsonObject>& Result)
{
    for (const UClass* Class = Object->GetClass(); Class; Class = Class->GetSuperClass())
        if (const UBlueprint* Asset = Cast<UBlueprint>(Class->ClassGeneratedBy))
        {
            Result->SetStringField(Field, Asset->GetPathName());
            break;
        }
}
}

void FDSHRuntimeInspector::Start()
{
    check(IsInGameThread());
    Stop();
    BeginHandle = FEditorDelegates::BeginPIE.AddRaw(this, &FDSHRuntimeInspector::Begin);
    EndHandle = FEditorDelegates::EndPIE.AddRaw(this, &FDSHRuntimeInspector::End);
    PauseHandle = FEditorDelegates::PausePIE.AddLambda([this](bool) { if (bActive) { bPaused = true; bDirty = true; } });
    ResumeHandle = FEditorDelegates::ResumePIE.AddLambda([this](bool) { if (bActive) { bPaused = false; bDirty = true; } });
    SwitchHandle = FEditorDelegates::OnSwitchBeginPIEAndSIE.AddLambda([this](bool bSim) { if (bActive) { bSimulating = bSim; bDirty = true; } });
    CleanupHandle = FWorldDelegates::OnWorldCleanup.AddRaw(this, &FDSHRuntimeInspector::WorldCleanup);
    if (GEditor && GEditor->IsPlayingSessionInEditor())
    {
        Begin(GEditor->bIsSimulatingInEditor);
        bPaused = GEditor->PlayWorld && (GEditor->PlayWorld->bDebugPauseExecution || GEditor->PlayWorld->IsPaused());
    }
    bDirty = true;
}

void FDSHRuntimeInspector::Stop()
{
    FEditorDelegates::BeginPIE.Remove(BeginHandle);
    FEditorDelegates::EndPIE.Remove(EndHandle);
    FEditorDelegates::PausePIE.Remove(PauseHandle);
    FEditorDelegates::ResumePIE.Remove(ResumeHandle);
    FEditorDelegates::OnSwitchBeginPIEAndSIE.Remove(SwitchHandle);
    FWorldDelegates::OnWorldCleanup.Remove(CleanupHandle);
    BeginHandle.Reset(); EndHandle.Reset(); PauseHandle.Reset(); ResumeHandle.Reset(); SwitchHandle.Reset(); CleanupHandle.Reset();
    Targets.Reset(); ObjectIds.Reset(); WorldIds.Reset(); ExpiredIds.Reset(); ExpiredOrder.Reset(); Invalidated.Reset();
    PlaySessionId.Reset(); ProtectedTargetId.Reset(); AccessSerial = 0;
    bActive = false; bPaused = false; bSimulating = false; bDirty = false;
}

void FDSHRuntimeInspector::Begin(bool bSim)
{
    check(IsInGameThread());
    // A new run never inherits identities from an earlier run, even if names/paths are reused.
    if (bActive) End(bSimulating);
    Targets.Reset(); ObjectIds.Reset(); WorldIds.Reset(); ExpiredIds.Reset(); ExpiredOrder.Reset();
    PlaySessionId = NewId(); ProtectedTargetId.Reset(); AccessSerial = 0;
    bActive = true; bPaused = false; bSimulating = bSim; bDirty = true;
}

void FDSHRuntimeInspector::End(bool)
{
    check(IsInGameThread());
    TArray<FString> Ids;
    Targets.GetKeys(Ids);
    for (const FString& Id : Ids) Invalidate(Id, TEXT("pie_ended"));
    bActive = false; bPaused = false; bSimulating = false; bDirty = true;
    WorldIds.Reset();
    // Retain PlaySessionId until the next Begin so the end event identifies the run it ended.
}

bool FDSHRuntimeInspector::IsLiveWorld(const UWorld* World) const
{
    if (!bActive || !IsValid(World) || World->WorldType != EWorldType::PIE || World->bIsTearingDown || !GEngine) return false;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::PIE && Context.World() == World) return true;
    return false;
}

FString FDSHRuntimeInspector::InvalidReason(const FTarget& Target) const
{
    if (!IsLiveWorld(Target.World.Get())) return TEXT("world_unloaded");
    UObject* Object = Target.Object.Get();
    if (!IsValid(Object)) return Target.bActor ? TEXT("actor_destroyed") : TEXT("object_destroyed");
    if (const AActor* Actor = Cast<AActor>(Object))
        if (Actor->IsActorBeingDestroyed()) return TEXT("actor_destroyed");
    if (const UActorComponent* Component = Cast<UActorComponent>(Object))
    {
        const AActor* Owner = Component->GetOwner();
        if (!IsValid(Owner) || Owner->IsActorBeingDestroyed()) return TEXT("actor_destroyed");
        if (Component->IsBeingDestroyed()) return TEXT("object_destroyed");
    }
    if (Object->GetWorld() != Target.World.Get()) return TEXT("world_unloaded");
    return FString();
}

void FDSHRuntimeInspector::Invalidate(const FString& Id, const FString& Reason)
{
    const FTarget* Target = Targets.Find(Id);
    if (!Target) return;
    auto Event = MakeShared<FJsonObject>();
    Event->SetStringField(TEXT("playSessionId"), PlaySessionId);
    Event->SetStringField(TEXT("worldId"), Target->WorldId);
    Event->SetStringField(TEXT("objectId"), Id);
    Event->SetStringField(TEXT("reason"), Reason);
    // Outstanding events are bounded, including when a host has disconnected.
    if (Invalidated.Num() >= MaxTrackedTargets) Invalidated.RemoveAt(0);
    Invalidated.Add(MakeShared<FJsonValueObject>(Event));
    ObjectIds.Remove(Target->Object);
    Targets.Remove(Id);
    if (ExpiredOrder.Num() >= MaxTrackedTargets)
    {
        ExpiredIds.Remove(ExpiredOrder[0]);
        ExpiredOrder.RemoveAt(0);
    }
    ExpiredIds.Add(Id); ExpiredOrder.Add(Id); bDirty = true;
}

void FDSHRuntimeInspector::WorldCleanup(UWorld* World, bool, bool)
{
    TArray<FString> Ids;
    for (const auto& Entry : Targets) if (Entry.Value.World.Get() == World) Ids.Add(Entry.Key);
    for (const FString& Id : Ids) Invalidate(Id, TEXT("world_unloaded"));
    WorldIds.Remove(World);
}

bool FDSHRuntimeInspector::Tick()
{
    check(IsInGameThread());
    // SetPIEWorldsPaused can be called directly without broadcasting PausePIE/ResumePIE.
    // Reconcile the editor's primary world without scanning actors or running game code.
    if (bActive && GEditor && IsLiveWorld(GEditor->PlayWorld))
    {
        const bool bNowPaused = GEditor->PlayWorld->bDebugPauseExecution || GEditor->PlayWorld->IsPaused();
        if (bPaused != bNowPaused) { bPaused = bNowPaused; bDirty = true; }
    }
    TArray<TPair<FString, FString>> Expired;
    for (const auto& Entry : Targets)
    {
        FString Reason = InvalidReason(Entry.Value);
        if (!Reason.IsEmpty()) Expired.Emplace(Entry.Key, MoveTemp(Reason));
    }
    for (const auto& Entry : Expired) Invalidate(Entry.Key, Entry.Value);
    for (auto It = WorldIds.CreateIterator(); It; ++It) if (!IsLiveWorld(It.Key().Get())) It.RemoveCurrent();
    return bDirty;
}

TSharedPtr<FJsonObject> FDSHRuntimeInspector::Metadata(const FString& Id, const FTarget& Target) const
{
    const UWorld* World = Target.World.Get();
    auto Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("playSessionId"), PlaySessionId);
    Result->SetStringField(TEXT("worldId"), Target.WorldId);
    Result->SetStringField(TEXT("objectId"), Id);
    Result->SetNumberField(TEXT("pieInstance"), World->GetOutermost()->GetPIEInstanceID());
    const ENetMode Mode = World->GetNetMode();
    Result->SetStringField(TEXT("netMode"), Mode == NM_Client ? TEXT("client") : Mode == NM_ListenServer ? TEXT("listen_server")
        : Mode == NM_DedicatedServer ? TEXT("dedicated_server") : TEXT("standalone"));
    Result->SetStringField(TEXT("status"), (bPaused || World->bDebugPauseExecution || World->IsPaused()) ? TEXT("paused") : TEXT("running"));
    return Result;
}

TSharedPtr<FJsonObject> FDSHRuntimeInspector::Describe(UObject* Object)
{
    check(IsInGameThread());
    if (!IsValid(Object) || Object->IsTemplate()) return nullptr;
    AActor* Actor = Cast<AActor>(Object);
    UActorComponent* Component = Cast<UActorComponent>(Object);
    if (!Actor && !Component) return nullptr;
    if (Component) Actor = Component->GetOwner();
    if (!IsValid(Actor) || Actor->IsActorBeingDestroyed() || (Component && Component->IsBeingDestroyed())) return nullptr;
    UWorld* World = Object->GetWorld();
    if (!IsLiveWorld(World) || Actor->GetWorld() != World) return nullptr;
    if (const FString* Existing = ObjectIds.Find(Object))
    {
        FTarget* Target = Targets.Find(*Existing);
        if (Target && InvalidReason(*Target).IsEmpty())
        {
            Target->LastAccess = ++AccessSerial;
            return Metadata(*Existing, *Target);
        }
        return nullptr;
    }
    if (Targets.Num() >= MaxTrackedTargets)
    {
        FString OldestId;
        uint64 OldestAccess = MAX_uint64;
        for (const auto& Entry : Targets)
        {
            if (Entry.Key != ProtectedTargetId && Entry.Value.LastAccess < OldestAccess)
            {
                OldestId = Entry.Key;
                OldestAccess = Entry.Value.LastAccess;
            }
        }
        if (OldestId.IsEmpty()) return nullptr;
        Invalidate(OldestId, TEXT("tracking_evicted"));
    }
    FString* WorldId = WorldIds.Find(World);
    if (!WorldId) WorldId = &WorldIds.Add(World, NewId());
    const FString Id = NewId();
    FTarget Target;
    Target.WorldId = *WorldId; Target.World = World; Target.Object = Object; Target.bActor = Component == nullptr;
    Target.LastAccess = ++AccessSerial;
    Targets.Add(Id, Target); ObjectIds.Add(Object, Id);
    return Metadata(Id, Target);
}

TSharedPtr<FJsonObject> FDSHRuntimeInspector::GetState() const
{
    auto Result = MakeShared<FJsonObject>();
    if (!bActive || PlaySessionId.IsEmpty()) Result->SetField(TEXT("playSessionId"), MakeShared<FJsonValueNull>());
    else Result->SetStringField(TEXT("playSessionId"), PlaySessionId);
    Result->SetStringField(TEXT("status"), !bActive ? TEXT("stopped") : bPaused ? TEXT("paused") : TEXT("running"));
    Result->SetBoolField(TEXT("isSimulating"), bSimulating);
    return Result;
}

TSharedPtr<FJsonObject> FDSHRuntimeInspector::GetEvent()
{
    check(IsInGameThread());
    auto Result = GetState();
    Result->SetArrayField(TEXT("invalidated"), Invalidated);
    Invalidated.Reset(); bDirty = false;
    return Result;
}

TSharedPtr<FJsonObject> FDSHRuntimeInspector::CaptureObject(UObject* Object, UWorld* World, const TSharedPtr<FJsonObject>& ReflectionArgs)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("path"), Object->GetPathName());
    Result->SetStringField(TEXT("class"), Object->GetClass()->GetPathName());
    Result->SetStringField(TEXT("worldPath"), World->GetPathName());
    Result->SetStringField(TEXT("name"), Object->GetName());
    Blueprint(Object, TEXT("blueprintPath"), Result);
    if (const AActor* Actor = Cast<AActor>(Object))
    {
        Result->SetStringField(TEXT("label"), Actor->GetActorLabel(false));
        Result->SetStringField(TEXT("kind"), TEXT("actor"));
        Result->SetObjectField(TEXT("actorTransform"), Transform(Actor->GetActorTransform()));
        Result->SetBoolField(TEXT("hidden"), Actor->IsHidden());
        Result->SetBoolField(TEXT("collisionEnabled"), Actor->GetActorEnableCollision());
    }
    if (const UActorComponent* Component = Cast<UActorComponent>(Object))
    {
        Result->SetStringField(TEXT("label"), Component->GetName());
        Result->SetStringField(TEXT("kind"), TEXT("component"));
        Result->SetBoolField(TEXT("active"), Component->IsActive());
        Result->SetBoolField(TEXT("registered"), Component->IsRegistered());
        if (const AActor* Owner = Component->GetOwner())
        {
            Result->SetStringField(TEXT("ownerPath"), Owner->GetPathName());
            Result->SetStringField(TEXT("ownerLabel"), Owner->GetActorLabel(false));
            Blueprint(Owner, TEXT("ownerBlueprintPath"), Result);
        }
    }
    if (const USceneComponent* Scene = Cast<USceneComponent>(Object))
    {
        Result->SetObjectField(TEXT("worldTransform"), Transform(Scene->GetComponentTransform()));
        Result->SetObjectField(TEXT("relativeTransform"), Transform(Scene->GetRelativeTransform()));
        Result->SetBoolField(TEXT("visible"), Scene->GetVisibleFlag());
        Result->SetBoolField(TEXT("hiddenInGame"), Scene->bHiddenInGame);
        Result->SetField(TEXT("attachParent"), Reference(Scene->GetAttachParent()));
    }
    if (const UMeshComponent* Mesh = Cast<UMeshComponent>(Object))
    {
        TArray<TSharedPtr<FJsonValue>> Materials;
        const int32 Count = FMath::Min(Mesh->OverrideMaterials.Num(), 100);
        for (int32 Index = 0; Index < Count; ++Index) Materials.Add(Reference(Mesh->OverrideMaterials[Index]));
        Result->SetArrayField(TEXT("overrideMaterials"), Materials);
        Result->SetNumberField(TEXT("overrideMaterialCount"), Mesh->OverrideMaterials.Num());
        Result->SetBoolField(TEXT("materialsTruncated"), Count < Mesh->OverrideMaterials.Num());
        Result->SetField(TEXT("overlayMaterial"), Reference(Mesh->OverlayMaterial));
    }
    // Use only non-dispatching getters. In particular do not invoke custom GetMaterial overrides.
    if (const UStaticMeshComponent* Mesh = Cast<UStaticMeshComponent>(Object))
        Result->SetField(TEXT("mesh"), Reference(Mesh->GetStaticMesh()));
    if (const USkinnedMeshComponent* Mesh = Cast<USkinnedMeshComponent>(Object))
        Result->SetField(TEXT("mesh"), Reference(Mesh->GetSkinnedAsset()));
    Result->SetObjectField(TEXT("object"), FProjectKnowledgeService::DescribeRuntimeObject(Object, World, ReflectionArgs));
    return Result;
}

TSharedPtr<FJsonObject> FDSHRuntimeInspector::Snapshot(const TSharedPtr<FJsonObject>& Params, FString& ErrorCode, FString& ErrorMessage)
{
    check(IsInGameThread());
    ErrorCode.Reset(); ErrorMessage.Reset();
    auto Fail = [&ErrorCode, &ErrorMessage](const TCHAR* Code, const TCHAR* Message) -> TSharedPtr<FJsonObject>
    { ErrorCode = Code; ErrorMessage = Message; return nullptr; };
    const TSharedPtr<FJsonObject>* Requested = nullptr;
    FString Session, WorldId, Id;
    if (!Params.IsValid() || !Params->TryGetObjectField(TEXT("target"), Requested) || !Requested->IsValid()
        || !(*Requested)->TryGetStringField(TEXT("playSessionId"), Session) || Session.IsEmpty() || Session.Len() > 128
        || !(*Requested)->TryGetStringField(TEXT("worldId"), WorldId) || WorldId.IsEmpty() || WorldId.Len() > 128
        || !(*Requested)->TryGetStringField(TEXT("objectId"), Id) || Id.IsEmpty() || Id.Len() > 128)
        return Fail(TEXT("INVALID_REQUEST"), TEXT("target must contain playSessionId, worldId and objectId from a live runtime selection."));
    int32 PropertyLimit, ComponentLimit, Offset, ElementLimit;
    bool bIncludeComponents = true;
    if (!ReadInteger(Params, TEXT("maxProperties"), 80, 1, 200, PropertyLimit)
        || !ReadInteger(Params, TEXT("maxComponents"), 16, 1, 32, ComponentLimit)
        || !ReadInteger(Params, TEXT("collectionOffset"), 0, 0, 1000000, Offset)
        || !ReadInteger(Params, TEXT("collectionLimit"), 20, 1, 100, ElementLimit)
        || (Params->HasField(TEXT("includeComponents")) && !Params->TryGetBoolField(TEXT("includeComponents"), bIncludeComponents)))
        return Fail(TEXT("INVALID_REQUEST"), TEXT("Expected bounded integer limits and a boolean includeComponents."));
    auto ReflectionArgs = MakeShared<FJsonObject>();
    ReflectionArgs->SetNumberField(TEXT("maxProperties"), PropertyLimit);
    ReflectionArgs->SetNumberField(TEXT("elementOffset"), Offset);
    ReflectionArgs->SetNumberField(TEXT("maxElements"), ElementLimit);
    if (Params->HasField(TEXT("properties")))
    {
        const TArray<TSharedPtr<FJsonValue>>* Properties = nullptr;
        if (!Params->TryGetArrayField(TEXT("properties"), Properties) || Properties->Num() > PropertyLimit)
            return Fail(TEXT("INVALID_REQUEST"), TEXT("properties must be an array within maxProperties."));
        for (const auto& Property : *Properties)
        {
            FString Name;
            if (!Property.IsValid() || !Property->TryGetString(Name) || Name.IsEmpty() || Name.Len() > 256)
                return Fail(TEXT("INVALID_REQUEST"), TEXT("properties must contain non-empty reflected property names of at most 256 characters."));
        }
        ReflectionArgs->SetArrayField(TEXT("properties"), *Properties);
    }
    if (!bActive || Session != PlaySessionId || ExpiredIds.Contains(Id))
        return Fail(TEXT("RUNTIME_TARGET_EXPIRED"), TEXT("The selected runtime instance has expired. Select an instance in the current PIE run."));
    FTarget* Found = Targets.Find(Id);
    if (!Found) return Fail(TEXT("RUNTIME_TARGET_UNKNOWN"), TEXT("The runtime handle is unknown; object paths cannot restore a runtime target."));
    if (Found->WorldId != WorldId)
        return Fail(TEXT("RUNTIME_TARGET_EXPIRED"), TEXT("The runtime world does not match this instance."));
    const FString Reason = InvalidReason(*Found);
    if (!Reason.IsEmpty())
    {
        Invalidate(Id, Reason);
        return Fail(TEXT("RUNTIME_TARGET_EXPIRED"), TEXT("The selected instance or its world has been destroyed."));
    }
    Found->LastAccess = ++AccessSerial;
    // Component descriptions can allocate handles and evict an older tracked object. Keep the
    // explicitly requested instance pinned until its complete snapshot has been assembled.
    TGuardValue<FString> ProtectTarget(ProtectedTargetId, Id);
    // Copy weak handles before Describe(component) can grow/reallocate the registry. All reads
    // occur synchronously on this game thread without loading or executing game logic.
    const FTarget Target = *Found;
    UObject* Object = Target.Object.Get();
    UWorld* World = Target.World.Get();
    auto Result = CaptureObject(Object, World, ReflectionArgs);
    Result->SetObjectField(TEXT("target"), Metadata(Id, Target));
    Result->SetStringField(TEXT("capturedAt"), FDateTime::UtcNow().ToIso8601());
    Result->SetStringField(TEXT("sampledFrame"), LexToString(GFrameCounter));
    Result->SetBoolField(TEXT("paused"), bPaused || World->bDebugPauseExecution || World->IsPaused());
    Result->SetBoolField(TEXT("runtimeEvidence"), true);
    TArray<TSharedPtr<FJsonValue>> Components;
    int32 Available = 0;
    bool bTrackingLimit = false;
    if (AActor* Actor = Cast<AActor>(Object); Actor && bIncludeComponents)
    {
        TInlineComponentArray<UActorComponent*> Owned;
        Actor->GetComponents(Owned);
        Owned.Sort([](const UActorComponent& A, const UActorComponent& B) { return A.GetName() < B.GetName(); });
        auto ComponentArgs = MakeShared<FJsonObject>(*ReflectionArgs);
        ComponentArgs->RemoveField(TEXT("properties"));
        for (UActorComponent* Component : Owned)
        {
            if (!IsValid(Component) || Component->IsBeingDestroyed() || Component->GetWorld() != World) continue;
            ++Available;
            if (Components.Num() >= ComponentLimit) continue;
            auto Identity = Describe(Component);
            if (!Identity) { bTrackingLimit = true; continue; }
            auto Entry = CaptureObject(Component, World, ComponentArgs);
            Entry->SetObjectField(TEXT("target"), Identity);
            Components.Add(MakeShared<FJsonValueObject>(Entry));
        }
    }
    Result->SetArrayField(TEXT("components"), Components);
    Result->SetNumberField(TEXT("componentCount"), Available);
    Result->SetBoolField(TEXT("componentsTruncated"), Components.Num() < Available);
    if (bTrackingLimit) Result->SetStringField(TEXT("componentTruncationReason"), TEXT("runtime_tracking_limit"));
    return Result;
}
