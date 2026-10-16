#pragma once

#include "DSHAssetViewHint.h"

class FDSHAssetPresentation
{
public:
    void Queue(const FDSHAssetViewHint& Hint);
    void Tick();
private:
    struct FPending
    {
        FDSHAssetViewHint Hint;
        int32 FramesRemaining = 1;
        bool bOpened = false;
    };
    TArray<FPending> Pending;
    static void Show(const FDSHAssetViewHint& Hint, bool bFocusCanvas);
};
