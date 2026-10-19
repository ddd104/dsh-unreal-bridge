#include "DSHBlueprintLayout.h"

#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraphNode_Comment.h"
#include "EdGraphSchema_K2.h"
#include "Engine/Blueprint.h"
#include "K2Node_Knot.h"

namespace
{
constexpr double Grid = 16.0;
constexpr double HorizontalGap = 112.0;
constexpr double VerticalGap = 64.0;
constexpr double ComponentGap = 128.0;
constexpr double CommentMargin = 48.0;
// Match the bridge's explicit node-position range and bound synchronous editor work.
constexpr double CoordinateLimit = 100000.0;
constexpr int32 MaxGraphNodes = 16384;
constexpr int32 MaxSelectedNodes = 4096;
constexpr int32 MaxComments = 512;
constexpr int32 MaxGraphPins = 131072;

double Snap(double Value)
{
    return static_cast<double>(FMath::CeilToInt64(Value / Grid)) * Grid;
}

struct FRect
{
    FVector2D Position = FVector2D::ZeroVector;
    FVector2D Size = FVector2D::ZeroVector;

    bool Contains(const FRect& Other) const
    {
        return Other.Position.X >= Position.X && Other.Position.Y >= Position.Y
            && Other.Position.X + Other.Size.X <= Position.X + Size.X
            && Other.Position.Y + Other.Size.Y <= Position.Y + Size.Y;
    }

