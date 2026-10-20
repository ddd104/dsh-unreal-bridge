#include "DSHMcpEditAdapter.h"

#include "DSHBlueprintLayout.h"
#include "DSHBlueprintOps.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphUtilities.h"
#include "Editor.h"
#include "Editor/Transactor.h"
#include "Engine/Blueprint.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "ScopedTransaction.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/Package.h"

namespace
{
FString LowerKey(FString Key)
{
    Key.ToLowerInline();
    Key.ReplaceInline(TEXT("_"), TEXT(""));
    Key.ReplaceInline(TEXT("-"), TEXT(""));
    return Key;
}

bool IsAssetKey(const FString& Key)
{
    static const TSet<FString> Keys = {
        TEXT("asset"), TEXT("assets"), TEXT("assetpath"), TEXT("assetpaths"),
        TEXT("objectpath"), TEXT("blueprint"), TEXT("blueprintpath"),
        TEXT("material"), TEXT("materialpath"), TEXT("animationblueprint"),
        TEXT("animationblueprintpath"), TEXT("targetasset"), TEXT("targetassetpath"),
        TEXT("newassetpath"), TEXT("createdasset"), TEXT("modifiedasset"),
        TEXT("materialorfunction"), TEXT("instance"), TEXT("texture"),
        TEXT("staticmesh"), TEXT("skeletalmesh"), TEXT("datatable"),
        TEXT("dataasset"), TEXT("curvetable"), TEXT("stringtable"),
        TEXT("object"), TEXT("path"), TEXT("newpath")};
    return Keys.Contains(Key);
}

bool IsNodeKey(const FString& Key)
{
    static const TSet<FString> Keys = {
        TEXT("node"), TEXT("nodes"), TEXT("nodeid"), TEXT("nodeids"),
        TEXT("nodeguid"), TEXT("nodeguids"), TEXT("expression"),
        TEXT("expressions"), TEXT("expressionid"), TEXT("expressionids"),
        TEXT("expressionguid"), TEXT("expressionguids"),
        TEXT("fromexpression"), TEXT("toexpression")};
    return Keys.Contains(Key);
}

bool IsMutation(const FString& Name)
{
    const FString Lower = Name.ToLower();
    static const TArray<FString> Verbs = {
        TEXT("create"), TEXT("add"), TEXT("set"), TEXT("update"), TEXT("edit"),
        TEXT("modify"), TEXT("remove"), TEXT("delete"), TEXT("move"),
        TEXT("rename"), TEXT("connect"), TEXT("disconnect"), TEXT("assign"),
        TEXT("duplicate"), TEXT("paste"), TEXT("insert"), TEXT("apply"),
        TEXT("replace"), TEXT("clear"), TEXT("layout"), TEXT("write"),
        TEXT("break"), TEXT("import"), TEXT("reimport"), TEXT("generate"), TEXT("retarget")};
    for (const FString& Verb : Verbs)
        if (Lower == Verb || Lower.EndsWith(TEXT(".") + Verb)
            || Lower.StartsWith(Verb + TEXT("_")) || Lower.Contains(TEXT(".") + Verb + TEXT("_"))
            || Lower.Contains(TEXT("_") + Verb + TEXT("_"))) return true;
    return false;
}

bool Succeeded(const TSharedPtr<FJsonObject>& Result)
{
    if (!Result.IsValid()) return false;
    bool bError = false, bSuccess = true, bOk = true;
    Result->TryGetBoolField(TEXT("isError"), bError);
    Result->TryGetBoolField(TEXT("success"), bSuccess);
    Result->TryGetBoolField(TEXT("ok"), bOk);
    if (bError || !bSuccess || !bOk) return false;
    // Some MCP implementations put their domain result in structuredContent.
    // Only explicit status fields are authoritative; arbitrary strings and null
    // returnValue are legitimate successful tool results.
    const TSharedPtr<FJsonObject>* Structured = nullptr;
    if (Result->TryGetObjectField(TEXT("structuredContent"), Structured) && Structured && Structured->IsValid())
    {
        (*Structured)->TryGetBoolField(TEXT("isError"), bError);
        (*Structured)->TryGetBoolField(TEXT("success"), bSuccess);
        (*Structured)->TryGetBoolField(TEXT("ok"), bOk);
    }
    return !bError && bSuccess && bOk;
}

void UnwrapCall(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments,
    FString& ActualName, TSharedPtr<FJsonObject>& ToolArguments)
{
    ActualName = ToolName;
    ToolArguments = Arguments;
    if (ToolName == TEXT("call_tool") && Arguments.IsValid())
    {
        Arguments->TryGetStringField(TEXT("tool_name"), ActualName);
        const TSharedPtr<FJsonObject>* Nested = nullptr;
        if (Arguments->TryGetObjectField(TEXT("arguments"), Nested) && Nested && Nested->IsValid()) ToolArguments = *Nested;
    }
}

FString NormalizeMcpAssetPath(const FString& Path)
{
    // Resolve the existing target's real owner. In particular a level Blueprint
    // remains /Map.Map:PersistentLevel.Map, never the World /Map.Map.
    UObject* Object = FindObject<UObject>(nullptr, *Path);
    if (Object && !Object->IsA<UPackage>())
    {
        if (UBlueprint* Blueprint = Cast<UBlueprint>(Object)) return Blueprint->GetPathName();
        if (UBlueprint* Blueprint = Object->GetTypedOuter<UBlueprint>()) return Blueprint->GetPathName();
        if (UBlueprint* Blueprint = Cast<UBlueprint>(Object->GetClass()->ClassGeneratedBy)) return Blueprint->GetPathName();
        for (UObject* Owner = Object; Owner; Owner = Owner->GetOuter())
            if (Owner->IsAsset()) return Owner->GetPathName();
        return {};
    }
    // Plain package paths can describe newly created assets. A missing subobject
    // is not an asset discovery mechanism and cannot be guessed from its prefix.
    if (Path.Contains(TEXT(":"))) return {};
    const FString Package = FPackageName::ObjectPathToPackageName(Path);
    if (!Package.StartsWith(TEXT("/")) || !FPackageName::IsValidLongPackageName(Package)) return {};
    if (Path != Package && !FPackageName::IsValidObjectPath(Path)) return {};
    return Path == Package ? Package + TEXT(".") + FPackageName::GetShortName(Package) : Path;
}

struct FExtracted
{
    TArray<FString> Assets;
    TArray<FString> Nodes;
    FString Graph;
    TOptional<FVector2D> Center;
};

void Extract(const TSharedPtr<FJsonValue>& Value, const FString& ParentKey, FExtracted& Out, int32 Depth = 0)
{
    if (!Value.IsValid() || Depth > 8) return;
    if (Value->Type == EJson::Object)
    {
        const TSharedPtr<FJsonObject> Object = Value->AsObject();
        if (!Object.IsValid()) return;
        // UE toolset UObject references wrap the path. Preserve its semantic
        // parent (graph, node, material, ...) instead of treating refPath as a key.
        FString RefPath;
        if (Object->TryGetStringField(TEXT("refPath"), RefPath))
            Extract(MakeShared<FJsonValueString>(RefPath), ParentKey, Out, Depth + 1);
        if (ParentKey == TEXT("pos") || ParentKey == TEXT("position"))
        {
            double X = 0, Y = 0;
            if (Object->TryGetNumberField(TEXT("x"), X) && Object->TryGetNumberField(TEXT("y"), Y))
                Out.Center = FVector2D(X, Y);
        }
        for (const auto& Pair : Object->Values)
            Extract(Pair.Value, LowerKey(FString(*Pair.Key)), Out, Depth + 1);
    }
    else if (Value->Type == EJson::Array)
    {
        for (const auto& Entry : Value->AsArray()) Extract(Entry, ParentKey, Out, Depth + 1);
    }
    else if (Value->Type == EJson::String)
    {
        const FString Text = Value->AsString();
        if (IsAssetKey(ParentKey))
        {
            const FString Path = NormalizeMcpAssetPath(Text);
            if (!Path.IsEmpty()) Out.Assets.AddUnique(Path);
            // Generic ObjectTools can address a node/graph through "object".
            // Resolve the actual loaded type before treating it as a graph
            // edit; a Blueprint/CDO/component property write is not enough.
            if ((ParentKey == TEXT("object") || ParentKey == TEXT("instance")) && Text.Contains(TEXT(":")))
            {
                UObject* Referenced = FindObject<UObject>(nullptr, *Text);
                if (const UEdGraphNode* Node = Cast<UEdGraphNode>(Referenced))
                {
                    Out.Nodes.AddUnique(Node->NodeGuid.ToString());
                    if (Node->GetGraph() && Out.Graph.IsEmpty()) Out.Graph = Node->GetGraph()->GetPathName();
                }
                else if (const UEdGraph* Graph = Cast<UEdGraph>(Referenced))
                    if (Out.Graph.IsEmpty()) Out.Graph = Graph->GetPathName();
            }
        }
        else if (IsNodeKey(ParentKey) && !Text.IsEmpty() && Text.Len() <= 256)
        {
            Out.Nodes.AddUnique(Text);
            const FString Path = NormalizeMcpAssetPath(Text);
            if (!Path.IsEmpty())
            {
                Out.Assets.AddUnique(Path);
                if (const UEdGraphNode* Node = FindObject<UEdGraphNode>(nullptr, *Text))
                {
                    Out.Nodes.AddUnique(Node->NodeGuid.ToString());
                    if (Out.Graph.IsEmpty() && Node->GetGraph()) Out.Graph = Node->GetGraph()->GetPathName();
                }
            }
        }
        else if (ParentKey == TEXT("graph") || ParentKey == TEXT("graphname") || ParentKey == TEXT("graphid"))
        {
            if (Out.Graph.IsEmpty()) Out.Graph = Text;
            if (ParentKey == TEXT("graph"))
            {
                const FString Path = NormalizeMcpAssetPath(Text);
                if (!Path.IsEmpty()) Out.Assets.AddUnique(Path);
            }
        }
        else if (ParentKey == TEXT("text") && Text.Len() < 262144 && Text.StartsWith(TEXT("{")))
        {
            TSharedPtr<FJsonObject> Inner;
            if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Inner) && Inner.IsValid())
                Extract(MakeShared<FJsonValueObject>(Inner), FString(), Out, Depth + 1);
        }
        else if ((ParentKey == TEXT("text") || ParentKey == TEXT("result")) && Text.StartsWith(TEXT("/")))
        {
            const FString Path = NormalizeMcpAssetPath(Text);
            if (!Path.IsEmpty())
            {
                Out.Assets.AddUnique(Path);
                if (Text.Contains(TEXT(":"))) Out.Nodes.AddUnique(Text);
            }
        }
    }
}

