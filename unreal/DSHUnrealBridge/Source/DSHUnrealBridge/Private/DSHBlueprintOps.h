#pragma once
#include "CoreMinimal.h"
#include "DSHAssetPresentation.h"
#include "Dom/JsonObject.h"

class UBlueprint;
class UEdGraph;

class FDSHBlueprintOps
{
public:
    TSharedPtr<FJsonObject> Execute(const FString& Method, const TSharedPtr<FJsonObject>& Params, FString& ErrorCode, FString& ErrorMessage, FDSHAssetViewHint* ViewHint = nullptr);
    static FString Revision(UBlueprint* Blueprint);
    static TSharedPtr<FJsonObject> Read(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params);
private:
    TMap<FString, FGuid> UndoTransactions;
    TMap<FString, FString> UndoRevisions;
    UBlueprint* Resolve(const FString& Path, FString& Error);
    bool ApplyOperations(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params, FString& Error, FDSHAssetViewHint* ViewHint = nullptr);
    bool Compile(UBlueprint* Blueprint, FString& Error);
};