    bool Intersects(const FRect& Other, double Margin = 0.0) const
    {
        return Position.X < Other.Position.X + Other.Size.X + Margin
            && Position.X + Size.X + Margin > Other.Position.X
            && Position.Y < Other.Position.Y + Other.Size.Y + Margin
            && Position.Y + Size.Y + Margin > Other.Position.Y;
    }
};

double TextWidth(const FString& Text)
{
    double Width = 0.0, Longest = 0.0;
    for (TCHAR Character : Text)
    {
        if (Character == TEXT('\n')) { Longest = FMath::Max(Longest, Width); Width = 0.0; }
        else if (Character != TEXT('\r')) Width += Character >= 0x2e80 ? 17.0 : 9.0;
    }
    return FMath::Max(Longest, Width);
}

int32 LineCount(const FString& Text)
{
    int32 Count = 1;
    for (TCHAR Character : Text) if (Character == TEXT('\n')) ++Count;
    return Count;
}

double BubbleHeight(const UEdGraphNode* Node)
{
    return Node && Node->bCommentBubbleVisible && !Node->NodeComment.IsEmpty()
        && !Node->IsA<UEdGraphNode_Comment>()
        ? Snap(24.0 + 20.0 * LineCount(Node->NodeComment)) : 0.0;
}

FRect Bounds(const UEdGraphNode* Node)
{
    return { FVector2D(Node->NodePosX, Node->NodePosY - BubbleHeight(Node)),
        FDSHBlueprintLayout::EstimateSize(Node) };
}

bool IsControlPin(const UEdGraphPin* Pin)
{
    return Pin && (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Delegate
        || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_MCDelegate);
}

struct FNode
{
    UEdGraphNode* Object = nullptr;
    int32 Order = 0;
    bool Control = false;
    TArray<int32> Out;
    TArray<int32> In;
    TArray<int32> ControlLinks;
};

struct FComment
{
    UEdGraphNode_Comment* Object = nullptr;
    int32 Order = 0;
    FRect Original;
    TArray<int32> Members;
    bool Movable = false;
    int32 Parent = INDEX_NONE;
};

struct FItem
{
    int32 Node = INDEX_NONE;
    int32 Comment = INDEX_NONE;
    int32 Order = 0;
    TArray<int32> Children;
    TArray<int32> Members;
    FVector2D Position = FVector2D::ZeroVector;
    FVector2D Size = FVector2D::ZeroVector;
};

/** Iterative Kosaraju avoids recursive graph traversal on long execution chains. */
void StrongComponents(const TArray<TArray<int32>>& Out, const TArray<TArray<int32>>& In,
    TArray<int32>& Component, TArray<TArray<int32>>& Members)
{
    const int32 Count = Out.Num();
    TArray<bool> Visited; Visited.Init(false, Count);
    TArray<int32> Finished;
    struct FFrame { int32 Node; int32 Next; };
    TArray<FFrame> Stack;
    for (int32 Start = 0; Start < Count; ++Start)
    {
        if (Visited[Start]) continue;
        Visited[Start] = true;
        Stack.Add({ Start, 0 });
        while (!Stack.IsEmpty())
        {
            FFrame& Frame = Stack.Last();
            if (Frame.Next == Out[Frame.Node].Num())
            {
                Finished.Add(Frame.Node);
                Stack.Pop(EAllowShrinking::No);
                continue;
            }
            const int32 Next = Out[Frame.Node][Frame.Next++];
            if (!Visited[Next]) { Visited[Next] = true; Stack.Add({ Next, 0 }); }
        }
    }
    Component.Init(INDEX_NONE, Count);
    TArray<int32> Work;
    for (int32 Finish = Finished.Num() - 1; Finish >= 0; --Finish)
    {
        const int32 Start = Finished[Finish];
        if (Component[Start] != INDEX_NONE) continue;
        const int32 Id = Members.AddDefaulted();
        Component[Start] = Id;
        Work.Add(Start);
        while (!Work.IsEmpty())
        {
            const int32 Current = Work.Pop(EAllowShrinking::No);
            Members[Id].Add(Current);
            for (int32 Next : In[Current])
                if (Component[Next] == INDEX_NONE) { Component[Next] = Id; Work.Add(Next); }
        }
        Members[Id].Sort();
    }
}

/** Arrange sibling items, collapsing cycles before assigning left-to-right columns. */
FVector2D PlaceItems(TArray<FItem>& Items, const TArray<int32>& Children,
    const TArray<FNode>& Nodes)
{
    if (Children.IsEmpty()) return FVector2D::ZeroVector;
    const int32 Count = Children.Num();
    TMap<int32, int32> Owner;
    for (int32 Child = 0; Child < Count; ++Child)
        for (int32 Member : Items[Children[Child]].Members) Owner.Add(Member, Child);
    TArray<TArray<int32>> Out, In, FlowIn;
    Out.SetNum(Count); In.SetNum(Count); FlowIn.SetNum(Count);
    for (const auto& Pair : Owner)
    {
        for (int32 Next : Nodes[Pair.Key].Out)
        {
            const int32* Target = Owner.Find(Next);
            if (Target && Pair.Value != *Target)
            {
                Out[Pair.Value].AddUnique(*Target);
                In[*Target].AddUnique(Pair.Value);
                if (Nodes[Pair.Key].ControlLinks.Contains(Next)) FlowIn[*Target].AddUnique(Pair.Value);
            }
        }
    }
    for (int32 Index = 0; Index < Count; ++Index) { Out[Index].Sort(); In[Index].Sort(); FlowIn[Index].Sort(); }

    TArray<int32> Component;
    TArray<TArray<int32>> Components;
    StrongComponents(Out, In, Component, Components);
    TArray<TArray<int32>> ComponentOut; ComponentOut.SetNum(Components.Num());
    TArray<int32> Degree, Rank; Degree.Init(0, Components.Num()); Rank.Init(0, Components.Num());
    for (int32 Index = 0; Index < Count; ++Index)
        for (int32 Next : Out[Index])
            if (Component[Index] != Component[Next]
                && !ComponentOut[Component[Index]].Contains(Component[Next]))
            {
                ComponentOut[Component[Index]].Add(Component[Next]);
                ++Degree[Component[Next]];
            }
    TArray<int32> Ready;
    for (int32 Index = 0; Index < Components.Num(); ++Index) if (Degree[Index] == 0) Ready.Add(Index);
    for (int32 Cursor = 0; Cursor < Ready.Num(); ++Cursor)
    {
        const int32 Current = Ready[Cursor];
        for (int32 Next : ComponentOut[Current])
        {
            Rank[Next] = FMath::Max(Rank[Next], Rank[Current] + Components[Current].Num());
            if (--Degree[Next] == 0) Ready.Add(Next);
        }
    }
    TArray<int32> NodeRank; NodeRank.SetNum(Count);
    for (int32 Index = 0; Index < Components.Num(); ++Index)
        for (int32 Offset = 0; Offset < Components[Index].Num(); ++Offset)
            NodeRank[Components[Index][Offset]] = Rank[Index] + Offset;

    // Disconnected logic blocks get separate horizontal bands; their order is graph order.
    TArray<bool> Visited; Visited.Init(false, Count);
    double Bottom = 0.0, Right = 0.0;
    for (int32 Start = 0; Start < Count; ++Start)
    {
        if (Visited[Start]) continue;
        TArray<int32> Block { Start };
        Visited[Start] = true;
        for (int32 Cursor = 0; Cursor < Block.Num(); ++Cursor)
        {
            const int32 Current = Block[Cursor];
            for (int32 Next : Out[Current]) if (!Visited[Next]) { Visited[Next] = true; Block.Add(Next); }
            for (int32 Next : In[Current]) if (!Visited[Next]) { Visited[Next] = true; Block.Add(Next); }
        }
        TArray<int32> Ranks;
        for (int32 Index : Block) Ranks.AddUnique(NodeRank[Index]);
        Ranks.Sort();
        double X = 0.0, BlockHeight = 0.0;
        TArray<double> Center; Center.Init(0.0, Count);
        TArray<bool> Placed; Placed.Init(false, Count);
        for (int32 Column : Ranks)
        {
            TArray<int32> ColumnItems;
            for (int32 Index : Block) if (NodeRank[Index] == Column) ColumnItems.Add(Index);
            auto Barycenter = [&](int32 Index)
            {
                double Sum = 0.0; int32 Neighbors = 0;
                // Keep the execution line level when a node also has pure-data inputs.
                for (int32 Before : FlowIn[Index]) if (Placed[Before]) { Sum += Center[Before]; ++Neighbors; }
                if (Neighbors > 0) return Sum / Neighbors;
                for (int32 Before : In[Index]) if (Placed[Before]) { Sum += Center[Before]; ++Neighbors; }
                return Neighbors > 0 ? Sum / Neighbors : 0.0;
            };
            ColumnItems.Sort([&](int32 A, int32 B)
            {
                const double AY = Barycenter(A), BY = Barycenter(B);
                return AY == BY ? Items[Children[A]].Order < Items[Children[B]].Order : AY < BY;
            });
            double Y = 0.0, ColumnWidth = 0.0;
            for (int32 Index : ColumnItems)
            {
                FItem& Item = Items[Children[Index]];
                Y = FMath::Max(Y, Snap(FMath::Max(0.0, Barycenter(Index) - Item.Size.Y / 2.0)));
                Item.Position = FVector2D(X, Bottom + Y);
                Center[Index] = Y + Item.Size.Y / 2.0;
                Placed[Index] = true;
                Y += Item.Size.Y + VerticalGap;
                ColumnWidth = FMath::Max(ColumnWidth, Item.Size.X);
                BlockHeight = FMath::Max(BlockHeight, Y - VerticalGap);
            }
            X += Snap(ColumnWidth) + HorizontalGap;
        }
        Right = FMath::Max(Right, X - HorizontalGap);
        Bottom += Snap(BlockHeight) + ComponentGap;
    }
    return FVector2D(Snap(Right), Snap(Bottom - ComponentGap));
}
}

