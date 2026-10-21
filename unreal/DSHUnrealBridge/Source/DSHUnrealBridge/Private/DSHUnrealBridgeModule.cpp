#include "Modules/ModuleManager.h"
#include "DSHBlueprintOps.h"
#include "DSHDataTableOps.h"
#include "DSHMaterialOps.h"
#include "DSHLevelBlueprintLookup.h"
#include "DSHAssetPresentation.h"
#include "DSHMcpEditAdapter.h"
#include "DSHMcpTargetValidation.h"
#include "DSHEditorSelection.h"
#include "DSHRuntimeInspector.h"
#include "DSHVisualCapture.h"
#include "IDSHUnrealBridgeMCPModule.h"
#include "ProjectKnowledgeService.h"
#include "AssetRegistry/AssetData.h"
#include "Async/Async.h"
#include "Containers/Ticker.h"
#include "Containers/Queue.h"
#include "Engine/Blueprint.h"
#include "Editor.h"
#include "HAL/PlatformProcess.h"
#include "IWebSocket.h"
#include "Misc/CommandLine.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/Parse.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UObjectGlobals.h"
#include "WebSocketsModule.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraphSchema_K2.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"
#endif

DEFINE_LOG_CATEGORY_STATIC(LogDSHBridge,Log,All);

namespace
{
FString Encode(const TSharedPtr<FJsonObject>& Object) { FString Text;FJsonSerializer::Serialize(Object.ToSharedRef(),TJsonWriterFactory<>::Create(&Text));return Text; }
FString Field(const TSharedPtr<FJsonObject>& O,const TCHAR* K){FString V;if(O)O->TryGetStringField(K,V);return V;}
TSharedPtr<FJsonObject> Decode(const FString& Text){TSharedPtr<FJsonObject> O;FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text),O);return O;}
FString RequestHash(const FString& Method,const TSharedPtr<FJsonObject>& Params)
{
    auto SemanticParams=MakeShared<FJsonObject>();SemanticParams->Values=Params->Values;
    // Internal identity evidence may be refreshed for an identical request UUID.
    if(Method==TEXT("mcp_call_tool"))SemanticParams->RemoveField(TEXT("operationToken"));
    const FTCHARToUTF8 Bytes(*(Method+Encode(SemanticParams)));
    return FMD5::HashBytes(reinterpret_cast<const uint8*>(Bytes.Get()),Bytes.Length());
}

// Keep this exact allowlist aligned with the audited queries in mcp-contract.mjs.
// Native tool names and caller-provided annotations do not establish read safety.
bool IsAuditedMcpRead(const TSharedPtr<FJsonObject>& Params)
{
    FString Name=Field(Params,TEXT("name"));
    if(Name==TEXT("call_tool"))
    {
        const TSharedPtr<FJsonObject>* Arguments=nullptr;
        if(!Params->TryGetObjectField(TEXT("arguments"),Arguments)||!Arguments||!Arguments->IsValid())return false;
        Name=Field(*Arguments,TEXT("toolset_name"))+TEXT(".")+Field(*Arguments,TEXT("tool_name"));
    }
    static const TSet<FString> Reads={
        TEXT("editor_toolset.toolsets.blueprint.BlueprintTools.get_default_object"),
        TEXT("editor_toolset.toolsets.blueprint.BlueprintTools.list_graphs"),
        TEXT("editor_toolset.toolsets.blueprint.BlueprintTools.find_nodes"),
        TEXT("editor_toolset.toolsets.blueprint.BlueprintTools.get_node_infos"),
        TEXT("editor_toolset.toolsets.object.ObjectTools.get_class"),
        TEXT("editor_toolset.toolsets.object.ObjectTools.get_properties"),
        TEXT("editor_toolset.toolsets.object.ObjectTools.list_properties"),
        TEXT("editor_toolset.toolsets.data_table.DataTableTools.get_schema"),
        TEXT("editor_toolset.toolsets.data_table.DataTableTools.list_rows"),
        TEXT("editor_toolset.toolsets.data_table.DataTableTools.get_rows"),
        TEXT("editor_toolset.toolsets.data_table.DataTableTools.search_row_structs"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.list_expression_classes"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.get_expressions"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.list_parameter_groups"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.get_expression_input_names"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.get_expression_output_names"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.get_expression_inputs"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.get_property_input"),
        TEXT("editor_toolset.toolsets.material.MaterialTools.get_referencing_materials")
    };
    return Reads.Contains(Name);
}

TSharedPtr<FJsonObject> CompactFailure(const TSharedPtr<FJsonObject>& Failure,const FString& DefaultCode)
{
    FString Code=Field(Failure,TEXT("code")),Message=Field(Failure,TEXT("message"));
    auto Details=MakeShared<FJsonObject>();
    bool bUnsafe=false,bRetryable=false,bHasRetryable=false;
    TArray<TSharedPtr<FJsonObject>> Pending={Failure};
    TSet<const FJsonObject*> Seen;
    while(!Pending.IsEmpty())
    {
        const auto Value=Pending.Pop(EAllowShrinking::No);
        if(!Value.IsValid()||Seen.Contains(Value.Get()))continue;
        Seen.Add(Value.Get());
        const FString CurrentCode=Field(Value,TEXT("code"));
        const bool bUnsafeCode=CurrentCode==TEXT("ROLLBACK_FAILED")||CurrentCode==TEXT("DATA_TABLE_ROLLBACK_FAILED")||CurrentCode==TEXT("EDITOR_WRITE_LOCKED");
        if((Code.IsEmpty()&&!CurrentCode.IsEmpty())||bUnsafeCode)Code=CurrentCode.Left(160);
        if(Message.IsEmpty())Message=Field(Value,TEXT("message")).Left(2048);
        bUnsafe|=bUnsafeCode||Field(Value,TEXT("rollback"))==TEXT("failed");
        for(const TCHAR* Key:{TEXT("rollback"),TEXT("execution"),TEXT("recovery"),TEXT("requestId")})
        {
            FString Text;
            if(!Details->HasField(Key)&&Value->TryGetStringField(Key,Text))Details->SetStringField(Key,Text.Left(160));
        }
        bool Retryable;
        if(Value->TryGetBoolField(TEXT("retryable"),Retryable))
        {
            bRetryable=bHasRetryable?bRetryable&&Retryable:Retryable;bHasRetryable=true;
        }
        // These are error envelope fields, never arbitrary asset properties or
        // text content. Match the host's structured unsafe-state evidence paths.
        for(const TCHAR* Key:{TEXT("error"),TEXT("info"),TEXT("details"),TEXT("structuredContent"),TEXT("ueResult")})
        {
            const TSharedPtr<FJsonObject>* Child=nullptr;
            if(Value->TryGetObjectField(Key,Child)&&Child&&Child->IsValid())Pending.Add(*Child);
        }
    }
    if(Message.IsEmpty())
    {
        const TArray<TSharedPtr<FJsonValue>>* Content=nullptr;
        if(Failure->TryGetArrayField(TEXT("content"),Content)&&Content)
            for(const auto& Block:*Content)
                if(Block.IsValid()&&Block->Type==EJson::Object&&Field(Block->AsObject(),TEXT("type"))==TEXT("text"))
                {Message=Field(Block->AsObject(),TEXT("text")).Left(2048);if(!Message.IsEmpty())break;}
    }
    if(bUnsafe)
    {
        Details->SetStringField(TEXT("rollback"),TEXT("failed"));
        Details->SetStringField(TEXT("recovery"),TEXT("stop_writes"));
        Details->SetBoolField(TEXT("retryable"),false);
    }
    else if(bHasRetryable)Details->SetBoolField(TEXT("retryable"),bRetryable);
    Details->SetBoolField(TEXT("truncated"),true);
    auto Error=MakeShared<FJsonObject>();
    Error->SetStringField(TEXT("code"),Code.IsEmpty()?DefaultCode:Code.Left(160));
    Error->SetStringField(TEXT("message"),Message.IsEmpty()?TEXT("The tool failed; its diagnostic output exceeded the bridge response limit."):Message.Left(2048));
    Error->SetObjectField(TEXT("details"),Details);
    return Error;
}
}

