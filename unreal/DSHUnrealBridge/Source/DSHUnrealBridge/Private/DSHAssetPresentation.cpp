#include "DSHAssetPresentation.h"

#include "BlueprintEditor.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/LevelStreaming.h"
#include "Engine/World.h"
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
FString ExactLoadedObjectPath(const FString& Path)
{
    if (Path.IsEmpty()) return {};
    const FString Package = FPackageName::ObjectPathToPackageName(Path);
    if (!Package.StartsWith(TEXT("/")) || !FPackageName::IsValidLongPackageName(Package)) return {};
    // Only a package-only request gains an object name. A graph, node, or level
    // Blueprint path must retain every subobject segment exactly as supplied.
    return Path == Package ? Package + TEXT(".") + FPackageName::GetShortName(Package) : Path;
}

bool IsSupportedAsset(UObject* Asset)
{
    return IsValid(Asset) && !Asset->HasAnyFlags(RF_ClassDefaultObject | RF_ArchetypeObject)
        && (Asset->IsA<UBlueprint>() || Asset->IsA<UMaterialInterface>() || Asset->IsA<UMaterialFunctionInterface>());
}

UWorld* CurrentEditorWorld()
{
    return GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
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

UObject* FDSHAssetPresentation::ResolveSupportedTarget(const FString& ObjectPath)
{
    const FString Path = ExactLoadedObjectPath(ObjectPath);
    if (Path.IsEmpty()) return nullptr;
    UObject* Object = FindObject<UObject>(nullptr, *Path);
    if (!IsValid(Object)) return nullptr;
    // Never infer an editable target from a map, level, actor, or arbitrary
    // UObject. Only explicitly supported assets and their graph objects qualify.
    if (Object->IsA<UWorld>() || Object->IsA<ULevel>()) return nullptr;
    if (IsSupportedAsset(Object)) return Object;
    if (Object->IsA<UEdGraph>() || Object->IsA<UEdGraphNode>())
    {
        UBlueprint* Blueprint = Object->GetTypedOuter<UBlueprint>();
        return IsSupportedAsset(Blueprint) ? Blueprint : nullptr;
    }
    if (Object->IsA<UMaterialExpression>())
    {
        for (UObject* Outer = Object->GetOuter(); IsValid(Outer); Outer = Outer->GetOuter())
            if (IsSupportedAsset(Outer)) return Outer;
    }
    return nullptr;
}

bool FDSHAssetPresentation::CanPresentInWorld(UObject* Asset, const UWorld* EditorWorld)
{
    if (!IsSupportedAsset(Asset)) return false;
    const ULevelScriptBlueprint* LevelBlueprint = Cast<ULevelScriptBlueprint>(Asset);
    if (!LevelBlueprint) return true;
    ULevel* Level = LevelBlueprint->GetTypedOuter<ULevel>();
    if (!IsValid(EditorWorld) || !IsValid(Level) || Level->LevelScriptBlueprint != LevelBlueprint) return false;
    if (EditorWorld->ContainsLevel(Level)) return true;
    for (ULevelStreaming* Streaming : EditorWorld->GetStreamingLevels())
        if (IsValid(Streaming) && Streaming->GetLoadedLevel() == Level) return true;
    return false;
}

void FDSHAssetPresentation::Queue(const FDSHAssetViewHint& Hint)
{
    UObject* Asset = ResolveSupportedTarget(Hint.AssetPath);
    if (!CanPresentInWorld(Asset, CurrentEditorWorld())) return;
    for (FPending& Existing : Pending)
    {
        if (Existing.Asset.Get() != Asset || Existing.Hint.Graph != Hint.Graph) continue;
        Existing.Hint = Hint;
        Existing.Hint.AssetPath = Asset->GetPathName();
        return;
    }
    FPending& Item = Pending.AddDefaulted_GetRef();
    Item.Hint = Hint;
    Item.Hint.AssetPath = Asset->GetPathName();
    Item.Asset = Asset;
}

void FDSHAssetPresentation::Tick()
{
    // Remove work before calling editor APIs, which may broadcast callbacks
    // that enqueue more work or invalidate the object/current editor world.
    TArray<FPending> Work = MoveTemp(Pending);
    Pending.Reset();
    for (FPending& Item : Work)
    {
        if (--Item.FramesRemaining > 0) { Pending.Add(MoveTemp(Item)); continue; }
        if (!Item.bOpenAttempted)
        {
            Item.bOpenAttempted = true;
            if (Show(Item, false, true))
            {
                Item.FramesRemaining = 1;
                Pending.Add(MoveTemp(Item));
            }
            continue;
        }
        Show(Item, true, false); // The focus stage must never open an editor.
    }
}

bool FDSHAssetPresentation::Show(const FPending& Item, bool bFocusCanvas, bool bAllowOpen)
{
    if (!GEditor || IsRunningCommandlet() || !FSlateApplication::IsInitialized()) return false;
    UObject* Asset = Item.Asset.Get();
    if (!CanPresentInWorld(Asset, CurrentEditorWorld())) return false;
    UAssetEditorSubsystem* Editors = GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    if (!Editors) return false;
    IAssetEditorInstance* Instance = Editors->FindEditorForAsset(Asset, false);
    if (!Instance)
    {
        if (!bAllowOpen) return false;
        // This is the same API used by LevelEditorActions::OpenLevelBlueprint:
        // pass the actual ULevelScriptBlueprint, never its outer World asset.
        if (!Editors->OpenEditorForAsset(Asset)) return false;
        Asset = Item.Asset.Get();
        if (!CanPresentInWorld(Asset, CurrentEditorWorld())) return false;
        Instance = Editors->FindEditorForAsset(Asset, false);
    }
    if (!Instance) return false;
    Instance->FocusWindow(Asset);
    Asset = Item.Asset.Get();
    if (!CanPresentInWorld(Asset, CurrentEditorWorld())) return false;
    Instance = Editors->FindEditorForAsset(Asset, false);
    if (!Instance) return false;
    TSharedPtr<FTabManager> Tabs = Instance->GetAssociatedTabManager();
    TSharedPtr<SDockTab> Tab = Tabs.IsValid() ? Tabs->GetOwnerTab() : nullptr;
    if (Tab.IsValid()) Tab->ActivateInParent(ETabActivationCause::SetDirectly);
    TSharedPtr<SWindow> Window = Tab.IsValid() ? Tab->GetParentWindow() : nullptr;
    if (!Window.IsValid() && FSlateApplication::IsInitialized()) Window = FSlateApplication::Get().GetActiveTopLevelWindow();
    if (Window.IsValid() && !Window->IsWindowMaximized()) Window->Maximize();
    Asset = Item.Asset.Get();
    if (!CanPresentInWorld(Asset, CurrentEditorWorld())) return false;
    Instance = Editors->FindEditorForAsset(Asset, false);
    if (!Instance) return false;
    if (UBlueprint* Blueprint = Cast<UBlueprint>(Asset)) FocusBlueprint(Instance, Blueprint, Item.Hint, bFocusCanvas);
    else if (bFocusCanvas) FocusMaterial(Instance, Asset, Item.Hint);
    return true;
}

