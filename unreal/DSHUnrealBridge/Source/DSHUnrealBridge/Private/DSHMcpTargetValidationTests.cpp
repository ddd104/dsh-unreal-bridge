#include "DSHMcpTargetValidation.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "DSHMcpEditAdapter.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/AutomationTest.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

namespace
{
TSharedPtr<FJsonObject> Ref(UObject* Object)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("refPath"), Object->GetPathName());
    return Result;
}
TSharedPtr<FJsonObject> Call(const FString& Tool, const TSharedPtr<FJsonObject>& Arguments)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("toolset_name"), TEXT("editor_toolset.toolsets.blueprint.BlueprintTools"));
    Result->SetStringField(TEXT("tool_name"), Tool);
    Result->SetObjectField(TEXT("arguments"), Arguments);
    return Result;
}
UBlueprint* Blueprint()
{
    UBlueprint* Result = NewObject<UBlueprint>(GetTransientPackage(), NAME_None, RF_Transient);
    Result->ParentClass = AActor::StaticClass();
    return Result;
}
UEdGraph* Graph(UBlueprint* Owner, const FName Name = TEXT("EventGraph"))
{
    UEdGraph* Result = NewObject<UEdGraph>(Owner, Name, RF_Transient);
    Result->Schema = UEdGraphSchema_K2::StaticClass();
    Owner->UbergraphPages.Add(Result);
    return Result;
}
UEdGraphNode* Node(UEdGraph* Owner)
{
    UEdGraphNode* Result = NewObject<UEdGraphNode>(Owner, NAME_None, RF_Transient);
    Result->CreateNewGuid();
    Owner->AddNode(Result, false, false);
    Result->CreatePin(EGPD_Input, UEdGraphSchema_K2::PC_Exec, TEXT("execute"));
    Result->CreatePin(EGPD_Output, UEdGraphSchema_K2::PC_Exec, TEXT("then"));
    return Result;
}
TSharedPtr<FJsonObject> Pin(UEdGraphNode* Owner, const FString& Direction, int32 Index = 0)
{
    auto Result = MakeShared<FJsonObject>();
    Result->SetObjectField(TEXT("node"), Ref(Owner));
    Result->SetStringField(TEXT("direction"), Direction);
    Result->SetNumberField(TEXT("index_id"), Index);
    return Result;
}
TSharedPtr<FJsonObject> ObjectCall(const FString& Tool, UObject* Instance)
{
    auto Args = MakeShared<FJsonObject>();
    Args->SetObjectField(TEXT("instance"), Ref(Instance));
    if (Tool == TEXT("set_properties")) Args->SetStringField(TEXT("values"), TEXT("{}"));
    auto Result = Call(Tool, Args);
    Result->SetStringField(TEXT("toolset_name"), TEXT("editor_toolset.toolsets.object.ObjectTools"));
    return Result;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpTargetTypes, "DSH.Bridge.McpTargetValidation.TypesAndIdentity",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMcpTargetTypes::RunTest(const FString&)
{
    TStrongObjectPtr<UWorld> World(NewObject<UWorld>(GetTransientPackage(), NAME_None, RF_Transient));
    World->PersistentLevel = NewObject<ULevel>(World.Get(), TEXT("PersistentLevel"), RF_Transient);
    World->PersistentLevel->OwningWorld = World.Get();
    ULevelScriptBlueprint* LevelBlueprint = NewObject<ULevelScriptBlueprint>(World->PersistentLevel, TEXT("LevelScript"), RF_Transient);
    World->PersistentLevel->LevelScriptBlueprint = LevelBlueprint;
    UEdGraph* EventGraph = Graph(LevelBlueprint);
    Node(EventGraph);
    auto Args = MakeShared<FJsonObject>();
    Args->SetObjectField(TEXT("blueprint"), Ref(World.Get()));
    Args->SetStringField(TEXT("graph_name"), TEXT("NewFunction"));
    TSharedPtr<FJsonObject> Details;
    FString Code, Message;
    const bool WasDirty = World->GetOutermost()->IsDirty();
    TestFalse(TEXT("A real World is rejected as a Blueprint before add_function_graph"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("add_function_graph"), Args), Details, Code, Message));
    TestEqual(TEXT("Wrong class is diagnosed"), Code, FString(TEXT("MCP_TARGET_TYPE_MISMATCH")));
    if (Details)
    {
        TestEqual(TEXT("Failure proves execution did not start"), Details->GetStringField(TEXT("execution")), FString(TEXT("not_started")));
        TestEqual(TEXT("Expected class is authoritative Blueprint"), Details->GetStringField(TEXT("expectedClass")), UBlueprint::StaticClass()->GetPathName());
        TestEqual(TEXT("Actual class identifies World"), Details->GetStringField(TEXT("actualClass")), UWorld::StaticClass()->GetPathName());
    }
    Args->SetObjectField(TEXT("blueprint"), Ref(LevelBlueprint));
    TestTrue(TEXT("Exact existing level Blueprint subclass is accepted"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("add_function_graph"), Args), Details, Code, Message));
    TestEqual(TEXT("No function graph was created by validation"), LevelBlueprint->FunctionGraphs.Num(), 0);
    TestEqual(TEXT("Package dirty status is unchanged"), World->GetOutermost()->IsDirty(), WasDirty);

    auto GraphArgs = MakeShared<FJsonObject>();
    GraphArgs->SetObjectField(TEXT("graph"), Ref(EventGraph));
    TestTrue(TEXT("Nested graph identity validates without loading or converting the World"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("read_graph_dsl"), GraphArgs), Details, Code, Message));
    auto Missing = MakeShared<FJsonObject>();
    Missing->SetStringField(TEXT("refPath"), LevelBlueprint->GetPathName() + TEXT(".NoSuchGraph"));
    GraphArgs->SetObjectField(TEXT("graph"), Missing);
    TestFalse(TEXT("Nonexistent subobjects are not inferred from their World prefix"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("read_graph_dsl"), GraphArgs), Details, Code, Message));
    TestEqual(TEXT("Missing live subobject diagnosed"), Code, FString(TEXT("MCP_TARGET_REFERENCE_UNRESOLVED")));
    TestFalse(TEXT("Nested dispatcher cannot bypass target checks"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("call_tool"), Args), Details, Code, Message));
    TestEqual(TEXT("Recursive dispatcher diagnosed"), Code, FString(TEXT("MCP_TARGET_UNSUPPORTED")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpTargetOwners, "DSH.Bridge.McpTargetValidation.GraphOwnersAndPins",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMcpTargetOwners::RunTest(const FString&)
{
    TStrongObjectPtr<UBlueprint> First(Blueprint()), Second(Blueprint());
    UEdGraph* One = Graph(First.Get()), *Two = Graph(Second.Get());
    UEdGraphNode* Output = Node(One), *Input = Node(One), *Foreign = Node(Two);
    auto Args = MakeShared<FJsonObject>();
    Args->SetObjectField(TEXT("output_pin"), Pin(Output, TEXT("EGPD_Output")));
    Args->SetObjectField(TEXT("input_pin"), Pin(Input, TEXT("EGPD_Input")));
    TSharedPtr<FJsonObject> Details;
    FString Code, Message;
    TestTrue(TEXT("Actual pins in one graph validate"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("connect_pins"), Args), Details, Code, Message));
    TestTrue(TEXT("Validation does not connect pins"), Output->Pins[1]->LinkedTo.IsEmpty());
    Args->SetObjectField(TEXT("input_pin"), Pin(Foreign, TEXT("EGPD_Input")));
    TestFalse(TEXT("Cross-Blueprint pin connection rejected before execution"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("connect_pins"), Args), Details, Code, Message));
    TestEqual(TEXT("Mismatched owner diagnosed"), Code, FString(TEXT("MCP_TARGET_OWNER_MISMATCH")));
    Args->SetObjectField(TEXT("input_pin"), Pin(Input, TEXT("EGPD_Input"), 99));
    TestFalse(TEXT("Stale directional pin index rejected"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("connect_pins"), Args), Details, Code, Message));
    TestEqual(TEXT("Invalid pin diagnosed"), Code, FString(TEXT("MCP_TARGET_PIN_INVALID")));

    auto Nodes = MakeShared<FJsonObject>();
    Nodes->SetArrayField(TEXT("nodes"), { MakeShared<FJsonValueObject>(Ref(Input)), MakeShared<FJsonValueObject>(Ref(Foreign)) });
    TestTrue(TEXT("Independent node metadata reads may batch different Blueprint owners"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("get_node_infos"), Nodes), Details, Code, Message));
    Nodes->SetArrayField(TEXT("nodes"), { MakeShared<FJsonValueObject>(Ref(Input)), MakeShared<FJsonValueObject>(Ref(First.Get())) });
    TestFalse(TEXT("Nested arrays validate each actual reference type"), FDSHMcpTargetValidation::Validate(TEXT("call_tool"), Call(TEXT("get_node_infos"), Nodes), Details, Code, Message));
    TestEqual(TEXT("Wrong array element type diagnosed"), Code, FString(TEXT("MCP_TARGET_TYPE_MISMATCH")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpAdapterTargetIdentity, "DSH.Bridge.McpTargetValidation.AdapterIdentity",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMcpAdapterTargetIdentity::RunTest(const FString&)
{
    TStrongObjectPtr<UWorld> World(NewObject<UWorld>(GetTransientPackage(), NAME_None, RF_Transient));
    World->PersistentLevel = NewObject<ULevel>(World.Get(), TEXT("PersistentLevel"), RF_Transient);
    ULevelScriptBlueprint* Blueprint = NewObject<ULevelScriptBlueprint>(World->PersistentLevel, TEXT("ExactLevelScript"), RF_Transient);
    World->PersistentLevel->LevelScriptBlueprint = Blueprint;
    UEdGraph* EventGraph = Graph(Blueprint);
    UEdGraphNode* TargetNode = Node(EventGraph);
    auto Args = MakeShared<FJsonObject>();
    Args->SetObjectField(TEXT("graph"), Ref(EventGraph));
    auto Result = MakeShared<FJsonObject>();
    Result->SetField(TEXT("returnValue"), MakeShared<FJsonValueNull>());
    const auto Hints = FDSHMcpEditAdapter::FromCall(TEXT("write_graph_dsl"), Args, Result);
    if (TestEqual(TEXT("One real level Blueprint hint"), Hints.Num(), 1))
        TestEqual(TEXT("The hint never collapses to a World path"), Hints[0].AssetPath, Blueprint->GetPathName());
    const auto Before = FDSHMcpEditAdapter::CaptureCallGraphs(TEXT("write_graph_dsl"), Args);
    if (TestEqual(TEXT("The actual owner graph is captured"), Before.Num(), 1))
    {
        TestTrue(TEXT("Snapshot retains exact owner identity"), Before[0].Owner.Get() == Blueprint);
        TestTrue(TEXT("Snapshot retains exact graph identity"), Before[0].Graph.Get() == EventGraph);
    }
    auto NodeArgs = MakeShared<FJsonObject>();
    NodeArgs->SetObjectField(TEXT("node"), Ref(TargetNode));
    const auto NodeHints = FDSHMcpEditAdapter::FromCall(TEXT("set_node_property"), NodeArgs, Result);
    if (TestEqual(TEXT("A real node identifies its owner"), NodeHints.Num(), 1))
    {
        TestEqual(TEXT("Node hint preserves exact level Blueprint"), NodeHints[0].AssetPath, Blueprint->GetPathName());
        TestEqual(TEXT("Node hint uses real graph identity"), NodeHints[0].Graph, EventGraph->GetPathName());
    }
    auto Missing = MakeShared<FJsonObject>();
    Missing->SetStringField(TEXT("refPath"), World->GetPathName() + TEXT(":PersistentLevel.NoSuchBlueprint.NoSuchGraph"));
    Args->SetObjectField(TEXT("graph"), Missing);
    TestTrue(TEXT("Unknown subobject paths cannot guess a World presentation target"), FDSHMcpEditAdapter::FromCall(TEXT("write_graph_dsl"), Args, Result).IsEmpty());
    const FString OriginalName = Blueprint->GetName();
    Blueprint->Rename(TEXT("RetiredLevelScript"), nullptr, REN_DontCreateRedirectors | REN_NonTransactional | REN_DoNotDirty);
    ULevelScriptBlueprint* Replacement = NewObject<ULevelScriptBlueprint>(World->PersistentLevel, *OriginalName, RF_Transient);
    UEdGraph* ReplacementGraph = Graph(Replacement);
    Node(ReplacementGraph);
    Args->SetObjectField(TEXT("graph"), Ref(ReplacementGraph));
    TestTrue(TEXT("A reused path cannot retarget completion hints to a replacement Blueprint"),
        FDSHMcpEditAdapter::FinalizeCall(TEXT("write_graph_dsl"), Args, Result, Before).IsEmpty());
    TestFalse(TEXT("A replacement target is not automatically arranged"), Result->HasField(TEXT("dshLayout")));

    auto ReplacementArgs = MakeShared<FJsonObject>();
    ReplacementArgs->SetObjectField(TEXT("graph"), Ref(ReplacementGraph));
    const auto GraphBefore = FDSHMcpEditAdapter::CaptureCallGraphs(TEXT("write_graph_dsl"), ReplacementArgs);
    const FGuid OldGraphGuid = ReplacementGraph->GraphGuid;
    const FString OldGraphName = ReplacementGraph->GetName();
    ReplacementGraph->Rename(TEXT("RetiredEventGraph"), nullptr, REN_DontCreateRedirectors | REN_NonTransactional | REN_DoNotDirty);
    Replacement->UbergraphPages.Remove(ReplacementGraph);
    ReplacementGraph->MarkAsGarbage();
    UEdGraph* ReusedGraph = Graph(Replacement, *OldGraphName);
    ReusedGraph->GraphGuid = OldGraphGuid;
    UEdGraphNode* ReusedNode = Node(ReusedGraph);
    ReusedNode->NodePosX = 777;
    ReusedNode->NodePosY = 333;
    ReplacementArgs->SetObjectField(TEXT("graph"), Ref(ReusedGraph));
    auto ReusedResult = MakeShared<FJsonObject>();
    ReusedResult->SetField(TEXT("returnValue"), MakeShared<FJsonValueNull>());
    TestTrue(TEXT("An expired graph cannot retarget hints by reused path and GUID"),
        FDSHMcpEditAdapter::FinalizeCall(TEXT("write_graph_dsl"), ReplacementArgs, ReusedResult, GraphBefore).IsEmpty());
    TestEqual(TEXT("A replacement graph is not laid out using the old snapshot"), ReusedNode->NodePosX, 777);
    TestEqual(TEXT("Replacement graph vertical layout is untouched"), ReusedNode->NodePosY, 333);
    const TSharedPtr<FJsonObject>* SkippedLayout = nullptr;
    if (TestTrue(TEXT("Expired graph identity produces a layout warning"), ReusedResult->TryGetObjectField(TEXT("dshLayout"), SkippedLayout)))
        TestEqual(TEXT("Identity mismatch is skipped"), (*SkippedLayout)->GetStringField(TEXT("status")), FString(TEXT("skipped")));
    return true;
}
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpOperationOwnerTest, "DSH.Bridge.McpOperationContext.OwnersAndPins",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMcpOperationOwnerTest::RunTest(const FString&)
{
    FDSHMcpOperationContexts Contexts;
    TSharedPtr<FJsonObject> Details;
    FString Code, Message;
    TStrongObjectPtr<UWorld> World(NewObject<UWorld>(GetTransientPackage(), NAME_None, RF_Transient));
    World->PersistentLevel = NewObject<ULevel>(World.Get(), TEXT("PersistentLevel"), RF_Transient);
    World->PersistentLevel->OwningWorld = World.Get();
    ULevelScriptBlueprint* BP = NewObject<ULevelScriptBlueprint>(World->PersistentLevel, TEXT("ExactLevelScript"), RF_Transient);
    World->PersistentLevel->LevelScriptBlueprint = BP;
    UEdGraph* EventGraph = Graph(BP);
    UEdGraphNode* Output = Node(EventGraph), *Input = Node(EventGraph);
    auto Args = MakeShared<FJsonObject>();
    Args->SetObjectField(TEXT("output_pin"), Pin(Output, TEXT("EGPD_Output")));
    Args->SetObjectField(TEXT("input_pin"), Pin(Input, TEXT("EGPD_Input")));
    const auto CallArgs = Call(TEXT("connect_pins"), Args);
    const bool WasDirty = World->GetOutermost()->IsDirty();
    auto Result = Contexts.Prepare(TEXT("call_tool"), CallArgs, Details, Code, Message);
    if (!TestTrue(TEXT("Nested directional pins produce native context"), Result.IsValid())) { AddError(Message); return false; }
    TestTrue(TEXT("Context is explicitly verified"), Result->GetBoolField(TEXT("verified")));
    TestEqual(TEXT("Leaf identity is canonical"), Result->GetStringField(TEXT("toolName")), FString(TEXT("editor_toolset.toolsets.blueprint.BlueprintTools.connect_pins")));
    const auto& Owners = Result->GetArrayField(TEXT("blueprintOwners"));
    if (TestEqual(TEXT("Two nested pins share one real owner"), Owners.Num(), 1))
    {
        TestEqual(TEXT("Level Blueprint identity retains all subobjects"), Owners[0]->AsObject()->GetStringField(TEXT("path")), BP->GetPathName());
        TestEqual(TEXT("Owner reports its actual native subclass"), Owners[0]->AsObject()->GetStringField(TEXT("classPath")), ULevelScriptBlueprint::StaticClass()->GetPathName());
    }
    TestTrue(TEXT("Unchanged call verifies"), Contexts.Verify(Result->GetStringField(TEXT("token")), TEXT("call_tool"), CallArgs, true, Details, Code, Message));
    TestTrue(TEXT("Preflight did not connect pins"), Output->Pins[1]->LinkedTo.IsEmpty());
    TestEqual(TEXT("Preflight did not change node inventory"), EventGraph->Nodes.Num(), 2);
    TestEqual(TEXT("Preflight did not dirty the package"), World->GetOutermost()->IsDirty(), WasDirty);

    Args->SetObjectField(TEXT("input_pin"), Pin(Input, TEXT("EGPD_Input"), 99));
    const auto StalePinContext = Contexts.Prepare(TEXT("call_tool"), CallArgs, Details, Code, Message);
    if (TestTrue(TEXT("A stale pin index still exposes its actual Blueprint owner"), StalePinContext.IsValid()))
    {
        TestEqual(TEXT("Invalid pin belongs to the same real Blueprint"), StalePinContext->GetArrayField(TEXT("blueprintOwners"))[0]->AsObject()->GetStringField(TEXT("path")), BP->GetPathName());
        TestFalse(TEXT("A stale pin is rejected at dispatch validation"), Contexts.Verify(StalePinContext->GetStringField(TEXT("token")), TEXT("call_tool"), CallArgs, true, Details, Code, Message));
        TestEqual(TEXT("Strict dispatch retains the pin diagnostic"), Code, FString(TEXT("MCP_TARGET_PIN_INVALID")));
        TestEqual(TEXT("Strict pin failure never starts execution"), Details->GetStringField(TEXT("execution")), FString(TEXT("not_started")));
    }
    Args->SetObjectField(TEXT("input_pin"), Pin(Input, TEXT("EGPD_Input")));

    auto AddArgs = MakeShared<FJsonObject>();
    AddArgs->SetObjectField(TEXT("blueprint"), Ref(BP));
    AddArgs->SetStringField(TEXT("graph_name"), TEXT("MustNotBeCreated"));
    TestTrue(TEXT("A write is inspected without execution"), Contexts.Prepare(TEXT("call_tool"), Call(TEXT("add_function_graph"), AddArgs), Details, Code, Message).IsValid());
    TestEqual(TEXT("No function graph was created"), BP->FunctionGraphs.Num(), 0);

    TStrongObjectPtr<UBlueprint> Other(Blueprint());
    UEdGraphNode* Foreign = Node(Graph(Other.Get()));
    auto NodeArgs = MakeShared<FJsonObject>();
    NodeArgs->SetArrayField(TEXT("nodes"), {MakeShared<FJsonValueObject>(Ref(Input)), MakeShared<FJsonValueObject>(Ref(Foreign))});
    auto NodesCall = Call(TEXT("get_node_infos"), NodeArgs);
    Result = Contexts.Prepare(TEXT("call_tool"), NodesCall, Details, Code, Message);
    if (TestTrue(TEXT("Independent diagnostic batch may expose several owners"), Result.IsValid()))
    {
        TestEqual(TEXT("No owner is hidden by selecting the first"), Result->GetArrayField(TEXT("blueprintOwners")).Num(), 2);
        TestTrue(TEXT("Several owners are valid for a read"), Contexts.Verify(Result->GetStringField(TEXT("token")), TEXT("call_tool"), NodesCall, false, Details, Code, Message));
        TestFalse(TEXT("Several owners cannot be admitted as a write"), Contexts.Verify(Result->GetStringField(TEXT("token")), TEXT("call_tool"), NodesCall, true, Details, Code, Message));
        TestEqual(TEXT("Multi-owner write diagnosed"), Code, FString(TEXT("MCP_OPERATION_MULTIPLE_OWNERS")));
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpOperationObjectOwnerTest, "DSH.Bridge.McpOperationContext.ObjectTargets",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMcpOperationObjectOwnerTest::RunTest(const FString&)
{
    FDSHMcpOperationContexts Contexts;
    TSharedPtr<FJsonObject> Details;
    FString Code, Message;
    TStrongObjectPtr<UBlueprint> BP(FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), GetTransientPackage(),
        MakeUniqueObjectName(GetTransientPackage(), UBlueprint::StaticClass(), TEXT("OperationContextBP")),
        BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()));
    if (!TestTrue(TEXT("Generated Blueprint test fixture exists"), BP.IsValid() && BP->GeneratedClass)) return false;
    UEdGraph* EventGraph = Graph(BP.Get(), TEXT("ContextGraph"));
    UEdGraphNode* TargetNode = Node(EventGraph);
    for (UObject* Target : {static_cast<UObject*>(TargetNode), static_cast<UObject*>(EventGraph), static_cast<UObject*>(BP.Get()),
        static_cast<UObject*>(BP->GeneratedClass), BP->GeneratedClass->GetDefaultObject(false)})
    {
        if (!TestNotNull(TEXT("Actual object fixture exists"), Target)) continue;
        const auto Result = Contexts.Prepare(TEXT("call_tool"), ObjectCall(TEXT("get_class"), Target), Details, Code, Message);
        if (!TestTrue(TEXT("ObjectTools actual target resolves"), Result.IsValid())) { AddError(Message); continue; }
        const auto& Owners = Result->GetArrayField(TEXT("blueprintOwners"));
        if (TestEqual(TEXT("Node, graph, Blueprint, generated class, and true CDO have a real owner"), Owners.Num(), 1))
            TestEqual(TEXT("Owner is the actual Blueprint"), Owners[0]->AsObject()->GetStringField(TEXT("path")), BP->GetPathName());
    }
    TStrongObjectPtr<AActor> Actor(NewObject<AActor>(GetTransientPackage(), BP->GeneratedClass, NAME_None, RF_Transient));
    auto ActorCall = ObjectCall(TEXT("set_properties"), Actor.Get());
    // Caller annotations are not ownership evidence.
    ActorCall->GetObjectField(TEXT("arguments"))->SetStringField(TEXT("blueprintPath"), BP->GetPathName());
    const auto ActorResult = Contexts.Prepare(TEXT("call_tool"), ActorCall, Details, Code, Message);
    if (TestTrue(TEXT("Ordinary Actor instance can be inspected"), ActorResult.IsValid()))
        TestEqual(TEXT("An Actor is not attributed to its generated Blueprint class"), ActorResult->GetArrayField(TEXT("blueprintOwners")).Num(), 0);
    const auto BPCall = ObjectCall(TEXT("set_properties"), BP.Get());
    const auto BPResult = Contexts.Prepare(TEXT("call_tool"), BPCall, Details, Code, Message);
    TestTrue(TEXT("ObjectTools Blueprint writes bind the existing class default object"), BPResult.IsValid());
    BP->UbergraphPages.Remove(EventGraph);
    TestFalse(TEXT("ObjectTools rejects a node absent from its Blueprint graph inventory"), Contexts.Prepare(TEXT("call_tool"), ObjectCall(TEXT("get_class"), TargetNode), Details, Code, Message).IsValid());
    TestEqual(TEXT("Graph inventory failure diagnosed"), Code, FString(TEXT("MCP_OPERATION_OWNER_INVALID")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpOperationIdentityTest, "DSH.Bridge.McpOperationContext.StaleIdentityAndTokens",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHMcpOperationIdentityTest::RunTest(const FString&)
{
    FDSHMcpOperationContexts Contexts, AnotherConnection;
    TSharedPtr<FJsonObject> Details;
    FString Code, Message;
    TStrongObjectPtr<UBlueprint> BP(Blueprint());
    UEdGraph* EventGraph = Graph(BP.Get());
    UEdGraphNode* TargetNode = Node(EventGraph);
    auto Args = ObjectCall(TEXT("set_properties"), TargetNode);
    auto Result = Contexts.Prepare(TEXT("call_tool"), Args, Details, Code, Message);
    if (!TestTrue(TEXT("Initial token issued"), Result.IsValid())) return false;
    const FString Token = Result->GetStringField(TEXT("token"));
    TestFalse(TEXT("Token belongs only to its connection"), AnotherConnection.Verify(Token, TEXT("call_tool"), Args, true, Details, Code, Message));
    Args->GetObjectField(TEXT("arguments"))->SetStringField(TEXT("values"), TEXT("{\"NodePosX\":123}"));
    TestFalse(TEXT("Changed arguments are rejected"), Contexts.Verify(Token, TEXT("call_tool"), Args, true, Details, Code, Message));
    TestEqual(TEXT("Changed call diagnosed"), Code, FString(TEXT("MCP_OPERATION_CALL_MISMATCH")));
    Args->GetObjectField(TEXT("arguments"))->SetStringField(TEXT("values"), TEXT("{}"));
    TestTrue(TEXT("A failed check does not consume the original token"), Contexts.Verify(Token, TEXT("call_tool"), Args, true, Details, Code, Message));
    const FName OldName = TargetNode->GetFName();
    const FString OldPath = TargetNode->GetPathName();
    TargetNode->Rename(TEXT("RetiredNode"), nullptr, REN_DontCreateRedirectors | REN_NonTransactional | REN_DoNotDirty);
    EventGraph->Nodes.Remove(TargetNode);
    TargetNode->MarkAsGarbage();
    UEdGraphNode* Replacement = NewObject<UEdGraphNode>(EventGraph, OldName, RF_Transient);
    EventGraph->AddNode(Replacement, false, false);
    TestEqual(TEXT("Replacement reuses the exact path"), Replacement->GetPathName(), OldPath);
    TestFalse(TEXT("Same name cannot replace a weak identity"), Contexts.Verify(Token, TEXT("call_tool"), Args, true, Details, Code, Message));
    TestEqual(TEXT("Same-path recreation diagnosed"), Code, FString(TEXT("MCP_OPERATION_TARGET_CHANGED")));
    TestEqual(TEXT("Stale token proves no execution"), Details->GetStringField(TEXT("execution")), FString(TEXT("not_started")));
    Result = Contexts.Prepare(TEXT("call_tool"), Args, Details, Code, Message);
    if (TestTrue(TEXT("Fresh context accepts the new actual object"), Result.IsValid()))
    {
        Contexts.Consume(Result->GetStringField(TEXT("token")));
        TestFalse(TEXT("Admitted tokens cannot be reused"), Contexts.Verify(Result->GetStringField(TEXT("token")), TEXT("call_tool"), Args, true, Details, Code, Message));
    }
    Result = Contexts.Prepare(TEXT("call_tool"), Args, Details, Code, Message);
    if (Result)
    {
        for (int32 Index = 0; Index < 64; ++Index) Contexts.Prepare(TEXT("call_tool"), Args, Details, Code, Message);
        TestFalse(TEXT("The token store evicts old evidence at its capacity"), Contexts.Verify(Result->GetStringField(TEXT("token")), TEXT("call_tool"), Args, true, Details, Code, Message));
    }
    Contexts.Reset();
    TestFalse(TEXT("Unsupported toolsets cannot manufacture context"), Contexts.Prepare(TEXT("editor_toolset.toolsets.material.MaterialTools.get_expressions"), MakeShared<FJsonObject>(), Details, Code, Message).IsValid());
    return true;
}
#endif
