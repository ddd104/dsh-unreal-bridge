#pragma once

#include "CoreMinimal.h"

class UEdGraph;
class UEdGraphNode;

struct FDSHBlueprintLayoutResult
{
    int32 MovedNodes = 0;
    int32 ResizedComments = 0;
};

/** Offline, deterministic K2 layout. Does not depend on an open graph editor. */
class FDSHBlueprintLayout
{
public:
    static bool Arrange(UEdGraph* Graph, const TSet<UEdGraphNode*>& Seeds,
        FDSHBlueprintLayoutResult& Result, FString& Error);
    static FVector2D EstimateSize(const UEdGraphNode* Node);
};