bool IsGraphEdit(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments)
{
    FString ActualName;
    TSharedPtr<FJsonObject> ToolArguments;
    UnwrapCall(ToolName, Arguments, ActualName, ToolArguments);
    if (!ToolArguments.IsValid() || !IsMutation(ActualName)) return false;
    const FString Lower = ActualName.ToLower();
    FString Leaf = Lower;
    int32 LastDot = INDEX_NONE;
    if (Lower.FindLastChar(TEXT('.'), LastDot)) Leaf = Lower.Mid(LastDot + 1);
    // Explicit positioning/formatting and history operations express the user's
    // own layout intent. Never immediately undo them with automatic formatting.
    for (const TCHAR* Word : {TEXT("position"), TEXT("location"), TEXT("layout"), TEXT("arrange"),
        TEXT("align"), TEXT("distribute"), TEXT("straighten"), TEXT("undo"), TEXT("redo")})
        if (Leaf.Contains(Word)) return false;
    if (Leaf == TEXT("move") || Leaf.StartsWith(TEXT("move_"))) return false;
    FExtracted Input;
    Extract(MakeShared<FJsonValueObject>(ToolArguments), FString(), Input);
    // Blueprint-wide property/variable changes must not format every graph
    // reconstructed by the editor. Require graph/node references or a graph
    // operation in the actual method name, rather than the toolset prefix.
    return !Input.Graph.IsEmpty() || !Input.Nodes.IsEmpty()
        || Leaf.Contains(TEXT("graph")) || Leaf.Contains(TEXT("node")) || Leaf.Contains(TEXT("pin"))
        || Leaf.Contains(TEXT("function")) || Leaf.Contains(TEXT("event")) || Leaf.Contains(TEXT("macro"));
}
}

