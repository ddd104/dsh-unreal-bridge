#pragma once

#include "CoreMinimal.h"

// A tool supplies this UI intent after a successful edit. New tools do not need
// to know how any asset editor opens, maximizes or navigates its graph.
struct FDSHAssetViewHint
{
    FString AssetPath;
    FString Graph;
    TArray<FString> NodeIds;
    TOptional<FVector2D> Center;
};
