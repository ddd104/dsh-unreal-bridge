#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Checks current native metadata and existing targets without invoking a tool or loading an asset. */
class FDSHMcpTargetValidation
{
public:
    static bool Validate(const FString& ToolName, const TSharedPtr<FJsonObject>& ToolArguments,
        TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message);
};
