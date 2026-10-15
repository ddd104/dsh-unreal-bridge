#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class UBlueprint;
class UEdGraph;

class FDSHBlueprintOps
{
public:
    TSharedPtr<FJsonObject> Execute(const FString& Method, const TSharedPtr<FJsonObject>& Params, FString& ErrorCode, FString& ErrorMessage);
    static FString Revision(UBlueprint* Blueprint);
    static TSharedPtr<FJsonObject> Read(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params);
private:
    TMap<FString, FGuid> UndoTransactions;
    TMap<FString, FString> UndoRevisions;
    UBlueprint* Resolve(const FString& Path, FString& Error);
    bool ApplyOperations(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params, FString& Error);
    bool Compile(UBlueprint* Blueprint, FString& Error);
};