TArray<FDSHAssetViewHint> FDSHMcpEditAdapter::FromCall(const FString& ToolName,
    const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result)
{
    TArray<FDSHAssetViewHint> Hints;
    if (!Arguments.IsValid() || !Succeeded(Result)) return Hints;
    FString ActualName;
    TSharedPtr<FJsonObject> ToolArguments;
    UnwrapCall(ToolName, Arguments, ActualName, ToolArguments);
    if (!IsMutation(ActualName)) return Hints;
    FExtracted Input, Output;
    Extract(MakeShared<FJsonValueObject>(ToolArguments), FString(), Input);
    Extract(MakeShared<FJsonValueObject>(Result), FString(), Output);
    double X = 0, Y = 0;
    if (ToolArguments->TryGetNumberField(TEXT("x"), X) && ToolArguments->TryGetNumberField(TEXT("y"), Y))
        Input.Center = FVector2D(X, Y);
    FString Folder, AssetName;
    if (ToolArguments->TryGetStringField(TEXT("folder_path"), Folder)
        && ToolArguments->TryGetStringField(TEXT("asset_name"), AssetName)
        && !AssetName.IsEmpty())
    {
        const FString CreatedPath = NormalizeMcpAssetPath(FPaths::Combine(Folder, AssetName));
        if (!CreatedPath.IsEmpty()) Input.Assets.AddUnique(CreatedPath);
    }
    const bool bPreferOutput = ActualName == TEXT("create") || ActualName.StartsWith(TEXT("create_"))
        || ActualName == TEXT("duplicate") || ActualName.StartsWith(TEXT("duplicate_"))
        || ActualName == TEXT("rename") || ActualName.StartsWith(TEXT("rename_"))
        || ActualName == TEXT("move") || ActualName.StartsWith(TEXT("move_"));
    const TArray<FString>& Assets = (bPreferOutput && !Output.Assets.IsEmpty()) || Input.Assets.IsEmpty() ? Output.Assets : Input.Assets;
    for (const FString& Path : Assets)
    {
        FDSHAssetViewHint& Hint = Hints.AddDefaulted_GetRef();
        Hint.AssetPath = Path;
        Hint.Graph = !Output.Graph.IsEmpty() ? Output.Graph : Input.Graph;
        Hint.NodeIds = Output.Nodes.IsEmpty() ? Input.Nodes : Output.Nodes;
        Hint.Center = Input.Center.IsSet() ? Input.Center : Output.Center;
    }
    return Hints;
}

