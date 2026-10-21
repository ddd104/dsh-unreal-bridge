#pragma once

#include "Engine/AssetUserData.h"
#include "UObject/SoftObjectPath.h"
#include "DSHMaterialOpsTestTypes.generated.h"

/** In-memory automation fixture for nested material metadata snapshots. */
UCLASS()
class UDSHMaterialBatchTestData : public UAssetUserData
{
    GENERATED_BODY()
public:
    UPROPERTY(EditAnywhere, Category = Test)
    TSet<FName> Tags;

    UPROPERTY(EditAnywhere, Category = Test)
    TMap<FName, FString> Labels;

    UPROPERTY(EditAnywhere, Category = Test)
    FSoftObjectPath Reference;
};