FVector2D FDSHBlueprintLayout::EstimateSize(const UEdGraphNode* Node)
{
    if (!Node) return FVector2D::ZeroVector;
    if (const auto* Comment = Cast<UEdGraphNode_Comment>(Node))
        return FVector2D(FMath::Max(128, Comment->NodeWidth), FMath::Max(80, Comment->NodeHeight));
    if (Node->IsA<UK2Node_Knot>())
        return FVector2D(FMath::Max(48.0, TextWidth(Node->NodeComment) + (BubbleHeight(Node) > 0 ? 32.0 : 0.0)),
            32.0 + BubbleHeight(Node));

    const FString Title = Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString();
    double InputWidth = 0.0, OutputWidth = 0.0;
    int32 InputRows = 0, OutputRows = 0;
    for (const UEdGraphPin* Pin : Node->Pins)
    {
        if (!Pin || Pin->bHidden || (Pin->bAdvancedView && Node->AdvancedPinDisplay != ENodeAdvancedPins::Shown)) continue;
        const FString Name = Pin->PinFriendlyName.IsEmpty() ? Pin->PinName.ToString() : Pin->PinFriendlyName.ToString();
        double Width = 32.0 + TextWidth(Name);
        int32 Rows = 1;
        if (Pin->Direction == EGPD_Input && Pin->LinkedTo.IsEmpty() && !Pin->bDefaultValueIsIgnored
            && Pin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec)
        {
            FString Value = Pin->DefaultTextValue.IsEmpty() ? Pin->DefaultValue : Pin->DefaultTextValue.ToString();
            if (Pin->DefaultObject) Value = Pin->DefaultObject->GetName();
            Width += 48.0 + FMath::Max(64.0, FMath::Min(1200.0, TextWidth(Value)));
            Rows = FMath::Min(8, LineCount(Value));
            if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_String
                || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Text)
            {
                // UE's multiline pin editors wrap at 400 px and cap their height at 200 px.
                Rows = FMath::Min(8, FMath::Max(Rows, FMath::CeilToInt(TextWidth(Value) / 360.0)));
            }
            if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Struct) Width = FMath::Max(Width, 320.0);
        }
        if (Pin->Direction == EGPD_Input) { InputWidth = FMath::Max(InputWidth, Width); InputRows += Rows; }
        else { OutputWidth = FMath::Max(OutputWidth, Width); OutputRows += Rows; }
    }
    double Width = FMath::Max(224.0, FMath::Max(TextWidth(Title) + 80.0, InputWidth + OutputWidth + 48.0));
    if (BubbleHeight(Node) > 0.0) Width = FMath::Max(Width, TextWidth(Node->NodeComment) + 40.0);
    const double Height = 48.0 + 20.0 * LineCount(Title)
        + 32.0 * FMath::Max(InputRows, OutputRows) + BubbleHeight(Node);
    return FVector2D(Snap(Width), Snap(FMath::Max(96.0, Height)));
}