class FDSHConnection : public TSharedFromThis<FDSHConnection>
{
public:
    void Start()
    {
        EditorId=FGuid::NewGuid().ToString();
        FString Override;
        if(FParse::Value(FCommandLine::Get(),TEXT("DSHBridgeDescriptor="),Override))Descriptor=Override;
        else
        {
#if PLATFORM_WINDOWS
            Descriptor=FPaths::Combine(FPlatformMisc::GetEnvironmentVariable(TEXT("LOCALAPPDATA")),TEXT("DSHUnrealBridge/bridge.json"));
#else
            FString Root=FPlatformMisc::GetEnvironmentVariable(TEXT("XDG_STATE_HOME"));if(Root.IsEmpty())Root=FPaths::Combine(FPlatformMisc::GetEnvironmentVariable(TEXT("HOME")),TEXT(".local/state"));
            Descriptor=FPaths::Combine(Root,TEXT("dsh-unreal-bridge/bridge.json"));
#endif
        }
        RuntimeInspector.Start();
        EditorSelection.SetRuntimeInspector(&RuntimeInspector);
        EditorSelection.Start();
        TransactedHandle=FCoreUObjectDelegates::OnObjectTransacted.AddSP(AsShared(),&FDSHConnection::ObjectTransacted);
        PropertyHandle=FCoreUObjectDelegates::OnObjectPropertyChanged.AddSP(AsShared(),&FDSHConnection::PropertyChanged);
        TickHandle=FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateSP(AsShared(),&FDSHConnection::Tick),0.1f);
        UE_LOG(LogDSHBridge,Display,TEXT("DSH bridge ready; waiting for local DSH host. Instance %s"),*EditorId);
    }
    void Stop()
    {
        ++Generation;
        OperationContexts.Reset();
        for (const auto& Pending : PendingKnowledge) FProjectKnowledgeService::Cancel(Pending.Value);
        PendingKnowledge.Reset();
        FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
        EditorSelection.Stop();
        RuntimeInspector.Stop();
        FCoreUObjectDelegates::OnObjectTransacted.Remove(TransactedHandle);FCoreUObjectDelegates::OnObjectPropertyChanged.Remove(PropertyHandle);
        if(Socket){Socket->OnConnected().Clear();Socket->OnConnectionError().Clear();Socket->OnClosed().Clear();Socket->OnMessage().Clear();Socket->Close();Socket.Reset();}
    }
private:
    TSharedPtr<IWebSocket> Socket;
    FString EditorId,Descriptor;
    bool bConnecting=false,bAuthenticated=false;
    double LastConnect=0;
    int64 Sequence=0;
    FTSTicker::FDelegateHandle TickHandle;
    FDelegateHandle TransactedHandle,PropertyHandle;
    FDSHEditorSelection EditorSelection;
    FDSHRuntimeInspector RuntimeInspector;
    uint64 Generation=0;
    struct FIncoming { uint64 Generation; FString Message; };
    TQueue<FIncoming,EQueueMode::Mpsc> Inbox;
    TMap<FString,TSharedPtr<FJsonObject>> Results;
    TMap<FString,FString> RequestHashes;
    TSet<FString> PendingMcp;
    TMap<FString, FGuid> PendingKnowledge;
    FString PendingWriteRequestId;
    TArray<FString> ResultOrder;
    TMap<TWeakObjectPtr<UBlueprint>,FString> Watched;
    TSet<TWeakObjectPtr<UBlueprint>> Dirty;
    FDSHBlueprintOps Operations;
    FDSHAssetPresentation Presentation;
    FDSHMcpOperationContexts OperationContexts;
#if WITH_DEV_AUTOMATION_TESTS
    friend class FDSHWriteCoordinationTest;
    friend class FDSHBoundedFailureTest;
    friend class FDSHMcpOperationAdmissionTest;
    TFunction<void(const TSharedPtr<FJsonObject>&)> ObserveTestResponse;
