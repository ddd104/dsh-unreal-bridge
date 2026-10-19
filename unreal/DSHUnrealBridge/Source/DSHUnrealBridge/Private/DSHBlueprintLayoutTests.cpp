#if WITH_DEV_AUTOMATION_TESTS
#include "DSHBlueprintLayout.h"
#include "DSHBlueprintOps.h"
#include "DSHMcpEditAdapter.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphNode_Comment.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "GameFramework/Actor.h"
#include "K2Node_CallFunction.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_Knot.h"
#include "Kismet/KismetMathLibrary.h"
#include "Kismet/KismetStringLibrary.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Misc/AutomationTest.h"
#include "UObject/Package.h"
#include "UObject/StrongObjectPtr.h"

namespace DSHBlueprintLayoutTests
{
UBlueprint* CreateBlueprint(bool bResolvableByBridge = false)
{
    UObject* Outer = GetTransientPackage();
    FName Name = MakeUniqueObjectName(Outer, UBlueprint::StaticClass(), TEXT("DSHLayoutTest"));
    if (bResolvableByBridge)
    {
        // The bridge accepts /Game paths. This package exists only in memory and is never saved.
        const FString Suffix = FGuid::NewGuid().ToString(EGuidFormats::Digits);
        Outer = CreatePackage(*(TEXT("/Game/DSHBridgeTests/BP_Layout_") + Suffix));
        Outer->SetFlags(RF_Transient);
        Name = FName(*(TEXT("BP_Layout_") + Suffix));
    }
    UBlueprint* Blueprint = FKismetEditorUtilities::CreateBlueprint(AActor::StaticClass(), Outer, Name,
        BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass(), TEXT("DSHLayoutTests"));
    if (Blueprint)
    {
        Blueprint->ClearFlags(RF_Public | RF_Standalone);
        Blueprint->SetFlags(RF_Transient | RF_Transactional);
    }
    return Blueprint;
}

UEdGraph* CreateFunction(UBlueprint* Blueprint, const TCHAR* Name)
{
    UEdGraph* Graph = FBlueprintEditorUtils::CreateNewGraph(Blueprint, FName(Name), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
    FBlueprintEditorUtils::AddFunctionGraph<UClass>(Blueprint, Graph, true, nullptr);
    return Graph;
}

template <typename NodeType>
NodeType* AddNode(UEdGraph* Graph)
{
    NodeType* Node = NewObject<NodeType>(Graph, NAME_None, RF_Transactional);
    Graph->AddNode(Node, false, false);
    Node->CreateNewGuid();
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();
    return Node;
}

UK2Node_CallFunction* AddCall(UEdGraph* Graph, UClass* Owner, const TCHAR* FunctionName)
{
    UFunction* Function = Owner->FindFunctionByName(FName(FunctionName));
    if (!Function) return nullptr;
    UK2Node_CallFunction* Node = NewObject<UK2Node_CallFunction>(Graph, NAME_None, RF_Transactional);
    Node->SetFromFunction(Function);
    Graph->AddNode(Node, false, false);
    Node->CreateNewGuid();
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();
    return Node;
}

UK2Node_CallFunction* AddPrint(UEdGraph* Graph)
{
    return AddCall(Graph, UKismetSystemLibrary::StaticClass(), TEXT("PrintString"));
}

UK2Node_CustomEvent* AddCustomEvent(UEdGraph* Graph, const TCHAR* Name)
{
    UK2Node_CustomEvent* Node = NewObject<UK2Node_CustomEvent>(Graph, NAME_None, RF_Transactional);
    Node->CustomFunctionName = FName(Name);
    Graph->AddNode(Node, false, false);
    Node->CreateNewGuid();
    Node->PostPlacedNewNode();
    Node->AllocateDefaultPins();
    return Node;
}

bool Connect(UEdGraphNode* From, const TCHAR* FromPin, UEdGraphNode* To, const TCHAR* ToPin)
{
    if (!From || !To) return false;
    UEdGraphPin* Output = From->FindPin(FName(FromPin), EGPD_Output);
    UEdGraphPin* Input = To->FindPin(FName(ToPin), EGPD_Input);
    return Output && Input && From->GetGraph()->GetSchema()->TryCreateConnection(Output, Input);
}

FIntPoint Position(const UEdGraphNode* Node)
{
    return FIntPoint(Node->NodePosX, Node->NodePosY);
}

TMap<UEdGraphNode*, FIntPoint> Positions(UEdGraph* Graph)
{
    TMap<UEdGraphNode*, FIntPoint> Result;
    for (UEdGraphNode* Node : Graph->Nodes) if (Node) Result.Add(Node, Position(Node));
    return Result;
}

bool PositionsMatch(UEdGraph* Graph, const TMap<UEdGraphNode*, FIntPoint>& Expected)
{
    if (Graph->Nodes.Num() != Expected.Num()) return false;
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        const FIntPoint* Point = Expected.Find(Node);
        if (!Point || *Point != Position(Node)) return false;
    }
    return true;
}

bool Overlap(const UEdGraphNode* A, const UEdGraphNode* B)
{
    const FVector2D ASize = FDSHBlueprintLayout::EstimateSize(A);
    const FVector2D BSize = FDSHBlueprintLayout::EstimateSize(B);
    return A->NodePosX < B->NodePosX + BSize.X && B->NodePosX < A->NodePosX + ASize.X
        && A->NodePosY < B->NodePosY + BSize.Y && B->NodePosY < A->NodePosY + ASize.Y;
}

bool CheckNoOverlap(FAutomationTestBase& Test, UEdGraph* Graph)
{
    bool bValid = true;
    for (int32 Index = 0; Index < Graph->Nodes.Num(); ++Index)
    {
        const UEdGraphNode* A = Graph->Nodes[Index];
        if (!A || A->IsA<UEdGraphNode_Comment>()) continue;
        for (int32 Other = Index + 1; Other < Graph->Nodes.Num(); ++Other)
        {
            const UEdGraphNode* B = Graph->Nodes[Other];
            if (!B || B->IsA<UEdGraphNode_Comment>()) continue;
            bValid &= Test.TestFalse(FString::Printf(TEXT("%s and %s have separate node bounds"), *A->GetName(), *B->GetName()), Overlap(A, B));
        }
    }
    return bValid;
}

// Deliberately exclude geometry: layout must preserve all executable/data connections and pin values.
FString Semantics(UEdGraph* Graph)
{
    TArray<FString> Nodes;
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        if (!Node) continue;
        FString Value = Node->NodeGuid.ToString() + Node->GetClass()->GetPathName() + Node->NodeComment;
        for (UEdGraphPin* Pin : Node->Pins)
        {
            if (!Pin) continue;
            Value += Pin->PinName.ToString() + FString::FromInt(Pin->Direction) + Pin->PinType.PinCategory.ToString();
            Value += Pin->DefaultValue + GetPathNameSafe(Pin->DefaultObject) + Pin->DefaultTextValue.ToString();
            TArray<FString> Links;
            for (UEdGraphPin* Link : Pin->LinkedTo)
                if (Link) Links.Add(Link->GetOwningNode()->NodeGuid.ToString() + TEXT(":") + Link->PinName.ToString());
            Links.Sort();
            Value += FString::Join(Links, TEXT("|"));
        }
        Nodes.Add(Value);
    }
    Nodes.Sort();
    return FString::Join(Nodes, TEXT("\n"));
}