namespace
{
UEdGraph* ResolveGraph(const FDSHAssetViewHint& Hint)
{
    if (Hint.Graph.IsEmpty()) return nullptr;
    UBlueprint* Blueprint = FindObject<UBlueprint>(nullptr, *Hint.AssetPath);
    if (!Blueprint) return nullptr;
    TArray<UEdGraph*> Graphs;
    Blueprint->GetAllGraphs(Graphs);
    for (UEdGraph* Graph : Graphs)
        if (Graph && (Graph->GetPathName() == Hint.Graph || Graph->GetName() == Hint.Graph
            || Graph->GraphGuid.ToString() == Hint.Graph)) return Graph;
    return nullptr;
}

FString NodeText(UEdGraphNode* Node)
{
    TSet<UObject*> Nodes;
    Nodes.Add(Node);
    FString Text;
    FEdGraphUtilities::ExportNodesToText(Nodes, Text);
    // Layout changes alone must not trigger another automatic layout. Keeping
    // this comparison semantic also handles tools that reposition other nodes
    // while adding or connecting their actual edit targets.
    TArray<FString> Lines;
    Text.ParseIntoArrayLines(Lines);
    FString Semantic;
    for (const FString& Line : Lines)
    {
        const FString Trimmed = Line.TrimStart();
        if (Trimmed.StartsWith(TEXT("NodePosX=")) || Trimmed.StartsWith(TEXT("NodePosY="))
            || Trimmed.StartsWith(TEXT("NodeWidth=")) || Trimmed.StartsWith(TEXT("NodeHeight="))) continue;
        Semantic += Line + TEXT("\n");
    }
    return Semantic;
}

FDSHMcpGraphSnapshot SnapshotGraph(UEdGraph* Graph)
{
    FDSHMcpGraphSnapshot Snapshot;
    if (UBlueprint* Blueprint = Graph->GetTypedOuter<UBlueprint>())
    {
        Snapshot.AssetPath = Blueprint->GetPathName();
        Snapshot.Owner = Blueprint;
    }
    Snapshot.Graph = Graph;
    Snapshot.GraphPath = Graph->GetPathName();
    Snapshot.GraphGuid = Graph->GraphGuid;
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        if (!Node) continue;
        const FString Id = Node->NodeGuid.ToString();
        Snapshot.Nodes.Add(Id, NodeText(Node));
        Snapshot.Positions.Add(Id, FVector2D(Node->NodePosX, Node->NodePosY));
        TArray<FString>& Neighbors = Snapshot.Neighbors.FindOrAdd(Id);
        for (UEdGraphPin* Pin : Node->Pins)
            if (Pin) for (UEdGraphPin* Linked : Pin->LinkedTo)
                if (Linked && Linked->GetOwningNode() && Linked->GetOwningNode()->GetGraph() == Graph)
                    Neighbors.AddUnique(Linked->GetOwningNode()->NodeGuid.ToString());
    }
    return Snapshot;
}

