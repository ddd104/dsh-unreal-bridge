#include "DSHAssetPresentation.h"

#include "BlueprintEditor.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "GraphEditor.h"
#include "IMaterialEditor.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "Materials/MaterialFunctionInterface.h"
#include "Misc/PackageName.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/SWindow.h"

namespace
{
FString NormalizeAssetPath(const FString& Path)
{
    const FString Package = FPackageName::ObjectPathToPackageName(Path);
    if (!Package.StartsWith(TEXT("/")) || !FPackageName::IsValidLongPackageName(Package)) return {};
    return Package + TEXT(".") + FPackageName::GetShortName(Package);
}

void CenterGraph(const TSharedPtr<SGraphEditor>& Editor, const FVector2D& Center)
{
    if (!Editor.IsValid()) return;
    FVector2f View;
    float Zoom = 1.0f;
    Editor->GetViewLocation(View, Zoom);
    if (Zoom <= 0.0f) Zoom = 1.0f;
    const FVector2f Size = Editor->GetCachedGeometry().GetLocalSize();
    Editor->SetViewLocation(FVector2f(Center) - Size / (2.0f * Zoom), Zoom);
}

UEdGraph* FindGraph(UBlueprint* Blueprint, const FString& Name)
{
    if (!Blueprint || Name.IsEmpty()) return nullptr;
    TArray<UEdGraph*> Graphs;
    Blueprint->GetAllGraphs(Graphs);
    for (UEdGraph* Graph : Graphs)
        if (Graph && (Graph->GetName() == Name || Graph->GraphGuid.ToString() == Name || Graph->GetPathName() == Name)) return Graph;
    return nullptr;
}

void FocusBlueprint(IAssetEditorInstance* Instance, UBlueprint* Blueprint, const FDSHAssetViewHint& Hint, bool bFocusCanvas)
{
    if (!Instance || !Blueprint) return;
    const FName EditorName = Instance->GetEditorName();
    if (EditorName != TEXT("BlueprintEditor") && EditorName != TEXT("AnimationBlueprintEditor")) return;
    UEdGraph* Graph = FindGraph(Blueprint, Hint.Graph);
    if (!Graph) return;
    FBlueprintEditor* Editor = static_cast<FBlueprintEditor*>(Instance);
    TSharedPtr<SGraphEditor> GraphEditor = Editor->OpenGraphAndBringToFront(Graph);
    if (!GraphEditor.IsValid() || !bFocusCanvas) return;
    TArray<UEdGraphNode*> Nodes;
    for (UEdGraphNode* Node : Graph->Nodes)
        if (Node && (Hint.NodeIds.Contains(Node->NodeGuid.ToString())
            || Hint.NodeIds.Contains(Node->GetPathName()) || Hint.NodeIds.Contains(Node->GetName()))) Nodes.Add(Node);
    if (Nodes.Num() == 1) GraphEditor->JumpToNode(Nodes[0]);
    else if (Nodes.Num() > 1)
    {
        GraphEditor->ClearSelectionSet();
        for (UEdGraphNode* Node : Nodes) GraphEditor->SetNodeSelection(Node, true);
        GraphEditor->ZoomToFit(true);
    }
    else if (Hint.Center.IsSet()) CenterGraph(GraphEditor, Hint.Center.GetValue());
}

void FocusMaterial(IAssetEditorInstance* Instance, UObject* Asset, const FDSHAssetViewHint& Hint)
{
    if (!Instance || Instance->GetEditorName() != TEXT("MaterialEditor")) return;
    IMaterialEditor* Editor = static_cast<IMaterialEditor*>(Instance);
    TArray<UMaterialExpression*> Expressions;
    if (UMaterial* Material = Cast<UMaterial>(Editor->GetMaterialInterface()))
        for (UMaterialExpression* Expression : Material->GetExpressions()) if (Expression) Expressions.AddUnique(Expression);
    if (UMaterial* Material = Cast<UMaterial>(Asset))
    {
        for (UMaterialExpression* MaterialNode : Material->GetExpressions()) if (MaterialNode) Expressions.AddUnique(MaterialNode);
    }
    else if (UMaterialFunctionInterface* Function = Cast<UMaterialFunctionInterface>(Asset))
    {
        for (UMaterialExpression* FunctionNode : Function->GetExpressions()) if (FunctionNode) Expressions.AddUnique(FunctionNode);
    }
    TArray<UMaterialExpression*> Matches;
    for (UMaterialExpression* Expression : Expressions)
    {
        if (!Hint.NodeIds.Contains(Expression->MaterialExpressionGuid.ToString())
            && !Hint.NodeIds.Contains(Expression->GetName())
            && !Hint.NodeIds.Contains(Expression->GetPathName())
            && (!Expression->GraphNode || !Hint.NodeIds.Contains(Expression->GraphNode->NodeGuid.ToString()))) continue;
        Matches.Add(Expression);
    }
    if (Matches.IsEmpty() && Hint.Center.IsSet())
    {
        UMaterialExpression* Closest = nullptr;
        double BestDistance = TNumericLimits<double>::Max();
        for (UMaterialExpression* Expression : Expressions)
        {
            const double Distance = FVector2D::DistSquared(FVector2D(Expression->MaterialExpressionEditorX, Expression->MaterialExpressionEditorY), Hint.Center.GetValue());
            if (!Closest || Distance < BestDistance) { Closest = Expression; BestDistance = Distance; }
        }
        if (Closest) Editor->JumpToExpression(Closest);
        return;
    }
    if (Matches.IsEmpty()) return;
    FVector2D Min(Matches[0]->MaterialExpressionEditorX, Matches[0]->MaterialExpressionEditorY), Max = Min;
    for (UMaterialExpression* Expression : Matches)
    {
        Min.X = FMath::Min(Min.X, static_cast<double>(Expression->MaterialExpressionEditorX));
        Min.Y = FMath::Min(Min.Y, static_cast<double>(Expression->MaterialExpressionEditorY));
        Max.X = FMath::Max(Max.X, static_cast<double>(Expression->MaterialExpressionEditorX));
        Max.Y = FMath::Max(Max.Y, static_cast<double>(Expression->MaterialExpressionEditorY));
    }
    const FVector2D Center = Hint.Center.IsSet() ? Hint.Center.GetValue() : (Min + Max) * 0.5;
    UMaterialExpression* Closest = nullptr;
    double BestDistance = TNumericLimits<double>::Max();
    for (UMaterialExpression* Expression : Matches)
    {
        const double Distance = FVector2D::DistSquared(FVector2D(Expression->MaterialExpressionEditorX, Expression->MaterialExpressionEditorY), Center);
        if (!Closest || Distance < BestDistance) { Closest = Expression; BestDistance = Distance; }
    }
    if (Closest) Editor->JumpToExpression(Closest);
}
}

