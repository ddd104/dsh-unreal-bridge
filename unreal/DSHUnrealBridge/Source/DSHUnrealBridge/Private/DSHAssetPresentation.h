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