void ExtractCall(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments,
    const TSharedPtr<FJsonObject>& Result, FExtracted& Input, FExtracted& Output)
{
    FString ActualName;
    TSharedPtr<FJsonObject> ToolArguments;
    UnwrapCall(ToolName, Arguments, ActualName, ToolArguments);
    if (ToolArguments.IsValid()) Extract(MakeShared<FJsonValueObject>(ToolArguments), FString(), Input);
    if (Result.IsValid()) Extract(MakeShared<FJsonValueObject>(Result), FString(), Output);
}
}

TArray<FDSHMcpGraphSnapshot> FDSHMcpEditAdapter::CaptureGraphs(const TArray<FDSHAssetViewHint>& Hints)
{
    TArray<FDSHMcpGraphSnapshot> Snapshots;
    for (const FDSHAssetViewHint& Hint : Hints)
    {
        UEdGraph* Graph = ResolveGraph(Hint);
        if (!Graph) continue;
        if (!Snapshots.ContainsByPredicate([Graph](const FDSHMcpGraphSnapshot& Item) { return Item.GraphPath == Graph->GetPathName(); }))
            Snapshots.Add(SnapshotGraph(Graph));
    }
    return Snapshots;
}

TArray<FDSHMcpGraphSnapshot> FDSHMcpEditAdapter::CaptureCallGraphs(const FString& ToolName,
    const TSharedPtr<FJsonObject>& Arguments)
{
    TArray<FDSHMcpGraphSnapshot> Snapshots;
    if (!IsGraphEdit(ToolName, Arguments)) return Snapshots;
    FExtracted Input, Output;
    ExtractCall(ToolName, Arguments, nullptr, Input, Output);
    // A function can be created, or several graphs edited, without a graph
    // reference in the tool's return value. Snapshot all graphs of the explicitly
    // addressed Blueprints, then use semantic differences to select the targets.
    for (const FString& Path : Input.Assets)
    {
        UBlueprint* Blueprint = FindObject<UBlueprint>(nullptr, *Path);
        TArray<UEdGraph*> Graphs;
        if (Blueprint) Blueprint->GetAllGraphs(Graphs);
        if (Graphs.IsEmpty())
        {
            // Keep the pre-call inventory even when the Blueprint has no
            // graphs yet, or the explicitly requested new asset does not exist.
            FDSHMcpGraphSnapshot Empty;
            Empty.AssetPath = Path;
            Empty.Owner = Blueprint;
            Snapshots.Add(MoveTemp(Empty));
        }
        for (UEdGraph* Graph : Graphs) if (Graph) Snapshots.Add(SnapshotGraph(Graph));
    }
    return Snapshots;
}

