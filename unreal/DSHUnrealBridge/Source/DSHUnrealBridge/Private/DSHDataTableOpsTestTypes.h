#pragma once

#include "CoreMinimal.h"
#include "Engine/DataTable.h"
#include "DSHDataTableOpsTestTypes.generated.h"

// Native fixtures exercise containers that are corrupted by JSON round-tripping.
USTRUCT()
struct FDSHDataTableCopyTestColors
{
    GENERATED_BODY()

    UPROPERTY()
    TMap<FName, FLinearColor> Colors;

    UPROPERTY()
    TArray<FVector> Samples;
};

USTRUCT()
struct FDSHDataTableCopyTestRow : public FTableRowBase
{
    GENERATED_BODY()

    UPROPERTY()
    TMap<FName, FDSHDataTableCopyTestColors> RenderTargetColors;

    UPROPERTY()
    TMap<FName, float> FloatParameters;

    UPROPERTY()
    TMap<FName, FVector> VectorParameters;

    UPROPERTY()
    TSoftObjectPtr<UObject> AnimToPlay;

    UPROPERTY()
    FString Label;

    UPROPERTY()
    int32 Sentinels[2] = {11, 22};
};
