#pragma once

#include "DSHAssetViewHint.h"
#include "Dom/JsonObject.h"

struct FDSHMcpGraphSnapshot
{
    FString AssetPath;
    FString GraphPath;
    FGuid GraphGuid;
    TMap<FString, FString> Nodes;
    TMap<FString, FVector2D> Positions;
    TMap<FString, TArray<FString>> Neighbors;
};

// Captures affected Blueprint graphs before MCP execution, then arranges the
// graphs whose contents changed before publishing the result and UI hints.
class FDSHMcpEditAdapter
{
public:
    static TArray<FDSHAssetViewHint> FromCall(const FString& ToolName,
        const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result);
    static TArray<FDSHMcpGraphSnapshot> CaptureGraphs(const TArray<FDSHAssetViewHint>& Hints);
    static void IncludeGraphChanges(TArray<FDSHAssetViewHint>& Hints, const TArray<FDSHMcpGraphSnapshot>& Before);
    static TArray<FDSHMcpGraphSnapshot> CaptureCallGraphs(const FString& ToolName,
        const TSharedPtr<FJsonObject>& Arguments);
    static TArray<FDSHAssetViewHint> FinalizeCall(const FString& ToolName,
        const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result,
        const TArray<FDSHMcpGraphSnapshot>& Before);
};