TArray<FDSHAssetViewHint> FDSHMcpEditAdapter::FinalizeCall(const FString& ToolName,
    const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result,
    const TArray<FDSHMcpGraphSnapshot>& Before)
{
    TArray<FDSHAssetViewHint> Hints = FromCall(ToolName, Arguments, Result);
    Hints.RemoveAll([&Before](const FDSHAssetViewHint& Hint)
    {
        const FDSHMcpGraphSnapshot* Original = Before.FindByPredicate([&Hint](const FDSHMcpGraphSnapshot& Item) { return Item.AssetPath == Hint.AssetPath; });
        if (Original && (Original->Owner.IsStale() || (Original->Owner.IsValid()
            && FindObject<UBlueprint>(nullptr, *Hint.AssetPath) != Original->Owner.Get()))) return true;
        const FDSHMcpGraphSnapshot* OriginalGraph = Before.FindByPredicate([&Hint](const FDSHMcpGraphSnapshot& Item)
        { return Item.AssetPath == Hint.AssetPath && !Item.GraphPath.IsEmpty() && (Item.GraphPath == Hint.Graph || Item.GraphGuid.ToString() == Hint.Graph); });
        return OriginalGraph && (OriginalGraph->Graph.IsStale()
            || (!OriginalGraph->Graph.IsExplicitlyNull() && OriginalGraph->Graph.Get() != ResolveGraph(Hint)));
    });
    if (!Succeeded(Result) || !IsGraphEdit(ToolName, Arguments)) return Hints;
    FExtracted Input, Output;
    ExtractCall(ToolName, Arguments, Result, Input, Output);
    TArray<FString> Assets;
    for (const FDSHMcpGraphSnapshot& Snapshot : Before) Assets.AddUnique(Snapshot.AssetPath);
    TArray<TSharedPtr<FJsonValue>> Warnings;
    for (const FString& Path : Output.Assets)
        if (!Assets.Contains(Path) && FindObject<UBlueprint>(nullptr, *Path))
            Warnings.Add(MakeShared<FJsonValueString>(Path
                + TEXT(": Automatic layout was skipped because no pre-call graph inventory exists for this Blueprint.")));

    struct FChangedGraph
    {
        UEdGraph* Graph = nullptr;
        UBlueprint* Blueprint = nullptr;
        TSet<UEdGraphNode*> Seeds;
        FDSHAssetViewHint Hint;
    };
    TArray<FChangedGraph> Changed;
    for (const FString& Path : Assets)
    {
        const FDSHMcpGraphSnapshot* OwnerSnapshot = Before.FindByPredicate([&Path](const FDSHMcpGraphSnapshot& Item) { return Item.AssetPath == Path; });
        UBlueprint* Blueprint = OwnerSnapshot ? OwnerSnapshot->Owner.Get() : nullptr;
        if (Blueprint && Blueprint->GetPathName() != Path) continue;
        if (!Blueprint) continue;
        TArray<UEdGraph*> Graphs;
        Blueprint->GetAllGraphs(Graphs);
        for (UEdGraph* Graph : Graphs)
        {
            if (!Graph) continue;
            const FDSHMcpGraphSnapshot* PriorIdentity = Before.FindByPredicate([Graph, Blueprint](const FDSHMcpGraphSnapshot& Item)
            { return Item.Owner.Get() == Blueprint && !Item.GraphPath.IsEmpty() && (Item.GraphPath == Graph->GetPathName()
                || (Item.GraphGuid.IsValid() && Item.GraphGuid == Graph->GraphGuid)); });
            if (PriorIdentity && !PriorIdentity->Graph.IsExplicitlyNull() && PriorIdentity->Graph.Get() != Graph)
            {
                Warnings.Add(MakeShared<FJsonValueString>(Graph->GetPathName()
                    + TEXT(": Automatic layout was skipped because the original graph identity expired or was replaced.")));
                continue;
            }
            const FDSHMcpGraphSnapshot* Snapshot = Before.FindByPredicate([Graph, Blueprint](const FDSHMcpGraphSnapshot& Item)
            {
                return Item.Owner.Get() == Blueprint && Item.Graph.Get() == Graph
                    && Item.AssetPath == Blueprint->GetPathName() && (Item.GraphPath == Graph->GetPathName()
                    || (Item.GraphGuid.IsValid() && Item.GraphGuid == Graph->GraphGuid));
            });
            FChangedGraph Change;
            Change.Graph = Graph;
            Change.Blueprint = Blueprint;
            Change.Hint.AssetPath = Blueprint->GetPathName();
            Change.Hint.Graph = Graph->GetPathName();
            TMap<FString, UEdGraphNode*> Current;
            bool bChanged = false;
            for (UEdGraphNode* Node : Graph->Nodes)
            {
                if (!Node) continue;
                const FString Id = Node->NodeGuid.ToString();
                Current.Add(Id, Node);
                const FString* Previous = Snapshot ? Snapshot->Nodes.Find(Id) : nullptr;
                if (!Previous || *Previous != NodeText(Node))
                {
                    Change.Seeds.Add(Node);
                    Change.Hint.NodeIds.AddUnique(Id);
                    bChanged = true;
                }
            }
            FVector2D RemovedCenter = FVector2D::ZeroVector;
            int32 RemovedCount = 0;
            if (Snapshot) for (const auto& Entry : Snapshot->Nodes)
            {
                if (Current.Contains(Entry.Key)) continue;
                bChanged = true;
                if (const FVector2D* Position = Snapshot->Positions.Find(Entry.Key)) { RemovedCenter += *Position; ++RemovedCount; }
                // A deleted event/block boundary is no longer available as a
                // seed. Its surviving former neighbors identify the affected
                // fragments, including pure-data and delegate connections.
                if (const TArray<FString>* Neighbors = Snapshot->Neighbors.Find(Entry.Key))
                    for (const FString& Neighbor : *Neighbors) if (UEdGraphNode** Node = Current.Find(Neighbor))
                    {
                        Change.Seeds.Add(*Node);
                        Change.Hint.NodeIds.AddUnique(Neighbor);
                    }
            }
            if (!bChanged) continue;
            if (Change.Seeds.IsEmpty() && Blueprint->FunctionGraphs.Contains(Graph))
                for (const auto& Entry : Current) Change.Seeds.Add(Entry.Value);
            if (RemovedCount > 0 && Change.Hint.NodeIds.IsEmpty()) Change.Hint.Center = RemovedCenter / RemovedCount;
            Changed.Add(MoveTemp(Change));
        }
    }

    // No changed Blueprint graph means this was, for example, an asset property
    // tool with a graph-looking argument. Preserve its own result untouched.
    if (Changed.IsEmpty() && Warnings.IsEmpty()) return Hints;
    auto Layout = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> GraphResults;
    int32 MovedNodes = 0, ResizedComments = 0, FailedGraphs = 0;
    bool bUndoSeparate = false;
    const bool bCanTransact = GEditor && GEditor->CanTransact() && GEditor->Trans
        && !GEditor->Trans->IsActive() && !GIsTransacting;
    // There is no public API to append to a completed MCP tool transaction.
    // Never hold a transaction across the asynchronous tool call, or merge into
    // an unrelated active editor operation. Layout gets its own undo step.
    TUniquePtr<FScopedTransaction> Transaction;
    if (bCanTransact && !Changed.IsEmpty()) Transaction = MakeUnique<FScopedTransaction>(FText::FromString(TEXT("Arrange edited Blueprint graphs")));
    for (FChangedGraph& Change : Changed)
    {
        auto GraphResult = MakeShared<FJsonObject>();
        GraphResult->SetStringField(TEXT("assetPath"), Change.Hint.AssetPath);
        GraphResult->SetStringField(TEXT("graph"), Change.Hint.Graph);
        FDSHBlueprintLayoutResult Arranged;
        FString Error;
        bool bArranged = false;
        if (!bCanTransact) Error = TEXT("Automatic layout was skipped because an editor transaction is active or unavailable.");
        else if (Change.Seeds.IsEmpty())
        {
            // The deleted isolated node has no remaining block to arrange.
            bArranged = true;
        }
        else bArranged = FDSHBlueprintLayout::Arrange(Change.Graph, Change.Seeds, Arranged, Error);
        if (!bArranged)
        {
            ++FailedGraphs;
            if (Error.IsEmpty()) Error = TEXT("Automatic layout could not arrange this graph.");
            GraphResult->SetStringField(TEXT("status"), bCanTransact ? TEXT("failed") : TEXT("skipped"));
            GraphResult->SetStringField(TEXT("warning"), Error);
            Warnings.Add(MakeShared<FJsonValueString>(Change.Hint.Graph + TEXT(": ") + Error));
        }
        else
        {
            GraphResult->SetStringField(TEXT("status"), Arranged.MovedNodes || Arranged.ResizedComments ? TEXT("applied") : TEXT("unchanged"));
            MovedNodes += Arranged.MovedNodes;
            ResizedComments += Arranged.ResizedComments;
            if (Arranged.MovedNodes || Arranged.ResizedComments)
            {
                bUndoSeparate = true;
                FBlueprintEditorUtils::MarkBlueprintAsModified(Change.Blueprint);
                Change.Graph->NotifyGraphChanged();
            }
        }
        GraphResult->SetNumberField(TEXT("movedNodes"), Arranged.MovedNodes);
        GraphResult->SetNumberField(TEXT("resizedComments"), Arranged.ResizedComments);
        GraphResults.Add(MakeShared<FJsonValueObject>(GraphResult));
        // Derive focus targets before layout. Formatting neighboring nodes must
        // not replace the nodes that the tool actually edited.
        Hints.RemoveAll([&Change](const FDSHAssetViewHint& Hint)
        {
            return Hint.AssetPath == Change.Hint.AssetPath && (Hint.Graph.IsEmpty()
                || Hint.Graph == Change.Hint.Graph || Hint.Graph == Change.Graph->GetName()
                || Hint.Graph == Change.Graph->GraphGuid.ToString());
        });
        Hints.Add(Change.Hint);
    }
    if (Transaction && !bUndoSeparate) Transaction->Cancel();
    Transaction.Reset();
    Layout->SetStringField(TEXT("status"), Changed.IsEmpty() ? TEXT("skipped")
        : FailedGraphs == Changed.Num() ? (bCanTransact ? TEXT("failed") : TEXT("skipped"))
        : FailedGraphs || !Warnings.IsEmpty() ? TEXT("partial") : bUndoSeparate ? TEXT("applied") : TEXT("unchanged"));
    Layout->SetNumberField(TEXT("movedNodes"), MovedNodes);
    Layout->SetNumberField(TEXT("resizedComments"), ResizedComments);
    Layout->SetBoolField(TEXT("undoSeparate"), bUndoSeparate);
    Layout->SetArrayField(TEXT("graphs"), GraphResults);
    Layout->SetArrayField(TEXT("warnings"), Warnings);
    TArray<TSharedPtr<FJsonValue>> Revisions;
    TSet<UBlueprint*> Recorded;
    for (const FChangedGraph& Change : Changed)
    {
        if (Recorded.Contains(Change.Blueprint)) continue;
        Recorded.Add(Change.Blueprint);
        auto Revision = MakeShared<FJsonObject>();
        Revision->SetStringField(TEXT("assetPath"), Change.Blueprint->GetPathName());
        Revision->SetStringField(TEXT("revision"), FDSHBlueprintOps::Revision(Change.Blueprint));
        Revisions.Add(MakeShared<FJsonValueObject>(Revision));
    }
    Layout->SetArrayField(TEXT("revisions"), Revisions);
    Result->SetObjectField(TEXT("dshLayout"), Layout);
    return Hints;
}

