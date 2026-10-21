#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** Checks current native metadata and existing targets without invoking a tool or loading an asset. */
class FDSHMcpTargetValidation
{
public:
    static bool Validate(const FString& ToolName, const TSharedPtr<FJsonObject>& ToolArguments,
        TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message);
};

/** Per-connection, short-lived evidence. Tokens do not grant permission to execute. */
class FDSHMcpOperationContexts
{
public:
    TSharedPtr<FJsonObject> Prepare(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments,
        TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message);
    bool Verify(const FString& Token, const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments,
        bool bMutation, TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message);
    void Consume(const FString& Token) { Records.Remove(Token); }
    void Reset() { Records.Reset(); }

private:
    struct FIdentity
    {
        FString Path;
        TWeakObjectPtr<UObject> Object;
    };
    struct FRecord
    {
        FString CallName, CanonicalToolName, Arguments;
        TArray<FIdentity> Identities;
        TArray<FIdentity> Owners;
        double Created = 0;
        int64 Bytes = 0;
    };
    TMap<FString, FRecord> Records;
    static bool Inspect(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments, FRecord& Record,
        TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message);
};
