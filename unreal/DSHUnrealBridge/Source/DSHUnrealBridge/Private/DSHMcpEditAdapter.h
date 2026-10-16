#pragma once

#include "DSHAssetViewHint.h"
#include "Dom/JsonObject.h"

struct FDSHMcpGraphSnapshot
{
    FString GraphPath;
    TMap<FString, FString> Nodes;
    TMap<FString, FVector2D> Positions;
};

// Translates the UE MCP envelope into UI hints without changing MCP execution.
// Future toolsets can add an adapter here or provide FDSHAssetViewHint directly.
class FDSHMcpEditAdapter
{
public:
    static TArray<FDSHAssetViewHint> FromCall(const FString& ToolName,
        const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result);
    static TArray<FDSHMcpGraphSnapshot> CaptureGraphs(const TArray<FDSHAssetViewHint>& Hints);
    static void IncludeGraphChanges(TArray<FDSHAssetViewHint>& Hints, const TArray<FDSHMcpGraphSnapshot>& Before);
};
