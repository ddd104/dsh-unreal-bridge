#pragma once

#include "DSHAssetViewHint.h"
#include "Dom/JsonObject.h"

// Translates the UE MCP envelope into UI hints without changing MCP execution.
// Future toolsets can add an adapter here or provide FDSHAssetViewHint directly.
class FDSHMcpEditAdapter
{
public:
    static TArray<FDSHAssetViewHint> FromCall(const FString& ToolName,
        const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result);
};
