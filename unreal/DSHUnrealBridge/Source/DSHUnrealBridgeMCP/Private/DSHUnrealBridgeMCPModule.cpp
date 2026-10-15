#include "IDSHUnrealBridgeMCPModule.h"

#include "IModelContextProtocolModule.h"
#include "IModelContextProtocolTool.h"
#include "ModelContextProtocolSession.h"
#include "ModelContextProtocolToolResults.h"
#include "Dom/JsonValue.h"

IDSHUnrealBridgeMCPModule& IDSHUnrealBridgeMCPModule::Get()
{
    return FModuleManager::LoadModuleChecked<IDSHUnrealBridgeMCPModule>(TEXT("DSHUnrealBridgeMCP"));
}

class FDSHUnrealBridgeMCPModule final : public IDSHUnrealBridgeMCPModule
{
public:
    TSharedPtr<FJsonObject> ListTools(FString& Error) const override
    {
        const IModelContextProtocolModule* MCP = IModelContextProtocolModule::Get();
        if (!MCP)
        {
            Error = TEXT("UE ModelContextProtocol module is unavailable");
            return nullptr;
        }

        TArray<TSharedPtr<FJsonValue>> Tools;
        for (const TSharedRef<IModelContextProtocolTool>& Tool : MCP->GetTools())
        {
            TSharedPtr<FJsonObject> Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("name"), Tool->GetName());
            Item->SetStringField(TEXT("description"), Tool->GetDescription());
            if (TSharedPtr<FJsonObject> Schema = Tool->GetInputJsonSchema())
            {
                Item->SetObjectField(TEXT("inputSchema"), Schema);
            }
            Tools.Add(MakeShared<FJsonValueObject>(Item));
        }
        TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetArrayField(TEXT("tools"), Tools);
        return Result;
    }

    bool CallTool(const FString& Name, const TSharedPtr<FJsonObject>& Arguments,
        const FString& RequestId, TFunction<void(TSharedPtr<FJsonObject>)> OnComplete,
        FString& Error) override
    {
        FString ToolsetName;
        FString ToolName;
        if (Arguments)
        {
            Arguments->TryGetStringField(TEXT("toolset_name"), ToolsetName);
            Arguments->TryGetStringField(TEXT("tool_name"), ToolName);
        }
        const bool bScriptTool = Name.Contains(TEXT("ProgrammaticToolset"), ESearchCase::IgnoreCase)
            || ToolsetName.Contains(TEXT("ProgrammaticToolset"), ESearchCase::IgnoreCase)
            || Name.Contains(TEXT("execute_tool_script"), ESearchCase::IgnoreCase)
            || ToolName.Contains(TEXT("execute_tool_script"), ESearchCase::IgnoreCase);
        if (bScriptTool)
        {
            Error = TEXT("Script-execution MCP tools are disabled; use a specific UE asset tool instead");
            return false;
        }
        if (ToolsetName.Contains(TEXT("AssetTools"), ESearchCase::IgnoreCase)
            && ToolName.Equals(TEXT("write_file"), ESearchCase::IgnoreCase) && Arguments)
        {
            const TSharedPtr<FJsonObject>* ToolArguments = nullptr;
            FString FilePath;
            if (Arguments->TryGetObjectField(TEXT("arguments"), ToolArguments) && ToolArguments && ToolArguments->IsValid())
            {
                (*ToolArguments)->TryGetStringField(TEXT("file_path"), FilePath);
            }
            if (FilePath.EndsWith(TEXT(".py"), ESearchCase::IgnoreCase)
                || FilePath.EndsWith(TEXT(".js"), ESearchCase::IgnoreCase)
                || FilePath.EndsWith(TEXT(".ps1"), ESearchCase::IgnoreCase))
            {
                Error = TEXT("Writing scripts through UE MCP is disabled; use a specific asset tool instead");
                return false;
            }
        }
        IModelContextProtocolModule* MCP = IModelContextProtocolModule::Get();
        if (!MCP)
        {
            Error = TEXT("UE ModelContextProtocol module is unavailable");
            return false;
        }
        TSharedPtr<IModelContextProtocolTool> Tool = MCP->FindTool(Name);
        if (!Tool)
        {
            Error = FString::Printf(TEXT("UE MCP tool is unavailable: %s"), *Name);
            return false;
        }
        const FModelContextProtocolToolRequestId ToolId(MakeShared<FJsonValueString>(RequestId));
        Tool->RunAsync(ToolId, Arguments.IsValid() ? Arguments : MakeShared<FJsonObject>(),
            [OnComplete = MoveTemp(OnComplete)](const FModelContextProtocolToolResult& Result)
            {
                OnComplete(Result.JsonObject);
            });
        return true;
    }
};

IMPLEMENT_MODULE(FDSHUnrealBridgeMCPModule, DSHUnrealBridgeMCP)
