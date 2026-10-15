#include "DSHBlueprintOps.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/ActorComponent.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "EdGraphUtilities.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/PackageName.h"
#include "Misc/SecureHash.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/SavePackage.h"
#include "UObject/StrongObjectPtr.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UObjectIterator.h"

namespace
{
TSharedPtr<FJsonObject> Obj() { return MakeShared<FJsonObject>(); }
TSharedPtr<FJsonValue> JV(const TSharedPtr<FJsonObject>& O) { return MakeShared<FJsonValueObject>(O); }
FString Str(const TSharedPtr<FJsonObject>& O, const TCHAR* Key) { FString V; if (O) O->TryGetStringField(Key, V); return V; }
bool ValidPath(const FString& Path)
{
    const FString Package = FPackageName::ObjectPathToPackageName(Path);
    return Package.StartsWith(TEXT("/Game/")) && FPackageName::IsValidLongPackageName(Package) && !Package.Contains(TEXT("..")) && (Path == Package || Path == Package + TEXT(".") + FPackageName::GetShortName(Package));
}
UEdGraph* GraphOf(UBlueprint* BP, const FString& Name)
{
    TArray<UEdGraph*> Graphs; BP->GetAllGraphs(Graphs);
    for (UEdGraph* G : Graphs) if (G->GetName() == Name || G->GraphGuid.ToString() == Name) return G;
    return nullptr;
}
TArray<FString> Functions()
{
    return { TEXT("/Script/Engine.KismetSystemLibrary:PrintString"), TEXT("/Script/Engine.KismetSystemLibrary:Delay"), TEXT("/Script/Engine.KismetMathLibrary:Add_IntInt"), TEXT("/Script/Engine.KismetMathLibrary:Multiply_IntInt"), TEXT("/Script/Engine.KismetMathLibrary:Subtract_IntInt"), TEXT("/Script/Engine.Actor:ReceiveBeginPlay"), TEXT("/Script/Engine.Actor:ReceiveEndPlay") };
}
bool SupportedFunction(UFunction* Function)
{
    return Function && Function->GetPathName().StartsWith(TEXT("/Script/")) && Function->HasAnyFunctionFlags(FUNC_BlueprintCallable|FUNC_BlueprintEvent) && !Function->HasMetaData(TEXT("BlueprintInternalUseOnly")) && !Function->HasMetaData(TEXT("DeprecatedFunction"));
}
TSharedPtr<FJsonObject> PinData(UEdGraphPin* P)
{
    auto O=Obj(); O->SetStringField(TEXT("name"),P->PinName.ToString()); O->SetStringField(TEXT("id"),P->PinId.ToString());
    O->SetStringField(TEXT("direction"),P->Direction==EGPD_Input?TEXT("input"):TEXT("output"));
    O->SetStringField(TEXT("type"),P->PinType.PinCategory.ToString()); O->SetStringField(TEXT("defaultValue"),P->DefaultValue);
    O->SetStringField(TEXT("defaultObject"),GetPathNameSafe(P->DefaultObject)); O->SetStringField(TEXT("defaultText"),P->DefaultTextValue.ToString());
    TArray<TSharedPtr<FJsonValue>> Links;
    for(UEdGraphPin* L:P->LinkedTo) { auto E=Obj(); E->SetStringField(TEXT("node"),L->GetOwningNode()->NodeGuid.ToString()); E->SetStringField(TEXT("pin"),L->PinName.ToString()); Links.Add(JV(E)); }
    O->SetArrayField(TEXT("links"),Links); return O;
}
UBlueprint* DuplicateForPreview(UBlueprint* BP)
{
    const FName Name=MakeUniqueObjectName(GetTransientPackage(),UBlueprint::StaticClass(),TEXT("DSHPreview"));
    // Patch node IDs refer to the original graph; ordinary duplication regenerates them.
    FBlueprintDuplicationScopeFlags Scope(FBlueprintDuplicationScopeFlags::bStaticFlags|FBlueprintDuplicationScopeFlags::TheSameNodeGuid);
    UBlueprint* Copy=DuplicateObject<UBlueprint>(BP,GetTransientPackage(),Name);
    if(Copy) { Copy->ClearFlags(RF_Public|RF_Standalone); Copy->SetFlags(RF_Transient); }
    return Copy;
}
}

