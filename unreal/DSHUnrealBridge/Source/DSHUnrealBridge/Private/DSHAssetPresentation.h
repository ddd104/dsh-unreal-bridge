#pragma once

#include "DSHAssetViewHint.h"

class UWorld;

class FDSHAssetPresentation
{
public:
    void Queue(const FDSHAssetViewHint& Hint);
    void Tick();
    // Presentation never loads an asset or substitutes its owning package root.
    // Graph and node references resolve to their actual loaded editor asset.
    static UObject* ResolveSupportedTarget(const FString& ObjectPath);
    static bool CanPresentInWorld(UObject* Asset, const UWorld* EditorWorld);
    // A Material Editor owns a private editable copy. Never overwrite pending
    // editor changes when a native patch edits the original asset.
    static bool CanEditMaterialAsset(UObject* Asset, FString& Reason);
    // Call synchronously after a successful native transaction, before queuing
    // deferred navigation. Does not open editors or refresh dependent graphs.
    static bool RefreshOpenMaterialEditors(UObject* Asset, FString& Reason);
    static const TCHAR* MaterialTransactionContext() { return TEXT("DSH.NativeMaterialBatch"); }
    // Register lazily once the editor transactor exists; independent of a host
    // connection so Undo remains safe after the bridge disconnects.
    static bool PrepareMaterialTransaction(FString& Reason);
    static void FlushPendingMaterialEditorSync();
    static void ShutdownMaterialTransactions();
private:
    struct FPending
    {
        FDSHAssetViewHint Hint;
        TWeakObjectPtr<UObject> Asset;
        int32 FramesRemaining = 1;
        bool bOpenAttempted = false;
    };
    TArray<FPending> Pending;
    static bool Show(const FPending& Item, bool bFocusCanvas, bool bAllowOpen);
};
