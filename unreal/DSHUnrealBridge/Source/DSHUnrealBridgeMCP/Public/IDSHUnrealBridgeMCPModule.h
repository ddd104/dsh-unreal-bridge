#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Modules/ModuleManager.h"

class DSHUNREALBRIDGEMCP_API IDSHUnrealBridgeMCPModule : public IModuleInterface
{
public:
    static IDSHUnrealBridgeMCPModule& Get();

    virtual TSharedPtr<FJsonObject> ListTools(FString& Error) const = 0;
    virtual bool CallTool(const FString& Name, const TSharedPtr<FJsonObject>& Arguments,
        const FString& RequestId, TFunction<void(TSharedPtr<FJsonObject>)> OnComplete,
        FString& Error) = 0;
};
