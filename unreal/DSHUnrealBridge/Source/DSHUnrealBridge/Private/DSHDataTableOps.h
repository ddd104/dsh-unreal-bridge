#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Atomic, in-memory DataTable field copies. Never reimports or saves a table. */
class FDSHDataTableOps
{
public:
    static TSharedPtr<FJsonObject> CopyProperty(const TSharedPtr<FJsonObject>& Params,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>& ErrorDetails);
};