UBlueprint* FDSHBlueprintOps::Resolve(const FString& Path,FString& Error)
{
    if(!ValidPath(Path)) { Error=TEXT("Only valid /Game/ blueprint package or object paths are allowed"); return nullptr; }
    const FString Package=FPackageName::ObjectPathToPackageName(Path);
    UBlueprint* BP=LoadObject<UBlueprint>(nullptr,*(Package+TEXT(".")+FPackageName::GetShortName(Package)));
    if(!BP)Error=TEXT("Blueprint not found");
    else if(BP->BlueprintType!=BPTYPE_Normal || BP->GetClass()!=UBlueprint::StaticClass()) { Error=TEXT("This release supports normal Actor, ActorComponent and Object blueprints only"); return nullptr; }
    return BP;
}

FString FDSHBlueprintOps::Revision(UBlueprint* BP)
{
    FString Text=BP->GetPathName()+GetPathNameSafe(BP->ParentClass);
    TArray<UEdGraph*> Graphs; BP->GetAllGraphs(Graphs);
    for(UEdGraph* G:Graphs)
    {
        Text+=G->GetName()+G->GraphGuid.ToString(); TSet<UObject*> Nodes;
        for(UEdGraphNode* N:G->Nodes)if(N)Nodes.Add(N);
        FString Export; FEdGraphUtilities::ExportNodesToText(Nodes,Export); Text+=Export;
    }
    for(const FBPVariableDescription& V:BP->NewVariables)Text+=V.VarName.ToString()+V.VarGuid.ToString()+V.DefaultValue+V.VarType.PinCategory.ToString()+GetPathNameSafe(V.VarType.PinSubCategoryObject.Get());
    const FTCHARToUTF8 Bytes(*Text);return FMD5::HashBytes(reinterpret_cast<const uint8*>(Bytes.Get()),Bytes.Length());
}

TSharedPtr<FJsonObject> FDSHBlueprintOps::Read(UBlueprint* BP,const TSharedPtr<FJsonObject>& Params)
{
    auto O=Obj(); O->SetStringField(TEXT("assetPath"),BP->GetPathName()); O->SetStringField(TEXT("revision"),Revision(BP));
    O->SetStringField(TEXT("parent"),GetPathNameSafe(BP->ParentClass)); O->SetBoolField(TEXT("dirty"),BP->GetOutermost()->IsDirty());
    O->SetBoolField(TEXT("compileError"),BP->Status==BS_Error);
    TArray<UEdGraph*> Graphs; BP->GetAllGraphs(Graphs); TArray<TSharedPtr<FJsonValue>> Result;
    const FString RequestedGraph=Str(Params,TEXT("graph")); const bool Full=Str(Params,TEXT("detail"))==TEXT("full");
    TSet<FString> Filter; const TArray<TSharedPtr<FJsonValue>>* IDs=nullptr;
    if(Params->TryGetArrayField(TEXT("nodeIds"),IDs)) for(const auto& ID:*IDs) Filter.Add(ID->AsString());
    for(UEdGraph* G:Graphs)
    {
        if(!RequestedGraph.IsEmpty()&&RequestedGraph!=G->GetName()&&RequestedGraph!=G->GraphGuid.ToString())continue;
        auto GO=Obj(); GO->SetStringField(TEXT("name"),G->GetName()); GO->SetStringField(TEXT("id"),G->GraphGuid.ToString()); GO->SetNumberField(TEXT("nodeCount"),G->Nodes.Num());
        if(Full)
        {
            TArray<TSharedPtr<FJsonValue>> Nodes;
            for(UEdGraphNode* N:G->Nodes)
            {
                if(!N||(!Filter.IsEmpty()&&!Filter.Contains(N->NodeGuid.ToString())))continue;
                auto NO=Obj(); NO->SetStringField(TEXT("id"),N->NodeGuid.ToString()); NO->SetStringField(TEXT("class"),N->GetClass()->GetPathName()); NO->SetStringField(TEXT("title"),N->GetNodeTitle(ENodeTitleType::ListView).ToString());
                if(const auto Call=Cast<UK2Node_CallFunction>(N))NO->SetStringField(TEXT("functionPath"),GetPathNameSafe(Call->FunctionReference.ResolveMember<UFunction>()));
                if(const auto Event=Cast<UK2Node_Event>(N))NO->SetStringField(TEXT("functionPath"),GetPathNameSafe(Event->EventReference.ResolveMember<UFunction>()));
                NO->SetStringField(TEXT("comment"),N->NodeComment); NO->SetNumberField(TEXT("x"),N->NodePosX); NO->SetNumberField(TEXT("y"),N->NodePosY);
                TArray<TSharedPtr<FJsonValue>> Pins; for(UEdGraphPin* P:N->Pins)if(P)Pins.Add(JV(PinData(P))); NO->SetArrayField(TEXT("pins"),Pins); Nodes.Add(JV(NO));
            }
            GO->SetArrayField(TEXT("nodes"),Nodes);
        }
        Result.Add(JV(GO));
    }
    O->SetArrayField(TEXT("graphs"),Result); return O;
}