void FDSHMcpEditAdapter::IncludeGraphChanges(TArray<FDSHAssetViewHint>& Hints,
    const TArray<FDSHMcpGraphSnapshot>& Before)
{
    // Tools such as write_graph_dsl return null rather than changed node IDs.
    // Compare only the graph addressed by the call, without another model/tool round.
    for (FDSHAssetViewHint& Hint : Hints)
    {
        UEdGraph* Graph = ResolveGraph(Hint);
        if (!Graph) continue;
        const FDSHMcpGraphSnapshot* Snapshot = Before.FindByPredicate(
            [Graph](const FDSHMcpGraphSnapshot& Item) { return Item.Graph.Get() == Graph && Item.GraphPath == Graph->GetPathName(); });
        if (!Snapshot) continue;
        TSet<FString> Remaining;
        for (UEdGraphNode* Node : Graph->Nodes)
        {
            if (!Node) continue;
            const FString Id = Node->NodeGuid.ToString();
            Remaining.Add(Id);
            const FString* Previous = Snapshot->Nodes.Find(Id);
            if (!Previous || *Previous != NodeText(Node)) Hint.NodeIds.AddUnique(Id);
        }
        FVector2D RemovedCenter = FVector2D::ZeroVector;
        int32 RemovedCount = 0;
        for (const auto& Entry : Snapshot->Positions)
            if (!Remaining.Contains(Entry.Key)) { RemovedCenter += Entry.Value; ++RemovedCount; }
        if (RemovedCount > 0 && !Hint.Center.IsSet()) Hint.Center = RemovedCenter / RemovedCount;
    }
}