bool FDSHBlueprintLayout::Arrange(UEdGraph* Graph, const TSet<UEdGraphNode*>& Seeds,
    FDSHBlueprintLayoutResult& Result, FString& Error)
{
    Result = {};
    Error.Reset();
    if (!Graph) { Error = TEXT("Cannot arrange a null blueprint graph"); return false; }
    if (!Graph->GetSchema() || !Graph->GetSchema()->IsA<UEdGraphSchema_K2>())
    { Error = TEXT("Automatic blueprint layout requires a K2 graph"); return false; }
    if (Seeds.IsEmpty()) return true;
    if (Graph->Nodes.Num() > MaxGraphNodes)
    { Error = TEXT("Automatic blueprint layout supports at most 16384 nodes per graph; split this graph into smaller functions"); return false; }

    TArray<FNode> Nodes;
    TArray<FComment> Comments;
    TMap<UEdGraphNode*, int32> Index;
    int32 PinCount = 0;
    for (int32 Order = 0; Order < Graph->Nodes.Num(); ++Order)
    {
        UEdGraphNode* Node = Graph->Nodes[Order];
        if (!IsValid(Node) || Node->GetGraph() != Graph) continue;
        PinCount += Node->Pins.Num();
        if (PinCount > MaxGraphPins)
        { Error = TEXT("Automatic blueprint layout supports at most 131072 pins per graph; split this graph into smaller functions"); return false; }
        if (auto* Comment = Cast<UEdGraphNode_Comment>(Node))
        {
            FComment Item; Item.Object = Comment; Item.Order = Order; Item.Original = Bounds(Comment);
            Comments.Add(MoveTemp(Item));
            if (Comments.Num() > MaxComments)
            { Error = TEXT("Automatic blueprint layout supports at most 512 comment boxes per graph; split this graph into smaller functions"); return false; }
        }
        else
        {
            FNode Item; Item.Object = Node; Item.Order = Order;
            for (const UEdGraphPin* Pin : Node->Pins) if (IsControlPin(Pin)) Item.Control = true;
            Index.Add(Node, Nodes.Add(MoveTemp(Item)));
        }
    }
    bool HasSeed = false;
    for (UEdGraphNode* Seed : Seeds) if (IsValid(Seed) && Seed->GetGraph() == Graph && Graph->Nodes.Contains(Seed)) HasSeed = true;
    if (!HasSeed) return true;
    for (int32 Current = 0; Current < Nodes.Num(); ++Current)
        for (UEdGraphPin* Pin : Nodes[Current].Object->Pins)
        {
            if (!Pin) continue;
            for (UEdGraphPin* Linked : Pin->LinkedTo)
            {
                if (!Linked) continue;
                const int32* Next = Index.Find(Linked->GetOwningNode());
                if (!Next || *Next == Current) continue;
                if (Pin->Direction == EGPD_Output)
                { Nodes[Current].Out.AddUnique(*Next); Nodes[*Next].In.AddUnique(Current); }
                if (IsControlPin(Pin) || IsControlPin(Linked))
                { Nodes[Current].ControlLinks.AddUnique(*Next); Nodes[*Next].ControlLinks.AddUnique(Current); }
            }
        }
    for (FComment& Comment : Comments)
        for (int32 Current = 0; Current < Nodes.Num(); ++Current)
        {
            const UEdGraphNode* Node = Nodes[Current].Object;
            // The title anchor records membership independently of the edited node's new size.
            // A longer default value or title must grow its existing comment, not eject the node.
            // Avoid GetNodesUnderComment(): its transient contents depend on an open Slate graph.
            const FVector2D Anchor(Node->NodePosX, Node->NodePosY);
            if (Anchor.X >= Comment.Original.Position.X && Anchor.Y >= Comment.Original.Position.Y
                && Anchor.X < Comment.Original.Position.X + Comment.Original.Size.X
                && Anchor.Y < Comment.Original.Position.Y + Comment.Original.Size.Y)
                Comment.Members.Add(Current);
        }

    TArray<bool> Selected; Selected.Init(false, Nodes.Num());
    const UBlueprint* Blueprint = Graph->GetTypedOuter<UBlueprint>();
    const bool WholeFunction = Blueprint && Blueprint->FunctionGraphs.Contains(Graph);
    if (WholeFunction) Selected.Init(true, Nodes.Num());
    else
    {
        // Pure-data components never bridge two unrelated execution islands implicitly.
        TArray<int32> PureComponent; PureComponent.Init(INDEX_NONE, Nodes.Num());
        TArray<TArray<int32>> PureMembers, PureControls;
        for (int32 Start = 0; Start < Nodes.Num(); ++Start)
        {
            if (Nodes[Start].Control || PureComponent[Start] != INDEX_NONE) continue;
            const int32 Id = PureMembers.AddDefaulted(); PureControls.AddDefaulted();
            PureMembers[Id].Add(Start); PureComponent[Start] = Id;
            for (int32 Cursor = 0; Cursor < PureMembers[Id].Num(); ++Cursor)
            {
                const int32 Current = PureMembers[Id][Cursor];
                auto Visit = [&](int32 Next)
                {
                    if (Nodes[Next].Control) PureControls[Id].AddUnique(Next);
                    else if (PureComponent[Next] == INDEX_NONE)
                    { PureComponent[Next] = Id; PureMembers[Id].Add(Next); }
                };
                for (int32 Next : Nodes[Current].Out) Visit(Next);
                for (int32 Next : Nodes[Current].In) Visit(Next);
            }
        }
        TArray<int32> Work;
        auto SelectSeed = [&](int32 Seed)
        {
            if (Nodes[Seed].Control) { if (!Selected[Seed]) { Selected[Seed] = true; Work.Add(Seed); } }
            else
            {
                const int32 Id = PureComponent[Seed];
                for (int32 Member : PureMembers[Id]) Selected[Member] = true;
                for (int32 Control : PureControls[Id])
                    if (!Selected[Control]) { Selected[Control] = true; Work.Add(Control); }
            }
        };
        for (UEdGraphNode* Seed : Seeds) if (const int32* SeedIndex = Index.Find(Seed)) SelectSeed(*SeedIndex);
        for (const FComment& Comment : Comments)
            if (Seeds.Contains(Comment.Object)) for (int32 Member : Comment.Members) SelectSeed(Member);
        for (int32 Cursor = 0; Cursor < Work.Num(); ++Cursor)
            for (int32 Next : Nodes[Work[Cursor]].ControlLinks)
                if (!Selected[Next]) { Selected[Next] = true; Work.Add(Next); }
        for (int32 Id = 0; Id < PureMembers.Num(); ++Id)
        {
            bool HasSelected = false, HasOther = false;
            for (int32 Control : PureControls[Id])
                if (Selected[Control]) HasSelected = true; else HasOther = true;
            if (HasSelected && !HasOther) for (int32 Member : PureMembers[Id]) Selected[Member] = true;
        }
    }

    int32 SelectedCount = 0;
    for (bool IsSelected : Selected) if (IsSelected) ++SelectedCount;
    if (SelectedCount > MaxSelectedNodes)
    { Error = TEXT("Automatic blueprint layout supports at most 4096 affected nodes per edit; split this logic into smaller functions"); return false; }

    for (FComment& Comment : Comments)
    {
        bool All = true, Any = false;
        for (int32 Member : Comment.Members) { All &= Selected[Member]; Any |= Selected[Member]; }
        Comment.Movable = All && (Any || WholeFunction || Seeds.Contains(Comment.Object));
    }
    // Preserve ambiguous overlapping annotations. Properly nested boxes become containers.
    TArray<bool> Ambiguous; Ambiguous.Init(false, Comments.Num());
    for (int32 A = 0; A < Comments.Num(); ++A)
        for (int32 B = A + 1; B < Comments.Num(); ++B)
            if (Comments[A].Original.Intersects(Comments[B].Original)
                && !Comments[A].Original.Contains(Comments[B].Original)
                && !Comments[B].Original.Contains(Comments[A].Original))
                Ambiguous[A] = Ambiguous[B] = true;
    for (int32 A = 0; A < Comments.Num(); ++A)
    {
        if (Ambiguous[A]) Comments[A].Movable = false;
        if (!Comments[A].Movable) continue;
        double ParentArea = TNumericLimits<double>::Max();
        for (int32 B = 0; B < Comments.Num(); ++B)
        {
            if (A == B || Ambiguous[B] || !Comments[B].Movable
                || !Comments[B].Original.Contains(Comments[A].Original)) continue;
            const double Area = Comments[B].Original.Size.X * Comments[B].Original.Size.Y;
            const double OwnArea = Comments[A].Original.Size.X * Comments[A].Original.Size.Y;
            if (Area < OwnArea || (Area == OwnArea && Comments[B].Order > Comments[A].Order)) continue;
            if (Area < ParentArea) { ParentArea = Area; Comments[A].Parent = B; }
        }
    }

    TArray<FItem> Items;
    FItem Root; Items.Add(MoveTemp(Root));
    TArray<int32> CommentItems; CommentItems.Init(INDEX_NONE, Comments.Num());
    for (int32 Current = 0; Current < Comments.Num(); ++Current)
        if (Comments[Current].Movable)
        {
            FItem Item; Item.Comment = Current; Item.Order = Comments[Current].Order;
            CommentItems[Current] = Items.Add(MoveTemp(Item));
        }
    for (int32 Current = 0; Current < Comments.Num(); ++Current)
        if (CommentItems[Current] != INDEX_NONE)
        {
            const int32 Parent = Comments[Current].Parent == INDEX_NONE ? 0 : CommentItems[Comments[Current].Parent];
            Items[Parent].Children.Add(CommentItems[Current]);
        }
    for (int32 Current = 0; Current < Nodes.Num(); ++Current)
    {
        if (!Selected[Current]) continue;
        int32 Parent = 0; double Area = TNumericLimits<double>::Max();
        for (int32 Comment = 0; Comment < Comments.Num(); ++Comment)
            if (CommentItems[Comment] != INDEX_NONE && Comments[Comment].Members.Contains(Current))
            {
                const double Candidate = Comments[Comment].Original.Size.X * Comments[Comment].Original.Size.Y;
                if (Candidate < Area || (Candidate == Area && CommentItems[Comment] > Parent))
                { Area = Candidate; Parent = CommentItems[Comment]; }
            }
        FItem Item; Item.Node = Current; Item.Order = Nodes[Current].Order;
        Item.Size = EstimateSize(Nodes[Current].Object); Item.Members.Add(Current);
        const int32 ItemIndex = Items.Add(MoveTemp(Item));
        Items[Parent].Children.Add(ItemIndex);
    }
    // Explicit postorder also handles deeply nested comments without recursive calls.
    TArray<int32> Visit { 0 };
    for (int32 Cursor = 0; Cursor < Visit.Num(); ++Cursor)
        for (int32 Child : Items[Visit[Cursor]].Children) Visit.Add(Child);
    for (int32 Cursor = Visit.Num() - 1; Cursor >= 0; --Cursor)
    {
        FItem& Item = Items[Visit[Cursor]];
        if (Item.Node != INDEX_NONE) continue;
        Item.Children.Sort([&](int32 A, int32 B) { return Items[A].Order < Items[B].Order; });
        for (int32 Child : Item.Children) Item.Members.Append(Items[Child].Members);
        Item.Size = PlaceItems(Items, Item.Children, Nodes);
        if (Item.Comment != INDEX_NONE)
        {
            const auto* Comment = Comments[Item.Comment].Object;
            const double Header = Snap(FMath::Max(48.0, 24.0 + static_cast<double>(Comment->FontSize) * LineCount(Comment->NodeComment) * 1.4));
            if (Item.Children.IsEmpty()) Item.Size = EstimateSize(Comment);
            else
            {
                for (int32 Child : Item.Children) Items[Child].Position += FVector2D(CommentMargin, Header + CommentMargin);
                Item.Size += FVector2D(2.0 * CommentMargin, Header + 2.0 * CommentMargin);
                Item.Size.X = FMath::Max(Item.Size.X, Snap(TextWidth(Comment->NodeComment)
                    * FMath::Max(1.0, static_cast<double>(Comment->FontSize) / 14.0) + 2.0 * CommentMargin));
            }
        }
    }
    if (Items[0].Children.IsEmpty()) return true;

    TArray<FRect> Obstacles;
    for (int32 Current = 0; Current < Nodes.Num(); ++Current)
        if (!Selected[Current]) Obstacles.Add(Bounds(Nodes[Current].Object));
    for (const FComment& Comment : Comments) if (!Comment.Movable) Obstacles.Add(Comment.Original);
    // The absolute origin depends only on fixed obstacles, never on previous selected positions.
    // This makes repeated layouts identical and keeps unrelated event blocks stationary.
    FRect Region { FVector2D::ZeroVector, Items[0].Size };
    for (int32 Attempt = 0; Attempt <= Obstacles.Num(); ++Attempt)
    {
        double NextY = Region.Position.Y;
        for (const FRect& Obstacle : Obstacles)
            if (Region.Intersects(Obstacle, VerticalGap)) NextY = FMath::Max(NextY, Snap(Obstacle.Position.Y + Obstacle.Size.Y + ComponentGap));
        if (NextY == Region.Position.Y) break;
        Region.Position.Y = NextY;
    }
    Items[0].Position = Region.Position;
    for (int32 Cursor = 0; Cursor < Visit.Num(); ++Cursor)
    {
        const FItem& Item = Items[Visit[Cursor]];
        for (int32 Child : Item.Children) Items[Child].Position += Item.Position;
    }
    for (const FItem& Item : Items)
        if (!FMath::IsFinite(Item.Position.X) || !FMath::IsFinite(Item.Position.Y)
            || !FMath::IsFinite(Item.Size.X) || !FMath::IsFinite(Item.Size.Y)
            || FMath::Abs(Item.Position.X) + Item.Size.X > CoordinateLimit
            || FMath::Abs(Item.Position.Y) + Item.Size.Y > CoordinateLimit)
        { Error = TEXT("Blueprint layout exceeds the safe editor coordinate range"); return false; }

    // Planning and validation are complete. Only this final pass mutates the graph.
    bool GraphModified = false;
    for (const FItem& Item : Items)
    {
        UEdGraphNode* Node = Item.Node != INDEX_NONE ? Nodes[Item.Node].Object
            : Item.Comment != INDEX_NONE ? Comments[Item.Comment].Object : nullptr;
        if (!Node) continue;
        const int32 X = FMath::RoundToInt(Item.Position.X);
        const int32 Y = FMath::RoundToInt(Item.Position.Y + BubbleHeight(Node));
        const bool Moved = Node->NodePosX != X || Node->NodePosY != Y;
        const bool Resized = Item.Comment != INDEX_NONE
            && (Node->NodeWidth != FMath::RoundToInt(Item.Size.X) || Node->NodeHeight != FMath::RoundToInt(Item.Size.Y));
        if (!Moved && !Resized) continue;
        if (!GraphModified) { Graph->Modify(); GraphModified = true; }
        Node->Modify();
        Node->NodePosX = X; Node->NodePosY = Y;
        if (Moved) ++Result.MovedNodes;
        if (Resized)
        {
            Node->NodeWidth = FMath::RoundToInt(Item.Size.X);
            Node->NodeHeight = FMath::RoundToInt(Item.Size.Y);
            ++Result.ResizedComments;
        }
    }
    return true;
}