bool FDSHBlueprintOps::Compile(UBlueprint* BP,FString& Error)
{
    FCompilerResultsLog Log; Log.bSilentMode=true;
    FKismetEditorUtilities::CompileBlueprint(BP,EBlueprintCompileOptions::SkipGarbageCollection|EBlueprintCompileOptions::SkipSave,&Log);
    if(Log.NumErrors>0||BP->Status==BS_Error)
    {
        Error=TEXT("Blueprint compilation failed"); for(const auto& Message:Log.Messages)Error+=TEXT("\n")+Message->ToText().ToString(); return false;
    }
    return true;
}

bool FDSHBlueprintOps::ApplyOperations(UBlueprint* BP,const TSharedPtr<FJsonObject>& Params,FString& Error)
{
    UEdGraph* Graph=GraphOf(BP,Str(Params,TEXT("graph")));
    if(!Graph||!Graph->GetSchema()->IsA<UEdGraphSchema_K2>()) {Error=TEXT("A valid K2 graph name or graph GUID is required");return false;}
    const TArray<TSharedPtr<FJsonValue>>* Ops=nullptr;
    if(!Params->TryGetArrayField(TEXT("operations"),Ops)||Ops->Num()<1||Ops->Num()>100) {Error=TEXT("operations must contain 1..100 operations");return false;}
    TMap<FString,UEdGraphNode*> Nodes; for(UEdGraphNode* N:Graph->Nodes)if(N)Nodes.Add(N->NodeGuid.ToString(),N);
    BP->Modify(); Graph->Modify(); for(UEdGraphNode* N:Graph->Nodes)if(N)N->Modify();
    for(const auto& Entry:*Ops)
    {
        const TSharedPtr<FJsonObject>* OpPtr=nullptr;if(!Entry->TryGetObject(OpPtr)){Error=TEXT("Operation must be an object");return false;} const auto Op=*OpPtr;
        const FString Kind=Str(Op,TEXT("op")); const FString NodeId=Str(Op,TEXT("nodeId")); UEdGraphNode* N=Nodes.FindRef(NodeId);
        if(Kind==TEXT("add_node"))
        {
            if(NodeId.IsEmpty()||NodeId.Len()>160||Nodes.Contains(NodeId)){Error=TEXT("New nodeId must be unique and nonempty");return false;}
            const FString FunctionPath=Str(Op,TEXT("functionPath"));
            UFunction* Function=FindObject<UFunction>(nullptr,*FunctionPath);
            if(!SupportedFunction(Function)) {Error=TEXT("Function must be a loaded native BlueprintCallable function or Blueprint event; search the catalog first");return false;}
            const FString NodeKind=Str(Op,TEXT("kind"));
            if(NodeKind==TEXT("call_function")&&Function->HasAnyFunctionFlags(FUNC_BlueprintCallable)&&!Function->HasAnyFunctionFlags(FUNC_BlueprintEvent))
            {
                UK2Node_CallFunction* Call=NewObject<UK2Node_CallFunction>(Graph,NAME_None,RF_Transactional);Call->SetFromFunction(Function);N=Call;
            }
            else if(NodeKind==TEXT("event")&&Function->HasAnyFunctionFlags(FUNC_BlueprintEvent)&&BP->ParentClass->IsChildOf(Function->GetOuterUClass()))
            {
                if(!BP->UbergraphPages.Contains(Graph)){Error=TEXT("Events may only be added to an event graph");return false;}
                TArray<UEdGraph*> All;BP->GetAllGraphs(All);for(UEdGraph* G:All)for(UEdGraphNode* Existing:G->Nodes)if(auto* E=Cast<UK2Node_Event>(Existing))if(E->EventReference.GetMemberName()==Function->GetFName()){Error=TEXT("Event already exists; connect to the existing event node");return false;}
                UK2Node_Event* Event=NewObject<UK2Node_Event>(Graph,NAME_None,RF_Transactional);Event->EventReference.SetExternalMember(Function->GetFName(),Function->GetOuterUClass());Event->bOverrideFunction=true;N=Event;
            }
            else{Error=TEXT("Node kind and function are incompatible");return false;}
            Graph->AddNode(N,false,false);N->CreateNewGuid();N->PostPlacedNewNode();N->AllocateDefaultPins();Nodes.Add(NodeId,N);
        }
        else if(Kind==TEXT("connect")||Kind==TEXT("disconnect"))
        {
            const TSharedPtr<FJsonObject>* A=nullptr;const TSharedPtr<FJsonObject>* B=nullptr;
            if(!Op->TryGetObjectField(TEXT("from"),A)||!Op->TryGetObjectField(TEXT("to"),B)){Error=TEXT("from and to are required");return false;}
            UEdGraphNode* AN=Nodes.FindRef(Str(*A,TEXT("node")));UEdGraphNode* BN=Nodes.FindRef(Str(*B,TEXT("node")));
            UEdGraphPin* AP=AN?AN->FindPin(FName(*Str(*A,TEXT("pin"))),EGPD_Output):nullptr; UEdGraphPin* BPIn=BN?BN->FindPin(FName(*Str(*B,TEXT("pin"))),EGPD_Input):nullptr;
            if(!AP||!BPIn){Error=TEXT("Exact output/input pin names are required; read the graph or catalog first");return false;}
            if(Kind==TEXT("connect"))
            {
                if(AP->LinkedTo.Contains(BPIn))continue;
                const auto Response=Graph->GetSchema()->CanCreateConnection(AP,BPIn);
                if(Response.Response!=CONNECT_RESPONSE_MAKE){Error=FString(TEXT("Connection rejected (implicit break/conversion is disabled): "))+Response.Message.ToString();return false;}
                if(!Graph->GetSchema()->TryCreateConnection(AP,BPIn)){Error=TEXT("Could not connect pins");return false;}
            }
            else Graph->GetSchema()->BreakSinglePinLink(AP,BPIn);
            continue;
        }
        else if(!N){Error=TEXT("Node ID not found");return false;}
        else if(Kind==TEXT("remove_node"))
        {
            if(!N->CanUserDeleteNode()){Error=TEXT("Node cannot be deleted");return false;}FBlueprintEditorUtils::RemoveNode(BP,N,true);Nodes.Remove(NodeId);continue;
        }
        else if(Kind==TEXT("set_pin_default"))
        {
            UEdGraphPin* P=N->FindPin(FName(*Str(Op,TEXT("pin"))),EGPD_Input);
            if(!P||P->PinType.PinCategory==UEdGraphSchema_K2::PC_Exec||P->LinkedTo.Num()>0||P->bDefaultValueIsReadOnly){Error=TEXT("An unconnected editable input data pin is required");return false;}
            if(P->PinType.PinCategory==UEdGraphSchema_K2::PC_Object||P->PinType.PinCategory==UEdGraphSchema_K2::PC_Class||P->PinType.PinCategory==UEdGraphSchema_K2::PC_Text){Error=TEXT("Object, class and localized text defaults are not supported in this release");return false;}
            const FString Value=Str(Op,TEXT("value"));if(Value.Len()>8192){Error=TEXT("Pin value is too large");return false;}
            const FString Validation=Graph->GetSchema()->IsPinDefaultValid(P,Value,nullptr,FText::GetEmpty());if(!Validation.IsEmpty()){Error=Validation;return false;}
            Graph->GetSchema()->TrySetDefaultValue(*P,Value);continue;
        }
        else if(Kind!=TEXT("move_node")){Error=TEXT("Unsupported operation");return false;}
        const TSharedPtr<FJsonObject>* Position=nullptr;
        if(Op->TryGetObjectField(TEXT("position"),Position))
        {
            double X=0,Y=0;if(!(*Position)->TryGetNumberField(TEXT("x"),X)||!(*Position)->TryGetNumberField(TEXT("y"),Y)||!FMath::IsFinite(X)||!FMath::IsFinite(Y)||FMath::Abs(X)>100000||FMath::Abs(Y)>100000){Error=TEXT("Invalid node coordinates");return false;}
            N->NodePosX=static_cast<int32>(X);N->NodePosY=static_cast<int32>(Y);
        }
    }
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(BP);Graph->NotifyGraphChanged();return true;
}

