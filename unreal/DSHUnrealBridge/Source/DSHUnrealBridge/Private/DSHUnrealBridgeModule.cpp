#include "Modules/ModuleManager.h"
#include "DSHBlueprintOps.h"
#include "IDSHUnrealBridgeMCPModule.h"
#include "ProjectKnowledgeService.h"
#include "AssetRegistry/AssetData.h"
#include "Async/Async.h"
#include "Containers/Ticker.h"
#include "Containers/Queue.h"
#include "ContentBrowserModule.h"
#include "IContentBrowserSingleton.h"
#include "Engine/Blueprint.h"
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

DEFINE_LOG_CATEGORY_STATIC(LogDSHBridge,Log,All);

namespace
{
FString Encode(const TSharedPtr<FJsonObject>& Object) { FString Text;FJsonSerializer::Serialize(Object.ToSharedRef(),TJsonWriterFactory<>::Create(&Text));return Text; }
FString Field(const TSharedPtr<FJsonObject>& O,const TCHAR* K){FString V;if(O)O->TryGetStringField(K,V);return V;}
TSharedPtr<FJsonObject> Decode(const FString& Text){TSharedPtr<FJsonObject> O;FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text),O);return O;}
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
        auto& CB=FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
        SelectionHandle=CB.GetOnAssetSelectionChanged().AddSP(AsShared(),&FDSHConnection::SelectionChanged);
        TransactedHandle=FCoreUObjectDelegates::OnObjectTransacted.AddSP(AsShared(),&FDSHConnection::ObjectTransacted);
        PropertyHandle=FCoreUObjectDelegates::OnObjectPropertyChanged.AddSP(AsShared(),&FDSHConnection::PropertyChanged);
        TArray<FAssetData> Selected;CB.Get().GetSelectedAssets(Selected);SelectionChanged(Selected,true);
        TickHandle=FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateSP(AsShared(),&FDSHConnection::Tick),0.1f);
        UE_LOG(LogDSHBridge,Display,TEXT("DSH bridge ready; waiting for local DSH host. Instance %s"),*EditorId);
    }
    void Stop()
    {
        ++Generation;
        for (const auto& Pending : PendingKnowledge) FProjectKnowledgeService::Cancel(Pending.Value);
        PendingKnowledge.Reset();
        FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
        if(FModuleManager::Get().IsModuleLoaded(TEXT("ContentBrowser")))FModuleManager::GetModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).GetOnAssetSelectionChanged().Remove(SelectionHandle);
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
    FDelegateHandle SelectionHandle,TransactedHandle,PropertyHandle;
    TArray<TSharedPtr<FJsonValue>> Selection;
    uint64 Generation=0;
    struct FIncoming { uint64 Generation; FString Message; };
    TQueue<FIncoming,EQueueMode::Mpsc> Inbox;
    TMap<FString,TSharedPtr<FJsonObject>> Results;
    TMap<FString,FString> RequestHashes;
    TSet<FString> PendingMcp;
    TMap<FString, FGuid> PendingKnowledge;
    TArray<FString> ResultOrder;
    TMap<TWeakObjectPtr<UBlueprint>,FString> Watched;
    TSet<TWeakObjectPtr<UBlueprint>> Dirty;
    FDSHBlueprintOps Operations;
    void Send(const TSharedPtr<FJsonObject>& O){if(Socket&&Socket->IsConnected())Socket->Send(Encode(O));}
    void Event(const FString& Name,const TSharedPtr<FJsonObject>& Data){if(!bAuthenticated)return;auto O=MakeShared<FJsonObject>();O->SetStringField(TEXT("type"),TEXT("event"));O->SetStringField(TEXT("event"),Name);O->SetNumberField(TEXT("sequence"),++Sequence);O->SetObjectField(TEXT("data"),Data);Send(O);}
    void SendSelection(){auto Data=MakeShared<FJsonObject>();Data->SetArrayField(TEXT("assets"),Selection);Event(TEXT("selection_changed"),Data);}
    void SelectionChanged(const TArray<FAssetData>& Assets,bool bPrimary)
    {
        if(!bPrimary)return;Selection.Reset();for(const auto& Asset:Assets){if(Selection.Num()>=256)break;auto A=MakeShared<FJsonObject>();A->SetStringField(TEXT("path"),Asset.GetObjectPathString());A->SetStringField(TEXT("class"),Asset.AssetClassPath.ToString());Selection.Add(MakeShared<FJsonValueObject>(A));}SendSelection();
    }
    void Mark(UObject* Object){if(!Object)return;UBlueprint* BP=Cast<UBlueprint>(Object);if(!BP)BP=Object->GetTypedOuter<UBlueprint>();if(BP&&Watched.Contains(BP))Dirty.Add(BP);}
    void ObjectTransacted(UObject* Object,const FTransactionObjectEvent&){Mark(Object);}
    void PropertyChanged(UObject* Object,FPropertyChangedEvent&){Mark(Object);}
    void Connect()
    {
        FString Text;if(!FFileHelper::LoadFileToString(Text,*Descriptor)||Text.Len()>8192)return;const auto Config=Decode(Text);if(!Config)return;
        const FString URL=Field(Config,TEXT("url"));const FString Token=Field(Config,TEXT("token"));
        if(!URL.StartsWith(TEXT("ws://127.0.0.1:"))||!URL.EndsWith(TEXT("/editor"))||Token.Len()!=64)return;
        const uint64 CurrentGeneration=++Generation;
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
        TArray<TSharedPtr<FJsonValue>> Caps;for(const TCHAR* Name:{TEXT("selection"),TEXT("read_blueprint"),TEXT("preview_patch"),TEXT("apply_patch"),TEXT("create_blueprint"),TEXT("undo"),TEXT("save"),TEXT("request_status"),TEXT("mcp_tools"),TEXT("project_knowledge")})Caps.Add(MakeShared<FJsonValueString>(Name));O->SetArrayField(TEXT("capabilities"),Caps);Send(O);
    }
    TSharedPtr<FJsonObject> Error(const FString& Id,const FString& Code,const FString& Message)
    {
        auto O=MakeShared<FJsonObject>();O->SetStringField(TEXT("type"),TEXT("response"));O->SetStringField(TEXT("id"),Id);O->SetBoolField(TEXT("ok"),false);auto E=MakeShared<FJsonObject>();E->SetStringField(TEXT("code"),Code);E->SetStringField(TEXT("message"),Message);O->SetObjectField(TEXT("error"),E);return O;
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
        if(FTCHARToUTF8(*Encode(Response)).Length()>2*1024*1024)Response=Error(Id,TEXT("RESPONSE_TOO_LARGE"),TEXT("MCP result exceeds the 2 MiB bridge limit"));
        if(bWrite){Results.Add(Id,Response);ResultOrder.Add(Id);if(ResultOrder.Num()>1024){Results.Remove(ResultOrder[0]);ResultOrder.RemoveAt(0);}}
        Send(Response);
    }
    void Request(const TSharedPtr<FJsonObject>& Message)
    {
        const FString Id=Field(Message,TEXT("id")),Method=Field(Message,TEXT("method"));double Protocol=0;const TSharedPtr<FJsonObject>* ParamsPtr=nullptr;
        if(Id.IsEmpty()||Id.Len()>160||!Message->TryGetNumberField(TEXT("protocol"),Protocol)||Protocol!=1||!Message->TryGetObjectField(TEXT("params"),ParamsPtr)){Send(Error(Id,TEXT("INVALID_REQUEST"),TEXT("Invalid request envelope")));return;}
        const auto Params=*ParamsPtr;
        if(Method==TEXT("request_status"))
        {
            const FString QueryId=Field(Params,TEXT("requestId"));auto R=MakeShared<FJsonObject>();auto Result=MakeShared<FJsonObject>();Result->SetStringField(TEXT("status"),Results.Contains(QueryId)?TEXT("completed"):PendingMcp.Contains(QueryId)||PendingKnowledge.Contains(QueryId)?TEXT("pending"):RequestHashes.Contains(QueryId)?TEXT("expired"):TEXT("unknown"));if(Results.Contains(QueryId))Result->SetObjectField(TEXT("response"),Results[QueryId]);R->SetStringField(TEXT("type"),TEXT("response"));R->SetStringField(TEXT("id"),Id);R->SetBoolField(TEXT("ok"),true);R->SetObjectField(TEXT("result"),Result);Send(R);return;
        }
        const FString KnowledgeTool=Method==TEXT("knowledge_call")?Field(Params,TEXT("tool")):FString();
        const bool bKnowledgeWrite=KnowledgeTool==TEXT("remember_evidence")||KnowledgeTool==TEXT("experience_save")||KnowledgeTool==TEXT("experience_feedback");
        const bool bWrite=Method==TEXT("apply_patch")||Method==TEXT("create_blueprint")||Method==TEXT("undo")||Method==TEXT("save")||Method==TEXT("mcp_call_tool")||bKnowledgeWrite;
        if(bWrite)
        {
            const FTCHARToUTF8 Bytes(*(Method+Encode(Params)));const FString Hash=FMD5::HashBytes(reinterpret_cast<const uint8*>(Bytes.Get()),Bytes.Length());
            if(const FString* Previous=RequestHashes.Find(Id)){if(*Previous!=Hash)Send(Error(Id,TEXT("IDEMPOTENCY_MISMATCH"),TEXT("Request ID has different parameters")));else if(Results.Contains(Id))Send(Results[Id]);else if(PendingMcp.Contains(Id)||PendingKnowledge.Contains(Id))Send(Error(Id,TEXT("IN_PROGRESS"),TEXT("This tool call is still running; query request status")));else Send(Error(Id,TEXT("RESULT_EXPIRED"),TEXT("This write already ran; cached result expired, do not repeat")));return;}
            if(RequestHashes.Num()>=10000){Send(Error(Id,TEXT("REQUEST_LIMIT"),TEXT("Write request journal is full; restart the editor after reconciling pending requests")));return;}
            RequestHashes.Add(Id,Hash);
        }
        if(Method==TEXT("mcp_list_tools"))
        {
            FString MCPError;auto Result=IDSHUnrealBridgeMCPModule::Get().ListTools(MCPError);
            auto Response=Result?MakeShared<FJsonObject>():Error(Id,TEXT("MCP_UNAVAILABLE"),MCPError);
            if(Result){Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
            if(FTCHARToUTF8(*Encode(Response)).Length()>2*1024*1024)Response=Error(Id,TEXT("RESPONSE_TOO_LARGE"),TEXT("MCP tool list exceeds the 2 MiB bridge limit"));
            Send(Response);return;
        }
        if(Method==TEXT("knowledge_call"))
        {
            const FString Tool=Field(Params,TEXT("tool"));
            static const TSet<FString> Allowed={TEXT("project_status"),TEXT("project_context"),TEXT("project_search"),TEXT("graph_query"),TEXT("graph_feature"),TEXT("graph_impact"),TEXT("read_source"),TEXT("validate_evidence"),TEXT("read_asset_snapshot"),TEXT("search_asset_snapshots"),TEXT("asset_snapshot"),TEXT("inspect_asset"),TEXT("experience_lookup"),TEXT("remember_evidence"),TEXT("experience_save"),TEXT("experience_feedback")};
            const TSharedPtr<FJsonObject>* Arguments=nullptr;
            if(!Allowed.Contains(Tool)||!Params->TryGetObjectField(TEXT("arguments"),Arguments)||!Arguments||!Arguments->IsValid())
            {
                Send(Error(Id,TEXT("INVALID_REQUEST"),TEXT("Unknown knowledge tool or invalid arguments")));return;
            }
            const TWeakPtr<FDSHConnection> Weak=AsShared();
            const FGuid KnowledgeId=FProjectKnowledgeService::Execute(Tool,*Arguments,nullptr,
                [Weak,Id,bWrite](bool bSuccess,TSharedPtr<FJsonObject> Result)
                {
                    if(auto Self=Weak.Pin())
                    {
                        Self->PendingKnowledge.Remove(Id);
                        TSharedPtr<FJsonObject> Response;
                        if(bSuccess&&Result.IsValid())
                        {
                            Response=MakeShared<FJsonObject>();Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);
                        }
                        else Response=Self->Error(Id,TEXT("KNOWLEDGE_ERROR"),Result.IsValid()?Field(Result,TEXT("error")):TEXT("Knowledge request failed"));
                        if(FTCHARToUTF8(*Encode(Response)).Length()>2*1024*1024)Response=Self->Error(Id,TEXT("RESPONSE_TOO_LARGE"),TEXT("Narrow the knowledge query or request a smaller page"));
                        if(bWrite){Self->Results.Add(Id,Response);Self->ResultOrder.Add(Id);if(Self->ResultOrder.Num()>1024){Self->Results.Remove(Self->ResultOrder[0]);Self->ResultOrder.RemoveAt(0);}}
                        Self->Send(Response);
                    }
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
                Send(Response);return;
            }
            PendingMcp.Add(Id);
            const TWeakPtr<FDSHConnection> Weak=AsShared();
            FString MCPError;
            const bool bStarted=IDSHUnrealBridgeMCPModule::Get().CallTool(Name,*ArgumentsPtr,Id,
                [Weak,Id,bWrite](TSharedPtr<FJsonObject> Result)
                {
                    auto Finish=[Weak,Id,bWrite,Result]()
                    {
                        if(auto Self=Weak.Pin())Self->CompleteMcp(Id,Result,TEXT("MCP_TOOL_ERROR"),TEXT("MCP tool returned no result"),bWrite);
                    };
                    if(IsInGameThread())Finish();else AsyncTask(ENamedThreads::GameThread,MoveTemp(Finish));
                },MCPError);
            if(!bStarted)CompleteMcp(Id,nullptr,TEXT("MCP_UNAVAILABLE"),MCPError,bWrite);
            return;
        }
        FString Code,MessageText;auto Result=Operations.Execute(Method,Params,Code,MessageText);TSharedPtr<FJsonObject> Response;
        if(Result){Response=MakeShared<FJsonObject>();Response->SetStringField(TEXT("type"),TEXT("response"));Response->SetStringField(TEXT("id"),Id);Response->SetBoolField(TEXT("ok"),true);Response->SetObjectField(TEXT("result"),Result);}
        else Response=Error(Id,Code,MessageText);
        if(FTCHARToUTF8(*Encode(Response)).Length()>2*1024*1024)Response=Error(Id,TEXT("RESPONSE_TOO_LARGE"),TEXT("Read a summary or filter by graph and nodeIds; response exceeds 2 MiB"));
        if(bWrite){Results.Add(Id,Response);ResultOrder.Add(Id);if(ResultOrder.Num()>1024){Results.Remove(ResultOrder[0]);ResultOrder.RemoveAt(0);}}
        Send(Response);
        const FString Path=Field(Params,TEXT("assetPath"));
        if(!Path.IsEmpty())
        {
            const FString Package=FPackageName::ObjectPathToPackageName(Path);if(UBlueprint* BP=FindObject<UBlueprint>(nullptr,*(Package+TEXT(".")+FPackageName::GetShortName(Package)))){if(!Watched.Contains(BP))Watched.Add(BP,FDSHBlueprintOps::Revision(BP));if(bWrite)Dirty.Add(BP);}
        }
    }
    bool Tick(float)
    {
        FIncoming Incoming;int32 Count=0;
        while(Count++<4&&Inbox.Dequeue(Incoming))
        {
            if(Incoming.Generation!=Generation)continue;
            const FString& Message=Incoming.Message;
            if(Message==TEXT("__connected")){Hello();continue;}
            if(Message==TEXT("__disconnected")){bConnecting=false;bAuthenticated=false;continue;}
            const auto O=Decode(Message);if(!O)continue;const FString Type=Field(O,TEXT("type"));
            if(Type==TEXT("hello_ack")){bAuthenticated=true;SendSelection();continue;}
            if(bAuthenticated&&Type==TEXT("request"))Request(O);
        }
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

class FDSHUnrealBridgeModule final : public IModuleInterface
{
    TSharedPtr<FDSHConnection> Connection;
    void StartupModule() override { if(!IsRunningCommandlet()||FParse::Param(FCommandLine::Get(),TEXT("DSHBridgeTest"))){FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets"));Connection=MakeShared<FDSHConnection>();Connection->Start();} }
    void ShutdownModule() override {if(Connection){Connection->Stop();Connection.Reset();}}
};
IMPLEMENT_MODULE(FDSHUnrealBridgeModule,DSHUnrealBridge)
