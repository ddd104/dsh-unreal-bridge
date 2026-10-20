#pragma once
#include "CoreMinimal.h"
#include "DSHAssetPresentation.h"
#include "Dom/JsonObject.h"

class UBlueprint;
class UEdGraph;
struct FDSHBlueprintLayoutResult;

class FDSHBlueprintOps
{
public:
    TSharedPtr<FJsonObject> Execute(const FString& Method, const TSharedPtr<FJsonObject>& Params, FString& ErrorCode, FString& ErrorMessage, FDSHAssetViewHint* ViewHint = nullptr, TSharedPtr<FJsonObject>* ErrorDetails = nullptr);
    static FString Revision(UBlueprint* Blueprint);
    static TSharedPtr<FJsonObject> Read(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params);
private:
    friend class FDSHBlueprintRollbackSafety;
    TMap<FString, FGuid> UndoTransactions;
    TMap<FString, FString> UndoRevisions;
    UBlueprint* Resolve(const FString& Path, FString& Error);
    bool ApplyOperations(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Params, FString& Error, FDSHAssetViewHint* ViewHint = nullptr, FDSHBlueprintLayoutResult* LayoutResult = nullptr);
    bool Compile(UBlueprint* Blueprint, FString& Error);
    void RecoverFailedPatch(UBlueprint* Blueprint, const FString& TransactionLabel, const FString& BaseRevision,
        FString& ErrorCode, FString& ErrorMessage, TSharedPtr<FJsonObject>* ErrorDetails);
};