bool Arrange(FAutomationTestBase& Test, UEdGraph* Graph, UEdGraphNode* Seed, FDSHBlueprintLayoutResult& Result)
{
    TSet<UEdGraphNode*> Seeds;
    Seeds.Add(Seed);
    FString Error;
    const bool bSucceeded = FDSHBlueprintLayout::Arrange(Graph, Seeds, Result, Error);
    return Test.TestTrue(TEXT("Layout succeeds: ") + Error, bSucceeded);
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutFunction, "DSH.Bridge.BlueprintLayout.FunctionTopology", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutFunction::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint());
    if (!TestNotNull(TEXT("Transient Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = CreateFunction(Blueprint.Get(), TEXT("LayoutFunction"));
    UK2Node_FunctionEntry* Entry = nullptr;
    for (UEdGraphNode* Node : Graph->Nodes) if (auto* FunctionEntry = Cast<UK2Node_FunctionEntry>(Node)) Entry = FunctionEntry;
    UK2Node_IfThenElse* Branch = AddNode<UK2Node_IfThenElse>(Graph);
    UK2Node_CallFunction* First = AddPrint(Graph);
    UK2Node_CallFunction* Second = AddPrint(Graph);
    UK2Node_CallFunction* Third = AddPrint(Graph);
    UK2Node_Knot* Knot = AddNode<UK2Node_Knot>(Graph);
    UK2Node_CallFunction* Pure = AddCall(Graph, UKismetMathLibrary::StaticClass(), TEXT("Not_PreBool"));
    if (!TestTrue(TEXT("Real K2 fixture nodes allocated"), Entry && First && Second && Third && Pure)) return false;
    bool bConnected = Connect(Entry, TEXT("then"), Branch, TEXT("execute"));
    bConnected &= Connect(Branch, TEXT("then"), First, TEXT("execute"));
    bConnected &= Connect(Branch, TEXT("else"), Second, TEXT("execute"));
    bConnected &= Connect(First, TEXT("then"), Knot, TEXT("InputPin"));
    bConnected &= Connect(Knot, TEXT("OutputPin"), Third, TEXT("execute"));
    bConnected &= Connect(Pure, TEXT("ReturnValue"), Branch, TEXT("Condition"));
    if (!TestTrue(TEXT("Branch, pure input, and execution reroute are connected"), bConnected)) return false;
    First->FindPin(TEXT("InString"))->DefaultValue = TEXT("Keep this value");
    // A disconnected node still belongs to the current function and must be included.
    UK2Node_CallFunction* Isolated = AddPrint(Graph);
    if (!TestNotNull(TEXT("Disconnected function node allocated"), Isolated)) return false;
    for (UEdGraphNode* Node : Graph->Nodes) { Node->NodePosX = 0; Node->NodePosY = 0; }
    const FString Before = Semantics(Graph);
    FDSHBlueprintLayoutResult Result;
    if (!Arrange(*this, Graph, First, Result)) return false;
    TestTrue(TEXT("Existing overlapping nodes were moved"), Result.MovedNodes > 0);
    CheckNoOverlap(*this, Graph);
    TestTrue(TEXT("Function execution starts before the branch"), Entry->NodePosX < Branch->NodePosX);
    TestTrue(TEXT("Both branch paths flow to the right"), Branch->NodePosX < First->NodePosX && Branch->NodePosX < Second->NodePosX);
    TestTrue(TEXT("Execution reroute remains between its neighbors"), First->NodePosX < Knot->NodePosX && Knot->NodePosX < Third->NodePosX);
    TestNotEqual(TEXT("A disconnected node in the current function is arranged"), Position(Isolated), FIntPoint::ZeroValue);
    TestEqual(TEXT("Layout preserves graph semantics"), Semantics(Graph), Before);
    const auto Settled = Positions(Graph);
    FDSHBlueprintLayoutResult Again;
    if (!Arrange(*this, Graph, First, Again)) return false;
    TestTrue(TEXT("Repeating layout has identical coordinates"), PositionsMatch(Graph, Settled));
    TestEqual(TEXT("A settled function reports no moved nodes"), Again.MovedNodes, 0);
    // Preview duplication may assign fresh GUIDs. Those must not choose a different layout.
    for (UEdGraphNode* Node : Graph->Nodes) { Node->CreateNewGuid(); Node->NodePosX = 0; Node->NodePosY = 0; }
    FDSHBlueprintLayoutResult Regenerated;
    if (!Arrange(*this, Graph, First, Regenerated)) return false;
    TestTrue(TEXT("Fresh node GUIDs do not change the arrangement"), PositionsMatch(Graph, Settled));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutIsolation, "DSH.Bridge.BlueprintLayout.EventIsolation", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutIsolation::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint());
    if (!TestNotNull(TEXT("Transient Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = Blueprint->UbergraphPages[0];
    // Remove automatically placed ghosts from this geometry-only fixture.
    for (UEdGraphNode* Node : TArray<TObjectPtr<UEdGraphNode>>(Graph->Nodes)) Graph->RemoveNode(Node);
    auto* Main = AddCustomEvent(Graph, TEXT("LayoutMain"));
    auto* Timer = AddCall(Graph, UKismetSystemLibrary::StaticClass(), TEXT("K2_SetTimerDelegate"));
    auto* First = AddPrint(Graph);
    auto* Callback = AddCustomEvent(Graph, TEXT("LayoutCallback"));
    auto* CallbackPrint = AddPrint(Graph);
    auto* OtherEvent = AddCustomEvent(Graph, TEXT("LayoutOther"));
    auto* OtherPrint = AddPrint(Graph);
    auto* SharedPure = AddCall(Graph, UKismetStringLibrary::StaticClass(), TEXT("Conv_IntToString"));
    if (!TestTrue(TEXT("Delegate and shared-data fixture nodes allocated"), Timer && First && CallbackPrint && OtherPrint && SharedPure)) return false;
    bool bConnected = Connect(Main, TEXT("then"), Timer, TEXT("execute"));
    bConnected &= Connect(Timer, TEXT("then"), First, TEXT("execute"));
    bConnected &= Connect(Callback, TEXT("then"), CallbackPrint, TEXT("execute"));
    bConnected &= Connect(Callback, TEXT("OutputDelegate"), Timer, TEXT("Delegate"));
    bConnected &= Connect(OtherEvent, TEXT("then"), OtherPrint, TEXT("execute"));
    bConnected &= Connect(SharedPure, TEXT("ReturnValue"), First, TEXT("InString"));
    bConnected &= Connect(SharedPure, TEXT("ReturnValue"), OtherPrint, TEXT("InString"));
    if (!TestTrue(TEXT("Execution, delegate, and shared data links are valid"), bConnected)) return false;
    OtherEvent->NodePosX = 8000; OtherEvent->NodePosY = 7000;
    OtherPrint->NodePosX = 8600; OtherPrint->NodePosY = 7000;
    SharedPure->NodePosX = 7000; SharedPure->NodePosY = 6000;
    UEdGraph* OtherFunction = CreateFunction(Blueprint.Get(), TEXT("UntouchedFunction"));
    auto* OtherFunctionPrint = AddPrint(OtherFunction);
    if (!TestNotNull(TEXT("Other function node allocated"), OtherFunctionPrint)) return false;
    OtherFunctionPrint->NodePosX = -777; OtherFunctionPrint->NodePosY = 333;
    const auto OtherFunctionBefore = Positions(OtherFunction);
    const auto OtherEventBefore = Position(OtherEvent);
    const auto OtherPrintBefore = Position(OtherPrint);
    const auto SharedBefore = Position(SharedPure);
    const FString Before = Semantics(Graph);
    FDSHBlueprintLayoutResult Result;
    if (!Arrange(*this, Graph, Timer, Result)) return false;
    CheckNoOverlap(*this, Graph);
    TestEqual(TEXT("An unrelated event keeps its position"), Position(OtherEvent), OtherEventBefore);
    TestEqual(TEXT("The unrelated event chain keeps its position"), Position(OtherPrint), OtherPrintBefore);
    TestEqual(TEXT("Pure data shared with another event stays in place"), Position(SharedPure), SharedBefore);
    TestTrue(TEXT("A different function is untouched"), PositionsMatch(OtherFunction, OtherFunctionBefore));
    TestFalse(TEXT("Delegate callback nodes are separated"), Overlap(Callback, CallbackPrint));
    TestTrue(TEXT("Delegate callback execution flows to the right"), Callback->NodePosX < CallbackPrint->NodePosX);
    TestEqual(TEXT("Layout preserves delegate and data semantics"), Semantics(Graph), Before);
    const auto Settled = Positions(Graph);
    FDSHBlueprintLayoutResult Again;
    if (!Arrange(*this, Graph, Timer, Again)) return false;
    TestTrue(TEXT("Event layout does not drift on repeated edits"), PositionsMatch(Graph, Settled));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutCycleComments, "DSH.Bridge.BlueprintLayout.CyclesAndComments", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutCycleComments::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint());
    if (!TestNotNull(TEXT("Transient Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = CreateFunction(Blueprint.Get(), TEXT("CycleFunction"));
    auto* First = AddPrint(Graph);
    auto* Second = AddPrint(Graph);
    auto* Third = AddPrint(Graph);
    if (!TestTrue(TEXT("Cycle fixture nodes allocated"), First && Second && Third)) return false;
    // Layout also runs while a graph is being edited, before the compiler validates execution cycles.
    First->FindPin(TEXT("then"))->MakeLinkTo(Second->FindPin(TEXT("execute")));
    Second->FindPin(TEXT("then"))->MakeLinkTo(Third->FindPin(TEXT("execute")));
    Third->FindPin(TEXT("then"))->MakeLinkTo(First->FindPin(TEXT("execute")));
    First->NodePosX = 1000; First->NodePosY = 1000;
    Second->NodePosX = 1500; Second->NodePosY = 1000;
    Third->NodePosX = 2000; Third->NodePosY = 1000;
    auto* Comment = AddNode<UEdGraphNode_Comment>(Graph);
    Comment->NodeComment = TEXT("Keep the cycle grouped");
    Comment->NodePosX = 900; Comment->NodePosY = 900;
    Comment->NodeWidth = 1800; Comment->NodeHeight = 700;
    Comment->AddNodeUnderComment(First); Comment->AddNodeUnderComment(Second); Comment->AddNodeUnderComment(Third);
    const FString Before = Semantics(Graph);
    FDSHBlueprintLayoutResult Result;
    if (!Arrange(*this, Graph, First, Result)) return false;
    CheckNoOverlap(*this, Graph);
    for (UEdGraphNode* Node : TArray<UEdGraphNode*>{First, Second, Third})
    {
        const FVector2D Size = FDSHBlueprintLayout::EstimateSize(Node);
        TestTrue(TEXT("Comment still contains each original member"), Node->NodePosX >= Comment->NodePosX
            && Node->NodePosY >= Comment->NodePosY && Node->NodePosX + Size.X <= Comment->NodePosX + Comment->NodeWidth
            && Node->NodePosY + Size.Y <= Comment->NodePosY + Comment->NodeHeight);
    }
    TestTrue(TEXT("Comment bounds were updated"), Result.ResizedComments > 0);
    TestEqual(TEXT("Cycle and comment semantics are preserved"), Semantics(Graph), Before);
    const auto Settled = Positions(Graph);
    const FIntPoint CommentSize(Comment->NodeWidth, Comment->NodeHeight);
    FDSHBlueprintLayoutResult Again;
    if (!Arrange(*this, Graph, First, Again)) return false;
    TestTrue(TEXT("Cyclic layout remains stable"), PositionsMatch(Graph, Settled));
    TestEqual(TEXT("Comment bounds do not grow on repeated layout"), FIntPoint(Comment->NodeWidth, Comment->NodeHeight), CommentSize);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutPatch, "DSH.Bridge.BlueprintLayout.PatchTransaction", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutPatch::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint(true));
    if (!TestNotNull(TEXT("Isolated in-memory Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = Blueprint->UbergraphPages[0];
    auto* Event = AddCustomEvent(Graph, TEXT("LayoutPatchEvent"));
    auto* Existing = AddPrint(Graph);
    if (!TestNotNull(TEXT("Existing print node created"), Existing)) return false;
    if (!TestTrue(TEXT("Existing execution is linked"), Connect(Event, TEXT("then"), Existing, TEXT("execute")))) return false;
    Event->NodePosX = 420; Event->NodePosY = 240;
    Existing->NodePosX = 420; Existing->NodePosY = 240;
    Existing->FindPin(TEXT("InString"))->DefaultValue = TEXT("Existing text");
    FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint.Get());
    FKismetEditorUtilities::CompileBlueprint(Blueprint.Get(), EBlueprintCompileOptions::SkipGarbageCollection | EBlueprintCompileOptions::SkipSave);
    const FString Before = FDSHBlueprintOps::Revision(Blueprint.Get());
    const auto BeforePositions = Positions(Graph);
    const FString ExistingId = Existing->NodeGuid.ToString();
    FDSHBlueprintOps Ops;
    FString Code, Error;
    auto Patch = MakeShared<FJsonObject>();
    Patch->SetStringField(TEXT("assetPath"), Blueprint->GetPathName());
    Patch->SetStringField(TEXT("graph"), Graph->GetName());
    Patch->SetStringField(TEXT("baseRevision"), Before);
    TArray<TSharedPtr<FJsonValue>> Operations;
    for (const TCHAR* Id : {TEXT("first"), TEXT("second")})
    {
        auto Add = MakeShared<FJsonObject>();
        Add->SetStringField(TEXT("op"), TEXT("add_node")); Add->SetStringField(TEXT("nodeId"), Id);
        Add->SetStringField(TEXT("kind"), TEXT("call_function"));
        Add->SetStringField(TEXT("functionPath"), TEXT("/Script/Engine.KismetSystemLibrary:PrintString"));
        Operations.Add(MakeShared<FJsonValueObject>(Add));
    }
    auto AddConnection = [&Operations](const FString& FromId, const TCHAR* ToId)
    {
        auto Op = MakeShared<FJsonObject>(); Op->SetStringField(TEXT("op"), TEXT("connect"));
        auto From = MakeShared<FJsonObject>(); From->SetStringField(TEXT("node"), FromId); From->SetStringField(TEXT("pin"), TEXT("then"));
        auto To = MakeShared<FJsonObject>(); To->SetStringField(TEXT("node"), ToId); To->SetStringField(TEXT("pin"), TEXT("execute"));
        Op->SetObjectField(TEXT("from"), From); Op->SetObjectField(TEXT("to"), To);
        Operations.Add(MakeShared<FJsonValueObject>(Op));
    };
    AddConnection(ExistingId, TEXT("first")); AddConnection(TEXT("first"), TEXT("second"));
    Patch->SetArrayField(TEXT("operations"), Operations);
    const auto Preview = Ops.Execute(TEXT("preview_patch"), Patch, Code, Error);
    if (!TestTrue(TEXT("Preview validates and lays out the transient copy: ") + Error, Preview.IsValid())) return false;
    TestEqual(TEXT("Preview preserves the original revision"), FDSHBlueprintOps::Revision(Blueprint.Get()), Before);
    TestTrue(TEXT("Preview preserves all original coordinates"), PositionsMatch(Graph, BeforePositions));
    const auto Applied = Ops.Execute(TEXT("apply_patch"), Patch, Code, Error);
    if (!TestTrue(TEXT("The batch compiles and applies: ") + Error, Applied.IsValid())) return false;
    const auto Layout = Applied->GetObjectField(TEXT("layout"));
    TestTrue(TEXT("Batch automatically arranged nodes"), Layout->GetNumberField(TEXT("movedNodes")) > 0);
    TestEqual(TEXT("Preview and commit arrange the same number of nodes"), Preview->GetObjectField(TEXT("layout"))->GetNumberField(TEXT("movedNodes")), Layout->GetNumberField(TEXT("movedNodes")));
    TestFalse(TEXT("Native layout belongs to the edit transaction"), Layout->GetBoolField(TEXT("undoSeparate")));
    TestEqual(TEXT("Both nodes were added"), Graph->Nodes.Num(), BeforePositions.Num() + 2);
    // Default ghost events are unrelated to this edited chain and may have their own initial geometry.
    UEdGraphNode* Next = Existing->FindPin(TEXT("then"))->LinkedTo.IsEmpty() ? nullptr : Existing->FindPin(TEXT("then"))->LinkedTo[0]->GetOwningNode();
    if (!TestNotNull(TEXT("New execution remains connected"), Next)) return false;
    UEdGraphNode* Last = Next->FindPin(TEXT("then"))->LinkedTo.IsEmpty() ? nullptr : Next->FindPin(TEXT("then"))->LinkedTo[0]->GetOwningNode();
    if (!TestNotNull(TEXT("Second new execution remains connected"), Last)) return false;
    TestFalse(TEXT("Existing nodes are separated by the same batch"), Overlap(Event, Existing));
    TestTrue(TEXT("Nodes added without coordinates follow execution order"), Existing->NodePosX < Next->NodePosX && Next->NodePosX < Last->NodePosX);
    TestFalse(TEXT("New nodes have separate bounds"), Overlap(Next, Last));
    TestEqual(TEXT("Existing pin defaults survive automatic layout"), Existing->FindPin(TEXT("InString"))->DefaultValue, FString(TEXT("Existing text")));
    TestEqual(TEXT("Returned revision includes final layout"), Applied->GetStringField(TEXT("revision")), FDSHBlueprintOps::Revision(Blueprint.Get()));
    auto Undo = MakeShared<FJsonObject>(); Undo->SetStringField(TEXT("assetPath"), Blueprint->GetPathName()); Undo->SetStringField(TEXT("baseRevision"), Applied->GetStringField(TEXT("revision")));
    const auto Undone = Ops.Execute(TEXT("undo"), Undo, Code, Error);
    if (!TestTrue(TEXT("One undo restores the batch: ") + Error, Undone.IsValid())) return false;
    TestEqual(TEXT("One undo restores original content and layout"), FDSHBlueprintOps::Revision(Blueprint.Get()), Before);
    TestTrue(TEXT("Undo restores all original positions"), PositionsMatch(Graph, BeforePositions));

    auto Move = MakeShared<FJsonObject>(); Move->SetStringField(TEXT("op"), TEXT("move_node")); Move->SetStringField(TEXT("nodeId"), ExistingId);
    auto Target = MakeShared<FJsonObject>(); Target->SetNumberField(TEXT("x"), 1234); Target->SetNumberField(TEXT("y"), 5678); Move->SetObjectField(TEXT("position"), Target);
    Patch->SetArrayField(TEXT("operations"), {MakeShared<FJsonValueObject>(Move)});
    const auto Moved = Ops.Execute(TEXT("apply_patch"), Patch, Code, Error);
    if (!TestTrue(TEXT("A manual move applies: ") + Error, Moved.IsValid())) return false;
    TestEqual(TEXT("Manual position is kept"), Position(Existing), FIntPoint(1234, 5678));
    TestEqual(TEXT("A move-only patch skips automatic layout"), Moved->GetObjectField(TEXT("layout"))->GetNumberField(TEXT("movedNodes")), 0.0);
    Undo->SetStringField(TEXT("baseRevision"), Moved->GetStringField(TEXT("revision")));
    TestTrue(TEXT("Manual move can be undone"), Ops.Execute(TEXT("undo"), Undo, Code, Error).IsValid());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutCommentGrowth, "DSH.Bridge.BlueprintLayout.CommentContentGrowth", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutCommentGrowth::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint());
    if (!TestNotNull(TEXT("Transient comment-growth Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = CreateFunction(Blueprint.Get(), TEXT("GrowingCommentFunction"));
    auto* Print = AddPrint(Graph);
    if (!TestNotNull(TEXT("Comment member allocated"), Print)) return false;
    Print->NodePosX = 1000; Print->NodePosY = 1000;
    Print->FindPin(TEXT("InString"))->DefaultValue = TEXT("Short");
    const FVector2D OriginalSize = FDSHBlueprintLayout::EstimateSize(Print);
    auto* Comment = AddNode<UEdGraphNode_Comment>(Graph);
    Comment->NodeComment = TEXT("Keep this node inside");
    Comment->NodePosX = 952; Comment->NodePosY = 904;
    Comment->NodeWidth = FMath::CeilToInt(OriginalSize.X) + 96;
    Comment->NodeHeight = FMath::CeilToInt(OriginalSize.Y) + 144;
    Comment->AddNodeUnderComment(Print);
    const FIntPoint OldCommentSize(Comment->NodeWidth, Comment->NodeHeight);
    FString LongDefault;
    for (int32 Line = 0; Line < 12; ++Line) LongDefault += FString::ChrN(256, TEXT('W')) + TEXT("\n");
    Print->FindPin(TEXT("InString"))->DefaultValue = LongDefault;
    const FVector2D GrownSize = FDSHBlueprintLayout::EstimateSize(Print);
    if (!TestTrue(TEXT("Edited content no longer fits inside the original comment"),
        GrownSize.X > OldCommentSize.X || GrownSize.Y > OldCommentSize.Y)) return false;
    const FString BeforeLayout = Semantics(Graph);
    FDSHBlueprintLayoutResult Result;
    if (!Arrange(*this, Graph, Print, Result)) return false;
    TestTrue(TEXT("Content growth expands its original comment"), Result.ResizedComments > 0);
    TestTrue(TEXT("The enlarged member stays inside its original comment"),
        Print->NodePosX >= Comment->NodePosX && Print->NodePosY >= Comment->NodePosY
        && Print->NodePosX + GrownSize.X <= Comment->NodePosX + Comment->NodeWidth
        && Print->NodePosY + GrownSize.Y <= Comment->NodePosY + Comment->NodeHeight);
    TestEqual(TEXT("Comment growth preserves values and connections"), Semantics(Graph), BeforeLayout);
    const auto Settled = Positions(Graph);
    const FIntPoint SettledSize(Comment->NodeWidth, Comment->NodeHeight);
    FDSHBlueprintLayoutResult Again;
    if (!Arrange(*this, Graph, Print, Again)) return false;
    TestTrue(TEXT("Expanded comments have stable node coordinates"), PositionsMatch(Graph, Settled));
    TestEqual(TEXT("Expanded comments have stable dimensions"), FIntPoint(Comment->NodeWidth, Comment->NodeHeight), SettledSize);
    TestEqual(TEXT("Repeated expanded-comment layout moves no nodes"), Again.MovedNodes, 0);
    TestEqual(TEXT("Repeated expanded-comment layout resizes no comments"), Again.ResizedComments, 0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutSafeCoordinates, "DSH.Bridge.BlueprintLayout.SafeCoordinateFailure", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutSafeCoordinates::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint());
    if (!TestNotNull(TEXT("Transient coordinate-safety Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = Blueprint->UbergraphPages[0];
    for (UEdGraphNode* Node : TArray<TObjectPtr<UEdGraphNode>>(Graph->Nodes)) Graph->RemoveNode(Node);
    auto* First = AddPrint(Graph);
    auto* Second = AddPrint(Graph);
    if (!TestTrue(TEXT("Coordinate-safety nodes allocated"), First && Second)) return false;
    if (!TestTrue(TEXT("Coordinate-safety chain connected"), Connect(First, TEXT("then"), Second, TEXT("execute")))) return false;
    First->NodePosX = 2000; First->NodePosY = 2000;
    Second->NodePosX = 2500; Second->NodePosY = 2000;
    auto* FixedComment = AddNode<UEdGraphNode_Comment>(Graph);
    FixedComment->NodeComment = TEXT("Unrelated fixed annotation");
    FixedComment->NodePosX = 0; FixedComment->NodePosY = 0;
    FixedComment->NodeWidth = 1000; FixedComment->NodeHeight = 150000000;
    // Neither edited node belongs to this annotation. Avoiding it would push
    // their proposed layout outside the supported editor coordinate range.
    const auto BeforePositions = Positions(Graph);
    const FIntPoint BeforeCommentSize(FixedComment->NodeWidth, FixedComment->NodeHeight);
    const FString BeforeSemantics = Semantics(Graph);
    TSet<UEdGraphNode*> Seeds; Seeds.Add(First);
    FDSHBlueprintLayoutResult Result;
    FString Error;
    TestFalse(TEXT("An unsafe coordinate plan is rejected"), FDSHBlueprintLayout::Arrange(Graph, Seeds, Result, Error));
    TestFalse(TEXT("Coordinate rejection reports its reason"), Error.IsEmpty());
    TestTrue(TEXT("Rejected layout makes no partial node moves"), PositionsMatch(Graph, BeforePositions));
    TestEqual(TEXT("Rejected layout preserves comment dimensions"), FIntPoint(FixedComment->NodeWidth, FixedComment->NodeHeight), BeforeCommentSize);
    TestEqual(TEXT("Rejected layout preserves graph content"), Semantics(Graph), BeforeSemantics);
    TestEqual(TEXT("Rejected layout reports no committed node moves"), Result.MovedNodes, 0);
    TestEqual(TEXT("Rejected layout reports no committed comment resizing"), Result.ResizedComments, 0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutMcpFinalization, "DSH.Bridge.BlueprintLayout.McpFinalization", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutMcpFinalization::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint(true));
    if (!TestNotNull(TEXT("Isolated MCP Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* Graph = CreateFunction(Blueprint.Get(), TEXT("McpFunction"));
    auto* First = AddPrint(Graph);
    auto* Second = AddPrint(Graph);
    if (!TestTrue(TEXT("MCP function nodes allocated"), First && Second)) return false;
    if (!TestTrue(TEXT("MCP fixture execution is connected"), Connect(First, TEXT("then"), Second, TEXT("execute")))) return false;
    for (UEdGraphNode* Node : Graph->Nodes) { Node->NodePosX = 320; Node->NodePosY = 240; }
    auto Args = MakeShared<FJsonObject>();
    auto GraphRef = MakeShared<FJsonObject>(); GraphRef->SetStringField(TEXT("refPath"), Graph->GetPathName());
    Args->SetObjectField(TEXT("graph"), GraphRef);
    auto Wrapped = MakeShared<FJsonObject>(); Wrapped->SetStringField(TEXT("tool_name"), TEXT("write_graph_dsl")); Wrapped->SetObjectField(TEXT("arguments"), Args);
    const auto Before = FDSHMcpEditAdapter::CaptureCallGraphs(TEXT("call_tool"), Wrapped);
    TestTrue(TEXT("MCP snapshot captures the actual target graph"), Before.ContainsByPredicate([Graph](const FDSHMcpGraphSnapshot& Item) { return Item.GraphPath == Graph->GetPathName(); }));
    First->FindPin(TEXT("InString"))->DefaultValue = TEXT("Changed by MCP");
    const FString AfterToolSemantics = Semantics(Graph);
    auto Result = MakeShared<FJsonObject>(); Result->SetField(TEXT("returnValue"), MakeShared<FJsonValueNull>());
    const auto Hints = FDSHMcpEditAdapter::FinalizeCall(TEXT("call_tool"), Wrapped, Result, Before);
    const TSharedPtr<FJsonObject>* Layout = nullptr;
    if (!TestTrue(TEXT("Successful MCP edit includes layout metadata"), Result->TryGetObjectField(TEXT("dshLayout"), Layout))) return false;
    TestEqual(TEXT("MCP layout was applied"), (*Layout)->GetStringField(TEXT("status")), FString(TEXT("applied")));
    TestTrue(TEXT("MCP layout moves overlapping nodes"), (*Layout)->GetNumberField(TEXT("movedNodes")) > 0);
    TestTrue(TEXT("Completed MCP tool reports its separate layout undo step"), (*Layout)->GetBoolField(TEXT("undoSeparate")));
    CheckNoOverlap(*this, Graph);
    TestEqual(TEXT("Finalization preserves the tool's content"), Semantics(Graph), AfterToolSemantics);
    const auto Revisions = (*Layout)->GetArrayField(TEXT("revisions"));
    if (TestEqual(TEXT("MCP returns one final asset revision"), Revisions.Num(), 1))
        TestEqual(TEXT("MCP revision includes final node coordinates"), Revisions[0]->AsObject()->GetStringField(TEXT("revision")), FDSHBlueprintOps::Revision(Blueprint.Get()));
    const FDSHAssetViewHint* Hint = Hints.FindByPredicate([Graph](const FDSHAssetViewHint& Item) { return Item.Graph == Graph->GetPathName(); });
    if (TestNotNull(TEXT("MCP returns the edited graph focus hint"), Hint))
    {
        TestTrue(TEXT("Focus identifies the semantic edit"), Hint->NodeIds.Contains(First->NodeGuid.ToString()));
        TestFalse(TEXT("Layout-only neighbors are excluded from edit focus"), Hint->NodeIds.Contains(Second->NodeGuid.ToString()));
    }

    const auto FailedBefore = FDSHMcpEditAdapter::CaptureCallGraphs(TEXT("call_tool"), Wrapped);
    First->NodeComment = TEXT("A tool can fail after a partial edit");
    const auto FailedPositions = Positions(Graph);
    auto Failed = MakeShared<FJsonObject>(); Failed->SetBoolField(TEXT("isError"), true);
    TestTrue(TEXT("A failed MCP tool produces no presentation hints"), FDSHMcpEditAdapter::FinalizeCall(TEXT("call_tool"), Wrapped, Failed, FailedBefore).IsEmpty());
    TestFalse(TEXT("Failed MCP results have no automatic layout metadata"), Failed->HasField(TEXT("dshLayout")));
    TestTrue(TEXT("Failed MCP results leave node positions unchanged"), PositionsMatch(Graph, FailedPositions));

    for (const TCHAR* Tool : {TEXT("set_node_position"), TEXT("arrange_nodes"), TEXT("read_graph")})
    {
        const auto ExcludedBefore = FDSHMcpEditAdapter::CaptureCallGraphs(Tool, Args);
        TestTrue(FString(Tool) + TEXT(" skips automatic layout capture"), ExcludedBefore.IsEmpty());
        First->NodePosX = 777; First->NodePosY = 888;
        const auto ExplicitPositions = Positions(Graph);
        auto ExplicitResult = MakeShared<FJsonObject>(); ExplicitResult->SetField(TEXT("returnValue"), MakeShared<FJsonValueNull>());
        FDSHMcpEditAdapter::FinalizeCall(Tool, Args, ExplicitResult, ExcludedBefore);
        TestTrue(FString(Tool) + TEXT(" preserves explicit positions"), PositionsMatch(Graph, ExplicitPositions));
        TestFalse(FString(Tool) + TEXT(" adds no automatic layout metadata"), ExplicitResult->HasField(TEXT("dshLayout")));
    }
    const auto PositionOnlyBefore = FDSHMcpEditAdapter::CaptureCallGraphs(TEXT("write_graph_dsl"), Args);
    First->NodePosX += 100;
    const auto PositionOnlyAfter = Positions(Graph);
    auto PositionOnlyResult = MakeShared<FJsonObject>(); PositionOnlyResult->SetField(TEXT("returnValue"), MakeShared<FJsonValueNull>());
    FDSHMcpEditAdapter::FinalizeCall(TEXT("write_graph_dsl"), Args, PositionOnlyResult, PositionOnlyBefore);
    TestTrue(TEXT("Position-only changes do not trigger another layout"), PositionsMatch(Graph, PositionOnlyAfter));
    TestFalse(TEXT("Position-only changes have no automatic layout metadata"), PositionOnlyResult->HasField(TEXT("dshLayout")));
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintLayoutMcpNewFunctions, "DSH.Bridge.BlueprintLayout.McpNewFunctions", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintLayoutMcpNewFunctions::RunTest(const FString&)
{
    using namespace DSHBlueprintLayoutTests;
    TStrongObjectPtr<UBlueprint> Blueprint(CreateBlueprint(true));
    if (!TestNotNull(TEXT("Isolated multi-graph MCP Blueprint created"), Blueprint.Get())) return false;
    UEdGraph* ExistingGraph = CreateFunction(Blueprint.Get(), TEXT("ExistingMcpFunction"));
    auto* Existing = AddPrint(ExistingGraph);
    if (!TestNotNull(TEXT("Existing MCP function node allocated"), Existing)) return false;
    for (UEdGraphNode* Node : ExistingGraph->Nodes) { Node->NodePosX = 500; Node->NodePosY = 500; }
    auto Args = MakeShared<FJsonObject>();
    auto BlueprintRef = MakeShared<FJsonObject>(); BlueprintRef->SetStringField(TEXT("refPath"), Blueprint->GetPathName());
    Args->SetObjectField(TEXT("blueprint"), BlueprintRef);
    const auto Before = FDSHMcpEditAdapter::CaptureCallGraphs(TEXT("add_function_graph"), Args);
    TestTrue(TEXT("A Blueprint-only function edit snapshots existing graphs"), Before.ContainsByPredicate([ExistingGraph](const FDSHMcpGraphSnapshot& Item) { return Item.GraphPath == ExistingGraph->GetPathName(); }));
    const auto UnchangedEventPositions = Positions(Blueprint->UbergraphPages[0]);
    UEdGraph* NewGraph = CreateFunction(Blueprint.Get(), TEXT("NewMcpFunction"));
    auto* NewFirst = AddPrint(NewGraph);
    auto* NewSecond = AddPrint(NewGraph);
    if (!TestTrue(TEXT("New MCP function nodes allocated"), NewFirst && NewSecond)) return false;
    if (!TestTrue(TEXT("New MCP function execution is connected"), Connect(NewFirst, TEXT("then"), NewSecond, TEXT("execute")))) return false;
    for (UEdGraphNode* Node : NewGraph->Nodes) { Node->NodePosX = 500; Node->NodePosY = 500; }
    Existing->FindPin(TEXT("InString"))->DefaultValue = TEXT("Also edited in this call");
    auto Result = MakeShared<FJsonObject>(); Result->SetField(TEXT("returnValue"), MakeShared<FJsonValueNull>());
    const auto Hints = FDSHMcpEditAdapter::FinalizeCall(TEXT("add_function_graph"), Args, Result, Before);
    const TSharedPtr<FJsonObject>* Layout = nullptr;
    if (!TestTrue(TEXT("A Blueprint-only call discovers its new function"), Result->TryGetObjectField(TEXT("dshLayout"), Layout))) return false;
    TestEqual(TEXT("All changed function graphs are finalized"), (*Layout)->GetArrayField(TEXT("graphs")).Num(), 2);
    TestTrue(TEXT("New function receives a presentation hint"), Hints.ContainsByPredicate([NewGraph](const FDSHAssetViewHint& Item) { return Item.Graph == NewGraph->GetPathName(); }));
    TestTrue(TEXT("An additionally edited function receives its own hint"), Hints.ContainsByPredicate([ExistingGraph](const FDSHAssetViewHint& Item) { return Item.Graph == ExistingGraph->GetPathName(); }));
    CheckNoOverlap(*this, NewGraph); CheckNoOverlap(*this, ExistingGraph);
    TestTrue(TEXT("New function execution flows to the right"), NewFirst->NodePosX < NewSecond->NodePosX);
    TestTrue(TEXT("An unchanged event graph keeps its original positions"), PositionsMatch(Blueprint->UbergraphPages[0], UnchangedEventPositions));
    const auto Revisions = (*Layout)->GetArrayField(TEXT("revisions"));
    if (TestEqual(TEXT("Multi-graph edits return one revision per asset"), Revisions.Num(), 1))
        TestEqual(TEXT("Multi-graph revision includes every final layout"), Revisions[0]->AsObject()->GetStringField(TEXT("revision")), FDSHBlueprintOps::Revision(Blueprint.Get()));
    return true;
}
#endif