void FDSHAssetPresentation::Queue(const FDSHAssetViewHint& Hint)
{
    if (NormalizeAssetPath(Hint.AssetPath).IsEmpty()) return;
    FPending& Item = Pending.AddDefaulted_GetRef();
    Item.Hint = Hint;
}

void FDSHAssetPresentation::Tick()
{
    for (int32 Index = 0; Index < Pending.Num();)
    {
        if (--Pending[Index].FramesRemaining > 0) { ++Index; continue; }
        if (!Pending[Index].bOpened)
        {
            Show(Pending[Index].Hint, false);
            Pending[Index].bOpened = true;
            Pending[Index].FramesRemaining = 1;
            ++Index;
            continue;
        }
        FDSHAssetViewHint Hint = MoveTemp(Pending[Index].Hint);
        Pending.RemoveAt(Index);
        Show(Hint, true);
    }
}

void FDSHAssetPresentation::Show(const FDSHAssetViewHint& Hint, bool bFocusCanvas)
{
    if (!GEditor || IsRunningCommandlet() || !FSlateApplication::IsInitialized()) return;
    const FString ObjectPath = NormalizeAssetPath(Hint.AssetPath);
    if (ObjectPath.IsEmpty()) return;
    UObject* Asset = LoadObject<UObject>(nullptr, *ObjectPath);
    if (!Asset) return; // Deleted assets cannot be opened.
    UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    if (!Editors) return;
    IAssetEditorInstance* Instance = Editors->FindEditorForAsset(Asset, true);
    if (!Instance)
    {
        if (!Editors->OpenEditorForAsset(Asset)) return;
        Instance = Editors->FindEditorForAsset(Asset, true);
    }
    if (!Instance) return;
    Instance->FocusWindow(Asset);
    TSharedPtr<FTabManager> Tabs = Instance->GetAssociatedTabManager();
    TSharedPtr<SDockTab> Tab = Tabs.IsValid() ? Tabs->GetOwnerTab() : nullptr;
    if (Tab.IsValid()) Tab->ActivateInParent(ETabActivationCause::SetDirectly);
    TSharedPtr<SWindow> Window = Tab.IsValid() ? Tab->GetParentWindow() : nullptr;
    if (!Window.IsValid() && FSlateApplication::IsInitialized()) Window = FSlateApplication::Get().GetActiveTopLevelWindow();
    if (Window.IsValid() && !Window->IsWindowMaximized()) Window->Maximize();
    if (UBlueprint* Blueprint = Cast<UBlueprint>(Asset)) FocusBlueprint(Instance, Blueprint, Hint, bFocusCanvas);
    else if (bFocusCanvas) FocusMaterial(Instance, Asset, Hint);
}

