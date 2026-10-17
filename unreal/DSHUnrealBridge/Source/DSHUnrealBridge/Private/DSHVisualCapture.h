#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

// Read-only capture of an existing editor viewport. Must run on the game thread.
class FDSHVisualCapture
{
public:
    static TSharedPtr<FJsonObject> Capture(const TSharedPtr<FJsonObject>& Params, FString& Error, FString& ErrorCode);

    // Also used by automation tests: clips bounds against the near plane before
    // projection. A projected bounding rectangle is not a visible object mask.
    static bool ProjectBounds(const FBox& Bounds, const FMatrix& ViewProjection, const FIntRect& ViewRect,
        FIntRect& OutRect, bool& bNearClipped, bool& bScreenClipped, FString& ErrorCode);
};
