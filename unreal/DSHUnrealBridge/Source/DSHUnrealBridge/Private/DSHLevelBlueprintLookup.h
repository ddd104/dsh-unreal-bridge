#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Finds an existing level script without creating it, editing it, or switching worlds. */
class FDSHLevelBlueprintLookup
{
public:
    static TSharedPtr<FJsonObject> Resolve(const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage);
};