#endif
    void Send(const TSharedPtr<FJsonObject>& O)
    {
        const auto Outgoing=Field(O,TEXT("type"))==TEXT("response")?BoundResponse(O):O;
#if WITH_DEV_AUTOMATION_TESTS
        if(ObserveTestResponse)ObserveTestResponse(Outgoing);
#endif
        if(Socket&&Socket->IsConnected())Socket->Send(Encode(Outgoing));
    }
    void FinishWrite(const FString& Id){if(PendingWriteRequestId==Id)PendingWriteRequestId.Reset();}
    void Event(const FString& Name,const TSharedPtr<FJsonObject>& Data){if(!bAuthenticated)return;auto O=MakeShared<FJsonObject>();O->SetStringField(TEXT("type"),TEXT("event"));O->SetStringField(TEXT("event"),Name);O->SetNumberField(TEXT("sequence"),++Sequence);O->SetObjectField(TEXT("data"),Data);Send(O);}
    void SendSelection(){auto Data=MakeShared<FJsonObject>();Data->SetArrayField(TEXT("assets"),EditorSelection.GetSelection());Event(TEXT("selection_changed"),Data);}
    void Mark(UObject* Object){if(!Object)return;UBlueprint* BP=Cast<UBlueprint>(Object);if(!BP)BP=Object->GetTypedOuter<UBlueprint>();if(BP&&Watched.Contains(BP))Dirty.Add(BP);}
    void ObjectTransacted(UObject* Object,const FTransactionObjectEvent&){Mark(Object);}
    void PropertyChanged(UObject* Object,FPropertyChangedEvent&){Mark(Object);}
    void Connect()
    {
        FString Text;if(!FFileHelper::LoadFileToString(Text,*Descriptor)||Text.Len()>8192)return;const auto Config=Decode(Text);if(!Config)return;
        const FString URL=Field(Config,TEXT("url"));const FString Token=Field(Config,TEXT("token"));
        if(!URL.StartsWith(TEXT("ws://127.0.0.1:"))||!URL.EndsWith(TEXT("/editor"))||Token.Len()!=64)return;
        const uint64 CurrentGeneration=++Generation;
        OperationContexts.Reset();
        if(Socket){Socket->OnConnected().Clear();Socket->OnConnectionError().Clear();Socket->OnClosed().Clear();Socket->OnMessage().Clear();Socket->Close();Socket.Reset();}
        bConnecting=true;bAuthenticated=false;TMap<FString,FString> Headers;Headers.Add(TEXT("Authorization"),TEXT("Bearer ")+Token);
        Socket=FWebSocketsModule::Get().CreateWebSocket(URL,TArray<FString>(),Headers);
        const TWeakPtr<FDSHConnection> Weak=AsShared();
        Socket->OnConnected().AddLambda([Weak,CurrentGeneration](){if(auto Self=Weak.Pin())Self->Inbox.Enqueue({CurrentGeneration,TEXT("__connected")});});
        Socket->OnConnectionError().AddLambda([Weak,CurrentGeneration](const FString&){if(auto Self=Weak.Pin())Self->Inbox.Enqueue({CurrentGeneration,TEXT("__disconnected")});});
        Socket->OnClosed().AddLambda([Weak,CurrentGeneration](int32,const FString&,bool){if(auto Self=Weak.Pin())Self->Inbox.Enqueue({CurrentGeneration,TEXT("__disconnected")});});
        Socket->OnMessage().AddLambda([Weak,CurrentGeneration](const FString& Message){if(auto Self=Weak.Pin())if(Message.Len()<=2*1024*1024)Self->Inbox.Enqueue({CurrentGeneration,Message});});
        Socket->Connect();
    }
    void Hello()
    {
        bConnecting=false;Sequence=0;auto O=MakeShared<FJsonObject>();O->SetStringField(TEXT("type"),TEXT("hello"));O->SetNumberField(TEXT("protocol"),1);O->SetStringField(TEXT("editorId"),EditorId);O->SetStringField(TEXT("project"),FApp::GetProjectName());O->SetStringField(TEXT("projectPath"),FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));O->SetStringField(TEXT("engineVersion"),FEngineVersion::Current().ToString());O->SetNumberField(TEXT("pid"),FPlatformProcess::GetCurrentProcessId());
        TArray<TSharedPtr<FJsonValue>> Caps;for(const TCHAR* Name:{TEXT("selection"),TEXT("level_selection"),TEXT("blueprint_component_selection"),TEXT("runtime_inspection"),TEXT("read_blueprint"),TEXT("preview_patch"),TEXT("apply_patch"),TEXT("create_blueprint"),TEXT("undo"),TEXT("save"),TEXT("request_status"),TEXT("mcp_tools"),TEXT("mcp_target_validation"),TEXT("mcp_operation_context"),TEXT("safe_asset_presentation"),TEXT("project_knowledge"),TEXT("focus_asset"),TEXT("custom_event_patch"),TEXT("visual_capture"),TEXT("data_table_copy_property"),TEXT("automatic_graph_layout"),TEXT("level_blueprint_lookup"),TEXT("material_graph_patch")})Caps.Add(MakeShared<FJsonValueString>(Name));O->SetArrayField(TEXT("capabilities"),Caps);Send(O);
    }
    TSharedPtr<FJsonObject> Error(const FString& Id,const FString& Code,const FString& Message,const TSharedPtr<FJsonObject>& Details=nullptr)
    {
        auto O=MakeShared<FJsonObject>();O->SetStringField(TEXT("type"),TEXT("response"));O->SetStringField(TEXT("id"),Id);O->SetBoolField(TEXT("ok"),false);auto E=MakeShared<FJsonObject>();E->SetStringField(TEXT("code"),Code);E->SetStringField(TEXT("message"),Message);if(Details.IsValid())E->SetObjectField(TEXT("details"),Details);O->SetObjectField(TEXT("error"),E);return O;
    }
    TSharedPtr<FJsonObject> BoundResponse(const TSharedPtr<FJsonObject>& Response,const FString& OversizeMessage=TEXT("Response exceeds the 2 MiB bridge limit; request a smaller result"))
    {
        if(FTCHARToUTF8(*Encode(Response)).Length()<=2*1024*1024)return Response;
        const FString Id=Field(Response,TEXT("id"));
        bool bOk=false;
        const TSharedPtr<FJsonObject>* Failure=nullptr;
        if(Response->TryGetBoolField(TEXT("ok"),bOk)&&!bOk&&Response->TryGetObjectField(TEXT("error"),Failure)&&Failure&&Failure->IsValid())
        {
            const auto Compact=CompactFailure(*Failure,TEXT("TOOL_ERROR"));
            return Error(Id,Field(Compact,TEXT("code")),Field(Compact,TEXT("message")),Compact->GetObjectField(TEXT("details")));
        }
        const TSharedPtr<FJsonObject>* Result=nullptr;
        if(bOk&&Response->TryGetObjectField(TEXT("result"),Result)&&Result&&Result->IsValid())
        {
            bool bMcpError=false,bInnerOk=true;
            (*Result)->TryGetBoolField(TEXT("isError"),bMcpError);
            const bool bFailedInner=(*Result)->TryGetBoolField(TEXT("ok"),bInnerOk)&&!bInnerOk;
            if(bMcpError||bFailedInner)
            {
                const auto Compact=CompactFailure(*Result,TEXT("MCP_TOOL_ERROR"));
                auto BoundedResult=MakeShared<FJsonObject>();BoundedResult->SetBoolField(TEXT("isError"),true);BoundedResult->SetObjectField(TEXT("error"),Compact);
                auto Bounded=MakeShared<FJsonObject>();Bounded->SetStringField(TEXT("type"),TEXT("response"));Bounded->SetStringField(TEXT("id"),Id);Bounded->SetBoolField(TEXT("ok"),true);Bounded->SetObjectField(TEXT("result"),BoundedResult);
                return Bounded;
            }
        }
        return Error(Id,TEXT("RESPONSE_TOO_LARGE"),OversizeMessage);
    }
    void CompleteMcp(const FString& Id,const TSharedPtr<FJsonObject>& Result,const FString& Code,const FString& Message,bool bWrite)
    {
        if(!PendingMcp.Contains(Id))return;
        PendingMcp.Remove(Id);
        TSharedPtr<FJsonObject> Response;
        if(Result)
        {
            Response=MakeShared<FJsonObject>();Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);
        }
        else Response=Error(Id,Code,Message);
        Response=BoundResponse(Response,TEXT("MCP result exceeds the 2 MiB bridge limit"));
        if(bWrite){Results.Add(Id,Response);ResultOrder.Add(Id);if(ResultOrder.Num()>1024){Results.Remove(ResultOrder[0]);ResultOrder.RemoveAt(0);}}
        FinishWrite(Id);
        Send(Response);
    }
    void CompleteKnowledge(const FString& Id,bool bSuccess,const TSharedPtr<FJsonObject>& Result,bool bWrite)
    {
        if(!PendingKnowledge.Remove(Id))return;
        TSharedPtr<FJsonObject> Response;
        if(bSuccess&&Result.IsValid())
        {
            Response=MakeShared<FJsonObject>();Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);
        }
        else Response=Error(Id,TEXT("KNOWLEDGE_ERROR"),Result.IsValid()?Field(Result,TEXT("error")):TEXT("Knowledge request failed"));
        Response=BoundResponse(Response,TEXT("Narrow the knowledge query or request a smaller page"));
        if(bWrite){Results.Add(Id,Response);ResultOrder.Add(Id);if(ResultOrder.Num()>1024){Results.Remove(ResultOrder[0]);ResultOrder.RemoveAt(0);}}
        FinishWrite(Id);
        Send(Response);
    }
    void Request(const TSharedPtr<FJsonObject>& Message)
    {
        const FString Id=Field(Message,TEXT("id")),Method=Field(Message,TEXT("method"));double Protocol=0;const TSharedPtr<FJsonObject>* ParamsPtr=nullptr;
        if(Id.IsEmpty()||Id.Len()>160||!Message->TryGetNumberField(TEXT("protocol"),Protocol)||Protocol!=1||!Message->TryGetObjectField(TEXT("params"),ParamsPtr)){Send(Error(Id,TEXT("INVALID_REQUEST"),TEXT("Invalid request envelope")));return;}
        const auto Params=*ParamsPtr;
        // Pending IDs belong to their original dispatch, including discovery and
        // read callbacks. Another method must not reuse one and release its writer.
        if(PendingMcp.Contains(Id)||PendingKnowledge.Contains(Id)||PendingWriteRequestId==Id)
        {
            const FString Hash=RequestHash(Method,Params);
            const FString* Previous=RequestHashes.Find(Id);
            Send(Previous&&*Previous!=Hash
                ?Error(Id,TEXT("IDEMPOTENCY_MISMATCH"),TEXT("Request ID has different parameters"))
                :Error(Id,TEXT("IN_PROGRESS"),TEXT("This request is still running; query request status")));
            return;
        }
        if(Method==TEXT("mcp_operation_context"))
        {
            const TSharedPtr<FJsonObject>* Arguments=nullptr;
            FString ContextCode,ContextMessage;TSharedPtr<FJsonObject> ContextDetails;
            if(!Params->TryGetObjectField(TEXT("arguments"),Arguments)||!Arguments||!Arguments->IsValid())
            {
                auto Details=MakeShared<FJsonObject>();Details->SetStringField(TEXT("execution"),TEXT("not_started"));Details->SetBoolField(TEXT("retryable"),true);
                Send(Error(Id,TEXT("INVALID_REQUEST"),TEXT("Operation preflight requires the exact MCP name and arguments object"),Details));return;
            }
            const auto Result=OperationContexts.Prepare(Field(Params,TEXT("name")),*Arguments,ContextDetails,ContextCode,ContextMessage);
            auto Response=Result?MakeShared<FJsonObject>():Error(Id,ContextCode,ContextMessage,ContextDetails);
            if(Result){Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
            Send(Response);return;
        }
        if(Method==TEXT("resolve_level_blueprint"))
        {
            FString LookupCode,LookupError;
            const auto Result=FDSHLevelBlueprintLookup::Resolve(Params,LookupCode,LookupError);
            auto Response=Result?MakeShared<FJsonObject>():Error(Id,LookupCode,LookupError);
            if(Result){Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
            Response=BoundResponse(Response,TEXT("Level Blueprint graph summaries exceed the bridge response limit"));
            Send(Response);return;
        }
        if(Method==TEXT("runtime_snapshot"))
        {
            FString RuntimeCode,RuntimeError;
            auto Result=RuntimeInspector.Snapshot(Params,RuntimeCode,RuntimeError);
            auto Response=Result?MakeShared<FJsonObject>():Error(Id,RuntimeCode,RuntimeError);
            if(Result){Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
            Response=BoundResponse(Response,TEXT("Request fewer runtime properties or components"));
            Send(Response);return;
        }
        if(Method==TEXT("visual_capture"))
        {
            FString CaptureError,CaptureCode;
            const auto Result=FDSHVisualCapture::Capture(Params,CaptureError,CaptureCode);
            auto Response=Result?MakeShared<FJsonObject>():Error(Id,CaptureCode,CaptureError);
            if(Result){Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
            Send(Response);return;
        }
        if(Method==TEXT("request_status"))
        {
            const FString QueryId=Field(Params,TEXT("requestId"));auto R=MakeShared<FJsonObject>();auto Result=MakeShared<FJsonObject>();Result->SetStringField(TEXT("status"),Results.Contains(QueryId)?TEXT("completed"):PendingMcp.Contains(QueryId)||PendingKnowledge.Contains(QueryId)||PendingWriteRequestId==QueryId?TEXT("pending"):RequestHashes.Contains(QueryId)?TEXT("expired"):TEXT("unknown"));if(Results.Contains(QueryId))Result->SetObjectField(TEXT("response"),Results[QueryId]);R->SetStringField(TEXT("type"),TEXT("response"));R->SetStringField(TEXT("id"),Id);R->SetBoolField(TEXT("ok"),true);R->SetObjectField(TEXT("result"),Result);Send(R);return;
        }
        if(Method==TEXT("focus_asset"))
        {
            FDSHAssetViewHint Hint;
            Hint.AssetPath=Field(Params,TEXT("assetPath"));Hint.Graph=Field(Params,TEXT("graph"));
            UObject* FocusTarget=FDSHAssetPresentation::ResolveSupportedTarget(Hint.AssetPath);
            if(!FocusTarget){Send(Error(Id,TEXT("FOCUS_TARGET_UNAVAILABLE"),TEXT("Only an already-loaded supported asset or its graph can be focused; maps and arbitrary objects are not presentation targets")));return;}
            if(!FDSHAssetPresentation::CanPresentInWorld(FocusTarget,GEditor?GEditor->GetEditorWorldContext().World():nullptr)){Send(Error(Id,TEXT("FOCUS_WOULD_SWITCH_MAP"),TEXT("This level Blueprint does not belong to the current editor world; focusing must not open or reload its map")));return;}
            Hint.AssetPath=FocusTarget->GetPathName();
            const TArray<TSharedPtr<FJsonValue>>* NodeIds=nullptr;
            if(Params->TryGetArrayField(TEXT("nodeIds"),NodeIds))for(const auto& Node:*NodeIds)if(Node.IsValid()&&Node->Type==EJson::String)Hint.NodeIds.Add(Node->AsString());
            Presentation.Queue(Hint);
            auto Result=MakeShared<FJsonObject>();Result->SetBoolField(TEXT("queued"),true);
            auto Response=MakeShared<FJsonObject>();Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);Send(Response);return;
        }
        const FString KnowledgeTool=Method==TEXT("knowledge_call")?Field(Params,TEXT("tool")):FString();
        const TSharedPtr<FJsonObject>* KnowledgeArguments=nullptr;
        if(Method==TEXT("knowledge_call")&&(!FProjectKnowledgeService::IsBridgeTool(KnowledgeTool)||!Params->TryGetObjectField(TEXT("arguments"),KnowledgeArguments)||!KnowledgeArguments||!KnowledgeArguments->IsValid()))
        {
            Send(Error(Id,TEXT("INVALID_REQUEST"),TEXT("Unknown knowledge tool or invalid arguments")));return;
        }
        const bool bKnowledgeWrite=FProjectKnowledgeService::IsWriteTool(KnowledgeTool);
        bool bMaterialDryRun=true;
        if(Method==TEXT("material_patch"))Params->TryGetBoolField(TEXT("dryRun"),bMaterialDryRun);
        const bool bWrite=Method==TEXT("apply_patch")||Method==TEXT("create_blueprint")||Method==TEXT("undo")||Method==TEXT("save")||Method==TEXT("mcp_call_tool")||Method==TEXT("data_table_copy_property")||(Method==TEXT("material_patch")&&!bMaterialDryRun)||bKnowledgeWrite;
        const bool bMutation=bWrite&&(Method!=TEXT("mcp_call_tool")||!IsAuditedMcpRead(Params));
        if(bWrite)
        {
            const FString Hash=RequestHash(Method,Params);
            if(const FString* Previous=RequestHashes.Find(Id)){if(*Previous!=Hash)Send(Error(Id,TEXT("IDEMPOTENCY_MISMATCH"),TEXT("Request ID has different parameters")));else if(Results.Contains(Id))Send(Results[Id]);else if(PendingMcp.Contains(Id)||PendingKnowledge.Contains(Id))Send(Error(Id,TEXT("IN_PROGRESS"),TEXT("This tool call is still running; query request status")));else Send(Error(Id,TEXT("RESULT_EXPIRED"),TEXT("This write already ran; cached result expired, do not repeat")));return;}
            if(bMutation&&!PendingWriteRequestId.IsEmpty())
            {
                auto Details=MakeShared<FJsonObject>();Details->SetStringField(TEXT("execution"),TEXT("not_started"));Details->SetBoolField(TEXT("retryable"),true);Details->SetStringField(TEXT("pendingRequestId"),PendingWriteRequestId);
                Send(Error(Id,TEXT("EDITOR_BUSY"),TEXT("An editor mutation is still running; query its request status before another write"),Details));return;
            }
            if(Method==TEXT("mcp_call_tool"))
            {
                const TSharedPtr<FJsonObject>* ToolArguments=nullptr;
                FString ValidationCode,ValidationMessage;TSharedPtr<FJsonObject> ValidationDetails;
                if(!Params->TryGetObjectField(TEXT("arguments"),ToolArguments)||!ToolArguments||!ToolArguments->IsValid())
                {
                    Send(Error(Id,TEXT("INVALID_REQUEST"),TEXT("MCP tool arguments object is required")));return;
                }
                // Inspect current native tool metadata and real UObject types on
                // the game thread before snapshots, tool execution or journaling.
                // Rejected requests may be corrected without a new request UUID.
                const bool bValid=Params->HasField(TEXT("operationToken"))
                    ?OperationContexts.Verify(Field(Params,TEXT("operationToken")),Field(Params,TEXT("name")),*ToolArguments,bMutation,ValidationDetails,ValidationCode,ValidationMessage)
                    :FDSHMcpTargetValidation::Validate(Field(Params,TEXT("name")),*ToolArguments,ValidationDetails,ValidationCode,ValidationMessage);
                if(!bValid)
                {
                    Send(Error(Id,ValidationCode,ValidationMessage,ValidationDetails));return;
                }
            }
            if(RequestHashes.Num()>=10000){Send(Error(Id,TEXT("REQUEST_LIMIT"),TEXT("Write request journal is full; restart the editor after reconciling pending requests")));return;}
            if(Method==TEXT("mcp_call_tool")&&Params->HasField(TEXT("operationToken")))OperationContexts.Consume(Field(Params,TEXT("operationToken")));
            RequestHashes.Add(Id,Hash);
            if(bMutation)PendingWriteRequestId=Id;
        }
        if(Method==TEXT("mcp_list_tools"))
        {
            FString MCPError;auto Result=IDSHUnrealBridgeMCPModule::Get().ListTools(MCPError);
            auto Response=Result?MakeShared<FJsonObject>():Error(Id,TEXT("MCP_UNAVAILABLE"),MCPError);
            if(Result){Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
            Response=BoundResponse(Response,TEXT("MCP tool list exceeds the 2 MiB bridge limit"));
            Send(Response);return;
        }
        if(Method==TEXT("knowledge_call"))
        {
            const TWeakPtr<FDSHConnection> Weak=AsShared();
            const FGuid KnowledgeId=FProjectKnowledgeService::Execute(KnowledgeTool,*KnowledgeArguments,nullptr,
                [Weak,Id,bWrite](bool bSuccess,TSharedPtr<FJsonObject> Result)
                {
                    if(auto Self=Weak.Pin())Self->CompleteKnowledge(Id,bSuccess,Result,bWrite);
                });
            PendingKnowledge.Add(Id,KnowledgeId);
            return;
        }
        if(Method==TEXT("mcp_discover")||Method==TEXT("mcp_call_tool"))
        {
            const FString Name=Field(Params,TEXT("name"));
            if(Method==TEXT("mcp_discover")&&Name!=TEXT("list_toolsets")&&Name!=TEXT("describe_toolset")){auto Response=Error(Id,TEXT("INVALID_REQUEST"),TEXT("Only MCP toolset discovery is allowed without write approval"));Send(Response);return;}
            const TSharedPtr<FJsonObject>* ArgumentsPtr=nullptr;
            if(Name.IsEmpty()||!Params->TryGetObjectField(TEXT("arguments"),ArgumentsPtr)||!ArgumentsPtr||!ArgumentsPtr->IsValid())
            {
                auto Response=Error(Id,TEXT("INVALID_REQUEST"),TEXT("MCP tool name and arguments object are required"));
                if(bWrite){Results.Add(Id,Response);ResultOrder.Add(Id);if(ResultOrder.Num()>1024){Results.Remove(ResultOrder[0]);ResultOrder.RemoveAt(0);}}
                FinishWrite(Id);
                Send(Response);return;
            }
            PendingMcp.Add(Id);
            const TWeakPtr<FDSHConnection> Weak=AsShared();
            FString MCPError;
            const TSharedPtr<FJsonObject> ToolArguments=*ArgumentsPtr;
            const auto Before=FDSHMcpEditAdapter::CaptureCallGraphs(Name,ToolArguments);
            const bool bStarted=IDSHUnrealBridgeMCPModule::Get().CallTool(Name,ToolArguments,Id,
                [Weak,Id,bWrite,Name,ToolArguments,Before](TSharedPtr<FJsonObject> Result)
                {
                    auto Finish=[Weak,Id,bWrite,Result,Name,ToolArguments,Before]()
                    {
                        if(auto Self=Weak.Pin())
                        {
                            if(!Self->PendingMcp.Contains(Id))return;
                            auto Hints=FDSHMcpEditAdapter::FinalizeCall(Name,ToolArguments,Result,Before);
                            for(const FDSHAssetViewHint& Hint:Hints)Self->Presentation.Queue(Hint);
                            Self->CompleteMcp(Id,Result,TEXT("MCP_TOOL_ERROR"),TEXT("MCP tool returned no result"),bWrite);
                        }
                    };
                    if(IsInGameThread())Finish();else AsyncTask(ENamedThreads::GameThread,MoveTemp(Finish));
                },MCPError);
            if(!bStarted)CompleteMcp(Id,nullptr,TEXT("MCP_UNAVAILABLE"),MCPError,bWrite);
            return;
        }
        FString Code,MessageText;FDSHAssetViewHint ViewHint;TSharedPtr<FJsonObject> ErrorDetails;
        auto Result=Method==TEXT("data_table_copy_property")?FDSHDataTableOps::CopyProperty(Params,Code,MessageText,ErrorDetails)
            :Method==TEXT("material_read")||Method==TEXT("material_patch")?FDSHMaterialOps::Execute(Method,Params,Code,MessageText,ErrorDetails,&ViewHint)
            :Operations.Execute(Method,Params,Code,MessageText,&ViewHint,&ErrorDetails);TSharedPtr<FJsonObject> Response;
        if(Result){Response=MakeShared<FJsonObject>();Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
        else Response=Error(Id,Code,MessageText,ErrorDetails);
        Response=BoundResponse(Response,TEXT("Read a summary or filter by graph and nodeIds; response exceeds 2 MiB"));
        if(bWrite){Results.Add(Id,Response);ResultOrder.Add(Id);if(ResultOrder.Num()>1024){Results.Remove(ResultOrder[0]);ResultOrder.RemoveAt(0);}}
        FinishWrite(Id);
        Send(Response);
        if(Result&&!ViewHint.AssetPath.IsEmpty())Presentation.Queue(ViewHint);
        const FString Path=Field(Params,TEXT("assetPath"));
        if(!Path.IsEmpty())
        {
            const FString Package=FPackageName::ObjectPathToPackageName(Path);if(UBlueprint* BP=FindObject<UBlueprint>(nullptr,*(Package+TEXT(".")+FPackageName::GetShortName(Package)))){if(!Watched.Contains(BP))Watched.Add(BP,FDSHBlueprintOps::Revision(BP));if(bWrite)Dirty.Add(BP);}
        }
    }
    bool Tick(float)
    {
        if(RuntimeInspector.Tick())
        {
            EditorSelection.RefreshRuntimeSelection();
            Event(TEXT("runtime_changed"),RuntimeInspector.GetEvent());
        }
        if(EditorSelection.Tick())SendSelection();
        FIncoming Incoming;int32 Count=0;
        while(Count++<4&&Inbox.Dequeue(Incoming))
        {
            if(Incoming.Generation!=Generation)continue;
            const FString& Message=Incoming.Message;
            if(Message==TEXT("__connected")){Hello();continue;}
            if(Message==TEXT("__disconnected")){bConnecting=false;bAuthenticated=false;continue;}
            const auto O=Decode(Message);if(!O)continue;const FString Type=Field(O,TEXT("type"));
            if(Type==TEXT("hello_ack")){bAuthenticated=true;Event(TEXT("runtime_changed"),RuntimeInspector.GetEvent());SendSelection();continue;}
            if(bAuthenticated&&Type==TEXT("request"))Request(O);
        }
        Presentation.Tick();
        const double Now=FPlatformTime::Seconds();
        if((!Socket||!Socket->IsConnected())&&Now-LastConnect>2.0&&(!bConnecting||Now-LastConnect>10.0)){LastConnect=Now;Connect();}
        for(auto Weak:Dirty)
        {
            if(UBlueprint* BP=Weak.Get())
            {
                const FString Current=FDSHBlueprintOps::Revision(BP);FString& Old=Watched.FindOrAdd(BP);if(Current!=Old){Old=Current;auto D=MakeShared<FJsonObject>();D->SetStringField(TEXT("assetPath"),BP->GetPathName());D->SetStringField(TEXT("revision"),Current);Event(TEXT("blueprint_changed"),D);}
            }
        }
        Dirty.Reset();return true;
    }
};

#if WITH_DEV_AUTOMATION_TESTS
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpOperationAdmissionTest,"DSH.Bridge.McpOperationContext.DispatchAdmission",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHMcpOperationAdmissionTest::RunTest(const FString&)
{
    const auto Connection=MakeShared<FDSHConnection>();
    TArray<TSharedPtr<FJsonObject>> Responses;
    Connection->ObserveTestResponse=[&Responses](const TSharedPtr<FJsonObject>& Response){Responses.Add(Response);};
    auto Dispatch=[&Connection](const FString& Id,const FString& Method,const TSharedPtr<FJsonObject>& Params)
    {
        auto Envelope=MakeShared<FJsonObject>();Envelope->SetStringField(TEXT("id"),Id);Envelope->SetNumberField(TEXT("protocol"),1);Envelope->SetStringField(TEXT("method"),Method);Envelope->SetObjectField(TEXT("params"),Params);Connection->Request(Envelope);
    };
    auto ErrorCode=[&Responses](){return Field(Responses.Last()->GetObjectField(TEXT("error")),TEXT("code"));};
    TStrongObjectPtr<UBlueprint> Blueprint(NewObject<UBlueprint>(GetTransientPackage(),NAME_None,RF_Transient));
    UEdGraph* Graph=NewObject<UEdGraph>(Blueprint.Get(),TEXT("OperationGraph"),RF_Transient);
    Graph->Schema=UEdGraphSchema_K2::StaticClass();Blueprint->UbergraphPages.Add(Graph);
    UEdGraphNode* Node=NewObject<UEdGraphNode>(Graph,TEXT("OperationNode"),RF_Transient);Graph->AddNode(Node,false,false);
    Node->NodePosX=87;
    auto Params=MakeShared<FJsonObject>(),Arguments=MakeShared<FJsonObject>(),Reference=MakeShared<FJsonObject>();
    Reference->SetStringField(TEXT("refPath"),Node->GetPathName());Arguments->SetObjectField(TEXT("instance"),Reference);Arguments->SetStringField(TEXT("values"),TEXT("{\"NodePosX\":123}"));
    auto DispatchArguments=MakeShared<FJsonObject>();DispatchArguments->SetStringField(TEXT("toolset_name"),TEXT("editor_toolset.toolsets.object.ObjectTools"));DispatchArguments->SetStringField(TEXT("tool_name"),TEXT("set_properties"));DispatchArguments->SetObjectField(TEXT("arguments"),Arguments);
    Params->SetStringField(TEXT("name"),TEXT("call_tool"));Params->SetObjectField(TEXT("arguments"),DispatchArguments);
    Dispatch(TEXT("context-read"),TEXT("mcp_operation_context"),Params);
    if(!TestTrue(TEXT("Internal context request succeeds"),Responses.Last()->GetBoolField(TEXT("ok"))))return false;
    const FString Token=Responses.Last()->GetObjectField(TEXT("result"))->GetStringField(TEXT("token"));
    TestEqual(TEXT("Preflight never executed the native write"),Node->NodePosX,87);
    TestTrue(TEXT("Preflight does not consume a write UUID"),Connection->RequestHashes.IsEmpty());
    TestTrue(TEXT("Preflight does not enter MCP dispatch"),Connection->PendingMcp.IsEmpty());
    TestTrue(TEXT("Preflight does not take the write slot"),Connection->PendingWriteRequestId.IsEmpty());
    Params->SetStringField(TEXT("operationToken"),TEXT("unknown-token"));
    Dispatch(TEXT("write-uuid"),TEXT("mcp_call_tool"),Params);
    TestEqual(TEXT("Unknown token fails before dispatch"),ErrorCode(),FString(TEXT("MCP_OPERATION_TOKEN_INVALID")));
    TestFalse(TEXT("Unknown token does not consume UUID"),Connection->RequestHashes.Contains(TEXT("write-uuid")));
    TestEqual(TEXT("Unknown token proves execution did not start"),Field(Responses.Last()->GetObjectField(TEXT("error"))->GetObjectField(TEXT("details")),TEXT("execution")),FString(TEXT("not_started")));
    Params->SetStringField(TEXT("operationToken"),Token);
    Arguments->SetStringField(TEXT("values"),TEXT("{\"NodePosX\":456}"));
    Dispatch(TEXT("write-uuid"),TEXT("mcp_call_tool"),Params);
    TestEqual(TEXT("Changed arguments fail before dispatch"),ErrorCode(),FString(TEXT("MCP_OPERATION_CALL_MISMATCH")));
    TestFalse(TEXT("Changed arguments do not consume UUID"),Connection->RequestHashes.Contains(TEXT("write-uuid")));
    Arguments->SetStringField(TEXT("values"),TEXT("{\"NodePosX\":123}"));
    Connection->PendingWriteRequestId=TEXT("another-write");
    Dispatch(TEXT("write-uuid"),TEXT("mcp_call_tool"),Params);
    TestEqual(TEXT("A token never bypasses mutation coordination"),ErrorCode(),FString(TEXT("EDITOR_BUSY")));
    FString Code,Message;TSharedPtr<FJsonObject> Details;
    TestTrue(TEXT("Busy rejection leaves evidence available"),Connection->OperationContexts.Verify(Token,Field(Params,TEXT("name")),DispatchArguments,true,Details,Code,Message));
    Connection->PendingWriteRequestId.Reset();
    const FString OldPath=Node->GetPathName();
    Node->Rename(TEXT("RetiredOperationNode"),nullptr,REN_DontCreateRedirectors|REN_NonTransactional|REN_DoNotDirty);Graph->Nodes.Remove(Node);Node->MarkAsGarbage();
    UEdGraphNode* Replacement=NewObject<UEdGraphNode>(Graph,TEXT("OperationNode"),RF_Transient);Graph->AddNode(Replacement,false,false);Replacement->NodePosX=99;
    TestEqual(TEXT("Native replacement uses the old exact path"),Replacement->GetPathName(),OldPath);
    Dispatch(TEXT("write-uuid"),TEXT("mcp_call_tool"),Params);
    TestEqual(TEXT("Weak identity mismatch is rejected"),ErrorCode(),FString(TEXT("MCP_OPERATION_TARGET_CHANGED")));
    TestFalse(TEXT("Stale identity does not consume UUID"),Connection->RequestHashes.Contains(TEXT("write-uuid")));
    TestTrue(TEXT("Rejected writes never enter MCP dispatch"),Connection->PendingMcp.IsEmpty());
    TestEqual(TEXT("Replacement is untouched"),Replacement->NodePosX,99);

    // Journal replay precedes token validation, including refreshed/expired
    // evidence. Neither cached nor pending UUIDs may execute a second time.
    const FString ReplayId=TEXT("completed-operation");
    auto Cached=MakeShared<FJsonObject>();Cached->SetStringField(TEXT("type"),TEXT("response"));Cached->SetStringField(TEXT("id"),ReplayId);Cached->SetBoolField(TEXT("ok"),true);Cached->SetObjectField(TEXT("result"),MakeShared<FJsonObject>());
    Connection->RequestHashes.Add(ReplayId,RequestHash(TEXT("mcp_call_tool"),Params));Connection->Results.Add(ReplayId,Cached);
    Params->SetStringField(TEXT("operationToken"),TEXT("refreshed-token"));
    Dispatch(ReplayId,TEXT("mcp_call_tool"),Params);
    TestTrue(TEXT("Completed UUID returns its cached response with a new token"),Responses.Last()==Cached);
    Connection->RequestHashes.Add(TEXT("pending-operation"),RequestHash(TEXT("mcp_call_tool"),Params));Connection->PendingMcp.Add(TEXT("pending-operation"));
    Params->SetStringField(TEXT("operationToken"),TEXT("another-refreshed-token"));
    Dispatch(TEXT("pending-operation"),TEXT("mcp_call_tool"),Params);
    TestEqual(TEXT("Pending replay excludes the wire token from its identity"),ErrorCode(),FString(TEXT("IN_PROGRESS")));
    TestEqual(TEXT("Replays never touch the replacement"),Replacement->NodePosX,99);
    Connection->ObserveTestResponse=nullptr;
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHWriteCoordinationTest,"DSH.Bridge.WriteCoordination.AsyncAdmission",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHWriteCoordinationTest::RunTest(const FString&)
{
    const auto Connection=MakeShared<FDSHConnection>();
    TArray<TSharedPtr<FJsonObject>> Responses;
    Connection->ObserveTestResponse=[&Responses](const TSharedPtr<FJsonObject>& Response){Responses.Add(Response);};
    auto Dispatch=[&Connection](const FString& Id,const FString& Method,const TSharedPtr<FJsonObject>& Params)
    {
        auto Envelope=MakeShared<FJsonObject>();Envelope->SetStringField(TEXT("id"),Id);Envelope->SetNumberField(TEXT("protocol"),1);Envelope->SetStringField(TEXT("method"),Method);Envelope->SetObjectField(TEXT("params"),Params);Connection->Request(Envelope);
    };
    auto ErrorCode=[&Responses](){return Field(Responses.Last()->GetObjectField(TEXT("error")),TEXT("code"));};
    auto ToolParams=[](const FString& Tool,bool bDispatcher)
    {
        auto Params=MakeShared<FJsonObject>(),Arguments=MakeShared<FJsonObject>();
        const FString Toolset=TEXT("editor_toolset.toolsets.data_table.DataTableTools");
        Params->SetStringField(TEXT("name"),bDispatcher?TEXT("call_tool"):Toolset+TEXT(".")+Tool);
        if(bDispatcher){Arguments->SetStringField(TEXT("toolset_name"),Toolset);Arguments->SetStringField(TEXT("tool_name"),Tool);Arguments->SetObjectField(TEXT("arguments"),MakeShared<FJsonObject>());}
        Params->SetObjectField(TEXT("arguments"),Arguments);return Params;
    };
    for(const TCHAR* Tool:{TEXT("get_schema"),TEXT("list_rows"),TEXT("get_rows"),TEXT("search_row_structs")})
    {
        TestTrue(TEXT("Audited direct query remains read-only"),IsAuditedMcpRead(ToolParams(Tool,false)));
        TestTrue(TEXT("Audited dispatcher query remains read-only"),IsAuditedMcpRead(ToolParams(Tool,true)));
    }
    for(const TCHAR* Tool:{TEXT("list_expression_classes"),TEXT("get_expressions"),TEXT("list_parameter_groups"),
        TEXT("get_expression_input_names"),TEXT("get_expression_output_names"),TEXT("get_expression_inputs"),
        TEXT("get_property_input"),TEXT("get_referencing_materials")})
    {
        auto Params=MakeShared<FJsonObject>(),Arguments=MakeShared<FJsonObject>();
        const FString Toolset=TEXT("editor_toolset.toolsets.material.MaterialTools");
        Params->SetStringField(TEXT("name"),Toolset+TEXT(".")+Tool);
        Params->SetObjectField(TEXT("arguments"),Arguments);
        TestTrue(TEXT("Audited material query remains read-only"),IsAuditedMcpRead(Params));
        Params->SetStringField(TEXT("name"),TEXT("call_tool"));
        Arguments->SetStringField(TEXT("toolset_name"),Toolset);Arguments->SetStringField(TEXT("tool_name"),Tool);
        Arguments->SetObjectField(TEXT("arguments"),MakeShared<FJsonObject>());
        TestTrue(TEXT("Audited dispatched material query remains read-only"),IsAuditedMcpRead(Params));
    }
    auto UnknownRead=ToolParams(TEXT("get_and_mutate"),true);
    UnknownRead->SetBoolField(TEXT("readOnlyHint"),true);
    TestFalse(TEXT("An unknown get-prefixed tool cannot claim read safety"),IsAuditedMcpRead(UnknownRead));

    // Model a dispatched tool whose asynchronous completion has not arrived.
    // Exercise the real request/journal/completion paths without editing an asset.
    const FString WriteId=TEXT("pending-write");
    const auto WriteParams=ToolParams(TEXT("set_properties"),true);
    const FTCHARToUTF8 WriteBytes(*(FString(TEXT("mcp_call_tool"))+Encode(WriteParams)));
    Connection->RequestHashes.Add(WriteId,FMD5::HashBytes(reinterpret_cast<const uint8*>(WriteBytes.Get()),WriteBytes.Length()));
    Connection->PendingMcp.Add(WriteId);
    Connection->PendingWriteRequestId=WriteId;
    auto SaveParams=MakeShared<FJsonObject>();SaveParams->SetStringField(TEXT("assetPath"),TEXT("/Game/DSH_Missing_Coordination_Test"));
    Dispatch(TEXT("second-write"),TEXT("save"),SaveParams);
    TestEqual(TEXT("A second mutation is rejected while the first is asynchronous"),ErrorCode(),FString(TEXT("EDITOR_BUSY")));
    TestFalse(TEXT("A busy rejection does not consume its UUID"),Connection->RequestHashes.Contains(TEXT("second-write")));
    TestEqual(TEXT("The busy error identifies the original request"),Field(Responses.Last()->GetObjectField(TEXT("error"))->GetObjectField(TEXT("details")),TEXT("pendingRequestId")),WriteId);
    Dispatch(WriteId,TEXT("mcp_call_tool"),WriteParams);
    TestEqual(TEXT("The same pending request is not dispatched twice"),ErrorCode(),FString(TEXT("IN_PROGRESS")));
    Dispatch(WriteId,TEXT("mcp_discover"),MakeShared<FJsonObject>());
    TestEqual(TEXT("Discovery cannot reuse an in-flight write UUID"),ErrorCode(),FString(TEXT("IDEMPOTENCY_MISMATCH")));
    TestEqual(TEXT("A duplicate UUID cannot release its writer"),Connection->PendingWriteRequestId,WriteId);
    Dispatch(TEXT("unknown-query"),TEXT("mcp_call_tool"),UnknownRead);
    TestEqual(TEXT("Unknown query names use the mutation gate"),ErrorCode(),FString(TEXT("EDITOR_BUSY")));

    auto Query=MakeShared<FJsonObject>();Query->SetStringField(TEXT("requestId"),WriteId);
    Dispatch(TEXT("status-before"),TEXT("request_status"),Query);
    TestEqual(TEXT("Status queries remain available while a write is pending"),Field(Responses.Last()->GetObjectField(TEXT("result")),TEXT("status")),FString(TEXT("pending")));
    const auto ReadParams=ToolParams(TEXT("get_rows"),true);
    Dispatch(TEXT("audited-read"),TEXT("mcp_call_tool"),ReadParams);
    TestTrue(TEXT("An audited read reaches native target validation while a write is pending"),ErrorCode().StartsWith(TEXT("MCP_TARGET_")));
    TestEqual(TEXT("A rejected read does not release the writer"),Connection->PendingWriteRequestId,WriteId);
    Connection->PendingMcp.Add(TEXT("other-read"));
    Connection->CompleteMcp(TEXT("other-read"),MakeShared<FJsonObject>(),FString(),FString(),true);
    TestEqual(TEXT("An unrelated read completion cannot release the writer"),Connection->PendingWriteRequestId,WriteId);
    Connection->PendingKnowledge.Add(TEXT("knowledge-read"),FGuid::NewGuid());
    Connection->CompleteKnowledge(TEXT("knowledge-read"),true,MakeShared<FJsonObject>(),false);
    TestEqual(TEXT("An unrelated knowledge completion cannot release the writer"),Connection->PendingWriteRequestId,WriteId);

    Connection->CompleteMcp(WriteId,nullptr,TEXT("MCP_TOOL_ERROR"),TEXT("Synthetic completed failure"),true);
    TestTrue(TEXT("A definite MCP completion releases its mutation slot"),Connection->PendingWriteRequestId.IsEmpty());
    Dispatch(TEXT("status-after"),TEXT("request_status"),Query);
    TestEqual(TEXT("The completed failure remains available for reconciliation"),Field(Responses.Last()->GetObjectField(TEXT("result")),TEXT("status")),FString(TEXT("completed")));
    const int32 CompletedResponses=Responses.Num();
    Connection->CompleteMcp(WriteId,MakeShared<FJsonObject>(),FString(),FString(),true);
    TestEqual(TEXT("Duplicate completion cannot replace the recorded outcome"),Responses.Num(),CompletedResponses);
    Dispatch(TEXT("second-write"),TEXT("save"),SaveParams);
    TestTrue(TEXT("The rejected UUID can execute after the first mutation completes"),Connection->RequestHashes.Contains(TEXT("second-write")));
    TestTrue(TEXT("A synchronous failure is journaled"),Connection->Results.Contains(TEXT("second-write")));
    TestTrue(TEXT("A synchronous failure releases its slot"),Connection->PendingWriteRequestId.IsEmpty());

    Connection->PendingKnowledge.Add(TEXT("knowledge-write"),FGuid::NewGuid());
    Connection->PendingWriteRequestId=TEXT("knowledge-write");
    Dispatch(TEXT("during-knowledge"),TEXT("save"),SaveParams);
    TestEqual(TEXT("An asynchronous knowledge write blocks other mutations"),ErrorCode(),FString(TEXT("EDITOR_BUSY")));
    Connection->CompleteKnowledge(TEXT("knowledge-write"),true,MakeShared<FJsonObject>(),true);
    TestTrue(TEXT("Knowledge completion releases its slot"),Connection->PendingWriteRequestId.IsEmpty());
    TestTrue(TEXT("Knowledge completion is journaled before another writer"),Connection->Results.Contains(TEXT("knowledge-write")));
    Connection->ObserveTestResponse=nullptr;
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBoundedFailureTest,"DSH.Bridge.WriteCoordination.BoundedFailures",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHBoundedFailureTest::RunTest(const FString&)
{
    const auto Connection=MakeShared<FDSHConnection>();
    TArray<TSharedPtr<FJsonObject>> Responses;
    Connection->ObserveTestResponse=[&Responses](const TSharedPtr<FJsonObject>& Response){Responses.Add(Response);};
    const FString Large=FString::ChrN(2*1024*1024+1024,TCHAR('x'));
    auto Details=MakeShared<FJsonObject>();Details->SetStringField(TEXT("rollback"),TEXT("failed"));Details->SetBoolField(TEXT("retryable"),false);Details->SetStringField(TEXT("execution"),TEXT("completed"));Details->SetStringField(TEXT("diagnostic"),Large);
    const auto Native=Connection->Error(TEXT("native-rollback"),TEXT("ROLLBACK_FAILED"),Large,Details);
    TestTrue(TEXT("The native fixture exceeds the transport limit"),FTCHARToUTF8(*Encode(Native)).Length()>2*1024*1024);
    const auto Bounded=Connection->BoundResponse(Native);
    TestTrue(TEXT("The native failure fits the transport limit"),FTCHARToUTF8(*Encode(Bounded)).Length()<2*1024*1024);
    const auto Error=Bounded->GetObjectField(TEXT("error")),Safety=Error->GetObjectField(TEXT("details"));
    TestEqual(TEXT("Truncation preserves the original rollback error code"),Field(Error,TEXT("code")),FString(TEXT("ROLLBACK_FAILED")));
    TestEqual(TEXT("Truncation preserves failed rollback evidence"),Field(Safety,TEXT("rollback")),FString(TEXT("failed")));
    TestFalse(TEXT("A failed rollback cannot become retryable after truncation"),Safety->GetBoolField(TEXT("retryable")));
    TestEqual(TEXT("Execution status remains available"),Field(Safety,TEXT("execution")),FString(TEXT("completed")));
    TestTrue(TEXT("The oversized diagnostic message is bounded"),Field(Error,TEXT("message")).Len()<=2048);
    TestFalse(TEXT("Unbounded diagnostic fields are omitted"),Safety->HasField(TEXT("diagnostic")));

    Details->SetStringField(TEXT("rollback"),TEXT("restored"));Details->SetBoolField(TEXT("retryable"),true);
    const auto Restored=Connection->BoundResponse(Connection->Error(TEXT("native-restored"),TEXT("APPLY_FAILED_ROLLED_BACK"),Large,Details))->GetObjectField(TEXT("error"));
    TestEqual(TEXT("A verified rollback keeps its distinct code"),Field(Restored,TEXT("code")),FString(TEXT("APPLY_FAILED_ROLLED_BACK")));
    TestEqual(TEXT("A verified rollback is not relabeled as unsafe"),Field(Restored->GetObjectField(TEXT("details")),TEXT("rollback")),FString(TEXT("restored")));
    TestTrue(TEXT("A verified rollback keeps its correction opportunity"),Restored->GetObjectField(TEXT("details"))->GetBoolField(TEXT("retryable")));

    auto TextFailure=[&Large]()
    {
        auto Result=MakeShared<FJsonObject>(),Text=MakeShared<FJsonObject>();
        Text->SetStringField(TEXT("type"),TEXT("text"));Text->SetStringField(TEXT("text"),TEXT("Tool diagnostic: ROLLBACK_FAILED ")+Large);
        Result->SetBoolField(TEXT("isError"),true);Result->SetArrayField(TEXT("content"),{MakeShared<FJsonValueObject>(Text)});return Result;
    };
    for(int32 Variant=0;Variant<3;++Variant)
    {
        const FString Id=FString::Printf(TEXT("large-mcp-%d"),Variant);
        const auto Result=TextFailure(),Container=MakeShared<FJsonObject>(),Inner=MakeShared<FJsonObject>();
        if(Variant==2)
        {
            auto InnerDetails=MakeShared<FJsonObject>();InnerDetails->SetStringField(TEXT("rollback"),TEXT("failed"));InnerDetails->SetBoolField(TEXT("retryable"),true);
            Inner->SetObjectField(TEXT("details"),InnerDetails);Result->RemoveField(TEXT("isError"));Result->SetBoolField(TEXT("ok"),false);
        }
        else Inner->SetStringField(TEXT("code"),TEXT("ROLLBACK_FAILED"));
        Container->SetObjectField(TEXT("error"),Inner);
        Result->SetObjectField(Variant==1?TEXT("details"):TEXT("structuredContent"),Container);
        Connection->PendingMcp.Add(Id);Connection->PendingWriteRequestId=Id;
        Connection->CompleteMcp(Id,Result,FString(),FString(),true);
        const auto Stored=Connection->Results.FindRef(Id);
        TestTrue(TEXT("The actual MCP completion is bounded before journaling"),FTCHARToUTF8(*Encode(Stored)).Length()<2*1024*1024);
        const auto McpError=Stored->GetObjectField(TEXT("result"))->GetObjectField(TEXT("error")),McpSafety=McpError->GetObjectField(TEXT("details"));
        TestTrue(TEXT("The result remains an explicit MCP failure"),Stored->GetObjectField(TEXT("result"))->GetBoolField(TEXT("isError")));
        TestEqual(TEXT("Structured nested rollback evidence reaches the host lock"),Field(McpSafety,TEXT("rollback")),FString(TEXT("failed")));
        TestFalse(TEXT("Unsafe nested failure overrides a positive retry hint"),McpSafety->GetBoolField(TEXT("retryable")));
        TestEqual(TEXT("The host receives the stop-writes recovery action"),Field(McpSafety,TEXT("recovery")),FString(TEXT("stop_writes")));
        if(Variant<2)TestEqual(TEXT("Legacy nested unsafe codes survive truncation"),Field(McpError,TEXT("code")),FString(TEXT("ROLLBACK_FAILED")));
        TestTrue(TEXT("Only the completed native dispatch slot is released"),Connection->PendingWriteRequestId.IsEmpty());
    }

    Connection->PendingMcp.Add(TEXT("text-only"));
    Connection->CompleteMcp(TEXT("text-only"),TextFailure(),FString(),FString(),true);
    const auto TextOnly=Connection->Results.FindRef(TEXT("text-only"))->GetObjectField(TEXT("result"))->GetObjectField(TEXT("error"));
    TestEqual(TEXT("Error-code words in text are not structured rollback evidence"),Field(TextOnly,TEXT("code")),FString(TEXT("MCP_TOOL_ERROR")));
    TestFalse(TEXT("Text-only diagnostics cannot manufacture an unsafe lock"),TextOnly->GetObjectField(TEXT("details"))->HasField(TEXT("rollback")));
    auto Success=MakeShared<FJsonObject>(),UserData=MakeShared<FJsonObject>(),UserError=MakeShared<FJsonObject>();
    UserError->SetStringField(TEXT("code"),TEXT("ROLLBACK_FAILED"));UserData->SetObjectField(TEXT("error"),UserError);
    Success->SetObjectField(TEXT("structuredContent"),UserData);Success->SetStringField(TEXT("data"),Large);
    Connection->PendingMcp.Add(TEXT("large-success"));
    Connection->CompleteMcp(TEXT("large-success"),Success,FString(),FString(),true);
    const auto TooLarge=Connection->Results.FindRef(TEXT("large-success"))->GetObjectField(TEXT("error"));
    TestEqual(TEXT("Oversized success still returns the size error"),Field(TooLarge,TEXT("code")),FString(TEXT("RESPONSE_TOO_LARGE")));
    TestFalse(TEXT("Successful user data is not scanned for error-like fields"),TooLarge->HasField(TEXT("details")));
    Connection->ObserveTestResponse=nullptr;
    return true;
}
#endif

class FDSHUnrealBridgeModule final : public IModuleInterface
{
    TSharedPtr<FDSHConnection> Connection;
    void StartupModule() override { if(!IsRunningCommandlet()||FParse::Param(FCommandLine::Get(),TEXT("DSHBridgeTest"))){FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets"));Connection=MakeShared<FDSHConnection>();Connection->Start();} }
    void ShutdownModule() override {if(Connection){Connection->Stop();Connection.Reset();}FDSHAssetPresentation::ShutdownMaterialTransactions();}
};
IMPLEMENT_MODULE(FDSHUnrealBridgeModule,DSHUnrealBridge)