TSharedPtr<FJsonObject> FDSHBlueprintOps::Execute(const FString& Method,const TSharedPtr<FJsonObject>& Params,FString& ErrorCode,FString& ErrorMessage)
{
    check(IsInGameThread());ErrorCode=TEXT("INVALID_REQUEST");
    if(Method==TEXT("catalog"))
    {
        auto O=Obj();TArray<TSharedPtr<FJsonValue>> Entries;
        TStrongObjectPtr<UBlueprint> CatalogBP(FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(),GetTransientPackage(),MakeUniqueObjectName(GetTransientPackage(),UBlueprint::StaticClass(),TEXT("DSHCatalog")),BPTYPE_Normal,UBlueprint::StaticClass(),UBlueprintGeneratedClass::StaticClass(),TEXT("DSHBridge")));
        if(!CatalogBP.IsValid()){ErrorMessage=TEXT("Could not initialize function catalog");return nullptr;}
        UEdGraph* CatalogGraph=GraphOf(CatalogBP.Get(),TEXT("EventGraph"));
        if(!CatalogGraph){ErrorMessage=TEXT("Could not initialize catalog event graph");return nullptr;}
        TArray<FString> Candidates=Functions();const FString Query=Str(Params,TEXT("query"));double RequestedLimit=20;Params->TryGetNumberField(TEXT("limit"),RequestedLimit);const int32 Limit=FMath::Clamp(static_cast<int32>(RequestedLimit),1,50);
        if(!Query.IsEmpty()){Candidates.Reset();for(TObjectIterator<UFunction> It;It;++It)if(SupportedFunction(*It)&&It->GetPathName().Contains(Query))Candidates.Add(It->GetPathName());Candidates.Sort();}
        for(const FString& Path:Candidates)
        {
            if(Entries.Num()>=Limit)break;
            UFunction* F=FindObject<UFunction>(nullptr,*Path);if(!F)continue;
            auto E=Obj();E->SetStringField(TEXT("functionPath"),Path);E->SetStringField(TEXT("kind"),F->HasAnyFunctionFlags(FUNC_BlueprintEvent)?TEXT("event"):TEXT("call_function"));
            TArray<TSharedPtr<FJsonValue>> Pins;
            if(!F->HasAnyFunctionFlags(FUNC_BlueprintEvent))
            {
                auto N=NewObject<UK2Node_CallFunction>(CatalogGraph);N->SetFromFunction(F);CatalogGraph->AddNode(N);N->CreateNewGuid();N->AllocateDefaultPins();for(UEdGraphPin* P:N->Pins)if(P)Pins.Add(JV(PinData(P)));
            }
            else if(CatalogBP->ParentClass->IsChildOf(F->GetOuterUClass()))
            {
                auto N=NewObject<UK2Node_Event>(CatalogGraph);N->EventReference.SetExternalMember(F->GetFName(),F->GetOuterUClass());N->bOverrideFunction=true;CatalogGraph->AddNode(N);N->CreateNewGuid();N->AllocateDefaultPins();for(UEdGraphPin* P:N->Pins)if(P)Pins.Add(JV(PinData(P)));
            }
            E->SetArrayField(TEXT("pins"),Pins);Entries.Add(JV(E));
        }
        O->SetArrayField(TEXT("functions"),Entries);O->SetBoolField(TEXT("truncated"),Candidates.Num()>Limit);O->SetStringField(TEXT("scope"),TEXT("Normal blueprints; native call/event nodes; scalar pin defaults; explicit connect/disconnect; no automatic save"));return O;
    }
    const FString Path=Str(Params,TEXT("assetPath"));
    if(Method==TEXT("preview_create")||Method==TEXT("create_blueprint"))
    {
        if(!ValidPath(Path)){ErrorMessage=TEXT("Invalid /Game/ asset path");return nullptr;}
        const FString PackageName=FPackageName::ObjectPathToPackageName(Path); const FString ObjectPath=PackageName+TEXT(".")+FPackageName::GetShortName(PackageName);
        if(FPackageName::DoesPackageExist(PackageName)||FindObject<UObject>(nullptr,*ObjectPath)){ErrorCode=TEXT("ALREADY_EXISTS");ErrorMessage=TEXT("Asset already exists");return nullptr;}
        const FString Parent=Str(Params,TEXT("parent"));UClass* ParentClass=Parent==TEXT("Actor")?AActor::StaticClass():Parent==TEXT("ActorComponent")?UActorComponent::StaticClass():Parent==TEXT("Object")?UObject::StaticClass():nullptr;
        if(!ParentClass){ErrorMessage=TEXT("Unsupported blueprint parent class");return nullptr;}
        if(Method==TEXT("preview_create")){auto O=Obj();O->SetStringField(TEXT("assetPath"),ObjectPath);O->SetStringField(TEXT("parent"),Parent);O->SetBoolField(TEXT("valid"),true);return O;}
        if(GEditor->PlayWorld||GEditor->IsTransactionActive()){ErrorCode=TEXT("BUSY");ErrorMessage=TEXT("Stop PIE or finish the current editor transaction first");return nullptr;}
        UPackage* Package=CreatePackage(*PackageName);
        UBlueprint* BP=FKismetEditorUtilities::CreateBlueprint(ParentClass,Package,FName(*FPackageName::GetShortName(PackageName)),BPTYPE_Normal,UBlueprint::StaticClass(),UBlueprintGeneratedClass::StaticClass(),TEXT("DSHBridge"));
        if(!BP){ErrorMessage=TEXT("Blueprint creation failed");return nullptr;}
        if(!Compile(BP,ErrorMessage)){BP->ClearFlags(RF_Public|RF_Standalone);BP->Rename(nullptr,GetTransientPackage(),REN_DontCreateRedirectors|REN_NonTransactional);Package->SetDirtyFlag(false);ErrorCode=TEXT("COMPILE_FAILED");return nullptr;}
        FAssetRegistryModule::AssetCreated(BP);BP->MarkPackageDirty();auto O=Read(BP,MakeShared<FJsonObject>());O->SetBoolField(TEXT("saved"),false);return O;
    }
    UBlueprint* BP=Resolve(Path,ErrorMessage);if(!BP)return nullptr;
    if(Method==TEXT("read_blueprint"))
    {
        const FString Graph=Str(Params,TEXT("graph"));if(!Graph.IsEmpty()&&!GraphOf(BP,Graph)){ErrorCode=TEXT("GRAPH_NOT_FOUND");ErrorMessage=TEXT("Graph not found");return nullptr;}return Read(BP,Params);
    }
    const FString Base=Str(Params,TEXT("baseRevision"));
    if(Base.IsEmpty()||Base!=Revision(BP)){ErrorCode=TEXT("CONFLICT");ErrorMessage=TEXT("Blueprint changed since it was read; reread and preview again");return nullptr;}
    if(GEditor->PlayWorld||GEditor->IsTransactionActive()){ErrorCode=TEXT("BUSY");ErrorMessage=TEXT("Stop PIE or finish the current editor transaction first");return nullptr;}
    if(Method==TEXT("preview_patch")||Method==TEXT("apply_patch"))
    {
        TStrongObjectPtr<UBlueprint> Copy(DuplicateForPreview(BP));
        if(!Copy.IsValid()||!ApplyOperations(Copy.Get(),Params,ErrorMessage)||!Compile(Copy.Get(),ErrorMessage)){ErrorCode=TEXT("VALIDATION_FAILED");return nullptr;}
        if(Method==TEXT("preview_patch")){auto O=Obj();O->SetBoolField(TEXT("valid"),true);O->SetStringField(TEXT("assetPath"),BP->GetPathName());O->SetStringField(TEXT("baseRevision"),Base);O->SetStringField(TEXT("message"),TEXT("Validated and compiled on a transient copy"));return O;}
        const FString Label=TEXT("DSH Blueprint Edit ")+FGuid::NewGuid().ToString();bool Success=false;
        {FScopedTransaction Tx(TEXT("DSHUnrealBridge"),FText::FromString(Label),BP);Success=ApplyOperations(BP,Params,ErrorMessage)&&Compile(BP,ErrorMessage);}
        const auto Context=GEditor->Trans->GetUndoContext();
        if(!Success)
        {
            const bool Restored=Context.Title.ToString()==Label&&GEditor->UndoTransaction();FString Ignored;if(Restored)Compile(BP,Ignored);
            ErrorCode=Restored?TEXT("APPLY_FAILED_ROLLED_BACK"):TEXT("ROLLBACK_FAILED");if(!Restored)ErrorMessage+=TEXT("; automatic rollback was not possible; inspect the editor");return nullptr;
        }
        UndoTransactions.Add(BP->GetPathName(),Context.TransactionId);UndoRevisions.Add(BP->GetPathName(),Revision(BP));BP->MarkPackageDirty();
        auto O=Read(BP,Params);O->SetBoolField(TEXT("saved"),false);O->SetBoolField(TEXT("compiled"),true);return O;
    }
    if(Method==TEXT("undo"))
    {
        const FGuid* Transaction=UndoTransactions.Find(BP->GetPathName());const FString* RevisionAfter=UndoRevisions.Find(BP->GetPathName());
        if(!Transaction||!RevisionAfter||*RevisionAfter!=Base||GEditor->Trans->GetUndoContext().TransactionId!=*Transaction){ErrorCode=TEXT("UNDO_NOT_LATEST");ErrorMessage=TEXT("The bridge edit is no longer the latest editor transaction; use the editor undo history");return nullptr;}
        if(!GEditor->UndoTransaction()){ErrorMessage=TEXT("Editor refused undo");return nullptr;}UndoTransactions.Remove(BP->GetPathName());UndoRevisions.Remove(BP->GetPathName());
        if(!Compile(BP,ErrorMessage)){ErrorCode=TEXT("UNDO_COMPILE_FAILED");return nullptr;}return Read(BP,Params);
    }
    if(Method==TEXT("save"))
    {
        if(!Compile(BP,ErrorMessage)){ErrorCode=TEXT("COMPILE_FAILED");return nullptr;}
        const FString Filename=FPackageName::LongPackageNameToFilename(BP->GetOutermost()->GetName(),FPackageName::GetAssetPackageExtension());
        FSavePackageArgs Args;Args.TopLevelFlags=RF_Public|RF_Standalone;Args.SaveFlags=SAVE_NoError;
        if(!UPackage::SavePackage(BP->GetOutermost(),BP,*Filename,Args)){ErrorCode=TEXT("SAVE_FAILED");ErrorMessage=TEXT("Package save failed; check read-only files and source control");return nullptr;}
        auto O=Read(BP,Params);O->SetBoolField(TEXT("saved"),true);return O;
    }
    ErrorCode=TEXT("UNSUPPORTED_METHOD");ErrorMessage=TEXT("Unsupported editor operation");return nullptr;
}
