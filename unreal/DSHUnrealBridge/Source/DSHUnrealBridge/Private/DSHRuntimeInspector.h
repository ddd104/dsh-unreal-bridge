#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class UWorld;

// Owns opaque identities, never the selected game objects. All methods run on the game thread.
// An object path is diagnostic text only and is never used to resolve a runtime target.
class FDSHRuntimeInspector
{
public:
    ~FDSHRuntimeInspector() { Stop(); }
    void Start();
    void Stop();
    bool Tick();
    TSharedPtr<FJsonObject> Describe(UObject* Object);
    TSharedPtr<FJsonObject> GetState() const;
    TSharedPtr<FJsonObject> GetEvent();
    TSharedPtr<FJsonObject> Snapshot(const TSharedPtr<FJsonObject>& Params, FString& ErrorCode, FString& ErrorMessage);

private:
    friend class FDSHRuntimeIdentityTest;
    friend class FDSHRuntimeSnapshotTest;
    friend class FDSHRuntimeSelectionTest;
    static constexpr int32 MaxTrackedTargets = 1024;
    struct FTarget
    {
        FString WorldId;
        TWeakObjectPtr<UWorld> World;
        TWeakObjectPtr<UObject> Object;
        bool bActor = false;
        uint64 LastAccess = 0;
    };

    void Begin(bool bSimulating);
    void End(bool bSimulating);
    void Invalidate(const FString& Id, const FString& Reason);
    void WorldCleanup(UWorld* World, bool bSessionEnded, bool bCleanupResources);
    bool IsLiveWorld(const UWorld* World) const;
    FString InvalidReason(const FTarget& Target) const;
    TSharedPtr<FJsonObject> Metadata(const FString& Id, const FTarget& Target) const;
    TSharedPtr<FJsonObject> CaptureObject(UObject* Object, UWorld* World, const TSharedPtr<FJsonObject>& ReflectionArgs);

    FDelegateHandle BeginHandle, EndHandle, PauseHandle, ResumeHandle, SwitchHandle, CleanupHandle;
    FString PlaySessionId;
    FString ProtectedTargetId;
    uint64 AccessSerial = 0;
    bool bActive = false, bPaused = false, bSimulating = false, bDirty = false;
    TMap<FString, FTarget> Targets;
    TMap<TWeakObjectPtr<UObject>, FString> ObjectIds;
    TMap<TWeakObjectPtr<UWorld>, FString> WorldIds;
    TSet<FString> ExpiredIds;
    TArray<FString> ExpiredOrder;
    TArray<TSharedPtr<FJsonValue>> Invalidated;
};
