#include "DSHAssetPresentation.h"

#include "BlueprintEditor.h"
#include "Containers/Ticker.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Editor.h"
#include "Editor/TransBuffer.h"
#include "Engine/Blueprint.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/LevelStreaming.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Commands/UICommandList.h"
#include "Framework/Docking/TabManager.h"
#include "Framework/Notifications/NotificationManager.h"
#include "GraphEditor.h"
#include "IMaterialEditor.h"
#include "MaterialEditorActions.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "Materials/MaterialExpressionComment.h"
#include "Materials/MaterialFunctionInterface.h"
#include "Misc/PackageName.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/Notifications/SNotificationList.h"
#include "Widgets/SWindow.h"

namespace
{
namespace DSHMaterialPresentationPrivate
{
struct FUndoOperation
{
    FGuid OperationId;
    TWeakObjectPtr<UEditorEngine> Editor;
    bool bPreviousSuspend = false;
};

struct FMaterialUndoSync
{
    TWeakObjectPtr<UTransBuffer> Transactor;
    FDelegateHandle StateHandle;
    FTSTicker::FDelegateHandle TickHandle;
    TArray<FUndoOperation> Operations;
    TArray<TWeakObjectPtr<UObject>> PendingAssets;
    bool bNotifyViews = false;

    void StateChanged(const FTransactionContext& Context, ETransactionStateEventType State)
    {
        if (Context.Context != FDSHAssetPresentation::MaterialTransactionContext()) return;
        if (State == ETransactionStateEventType::UndoRedoStarted && GEditor)
        {
            // MaterialEditor::MatchesContext accepts every material transaction,
            // and PostUndo copies its preview back to its original. This native
            // transaction owns only original-asset state, so letting those undo
            // clients run would undo the Undo and Apply unrelated pending edits.
            FUndoOperation& Operation = Operations.AddDefaulted_GetRef();
            Operation.OperationId = Context.OperationId;
            Operation.Editor = GEditor;
            Operation.bPreviousSuspend = GEditor->bSuspendBroadcastPostUndoRedo;
            GEditor->bSuspendBroadcastPostUndoRedo = true;
        }
        else if (State == ETransactionStateEventType::UndoRedoFinalized && !Operations.IsEmpty()
            && Operations.Last().OperationId == Context.OperationId)
        {
            const FUndoOperation Operation = Operations.Pop();
            if (UEditorEngine* Editor = Operation.Editor.Get())
                Editor->bSuspendBroadcastPostUndoRedo = Operation.bPreviousSuspend;
            // Preserve the normal undo pin cleanup before any graph rebuild,
            // but do not override an existing owner's suppression policy.
            if (!Operation.bPreviousSuspend) UEdGraphPin::SanitizePinsPostUndoRedo();
            if (IsValid(Context.PrimaryObject)) PendingAssets.AddUnique(Context.PrimaryObject);
            bNotifyViews |= !Operation.bPreviousSuspend;
            // UTransBuffer emits Finalized before clearing GIsTransacting;
            // RefreshGraphFromOriginal deliberately refuses to run until later.
            if (!TickHandle.IsValid())
                TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([this](float)
                {
                    FDSHAssetPresentation::FlushPendingMaterialEditorSync();
                    if (!PendingAssets.IsEmpty() || bNotifyViews) return true;
                    TickHandle.Reset();
                    return false;
                }));
        }
    }

    void Shutdown()
    {
        if (UTransBuffer* Buffer = Transactor.Get()) Buffer->OnTransactionStateChanged().Remove(StateHandle);
        StateHandle.Reset(); Transactor.Reset();
        FTSTicker::GetCoreTicker().RemoveTicker(TickHandle); TickHandle.Reset();
        while (!Operations.IsEmpty())
        {
            const FUndoOperation Operation = Operations.Pop();
            if (UEditorEngine* Editor = Operation.Editor.Get())
                Editor->bSuspendBroadcastPostUndoRedo = Operation.bPreviousSuspend;
        }
        PendingAssets.Reset(); bNotifyViews = false;
    }
};

FMaterialUndoSync MaterialUndoSync;

bool CanRefresh(IMaterialEditor* Editor, UObject* Asset, FString& Reason)
{
    // OnApplyEnabled in the supported Material Editor returns bMaterialDirty.
    // Package dirtiness instead means an applied asset has not yet been saved;
    // comparing preview/original properties also includes editor-only changes.
    // Query the bound predicate directly, without executing Apply or trusting
    // a disabled command list (e.g. while another UI action is active).
    const FUIAction* Apply = FMaterialEditorCommands::IsRegistered()
        ? Editor->GetToolkitCommands()->GetActionForCommand(FMaterialEditorCommands::Get().Apply) : nullptr;
    if (!Apply || !Apply->CanExecuteAction.IsBound())
    {
        Reason = FString::Printf(TEXT("Cannot verify pending Material Editor changes for %s; no editor copy will be replaced"), *Asset->GetPathName());
        return false;
    }
    if (Apply->CanExecuteAction.Execute())
    {
        Reason = FString::Printf(TEXT("%s has unapplied Material Editor changes. Apply or explicitly discard those changes in the editor, then read the material again before retrying; the bridge will not discard them"), *Asset->GetPathName());
        return false;
    }
    return true;
}
}

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
    {
        for (UMaterialExpression* Expression : Material->GetExpressions())
            if (Expression && Expression->GraphNode) Expressions.AddUnique(Expression);
        for (UMaterialExpressionComment* Comment : Material->GetExpressionCollection().EditorComments)
            if (Comment && Comment->GraphNode) Expressions.AddUnique(Comment);
    }
    // Native node IDs use hyphenated GUIDs; other callers can supply compact
    // GUIDs or original expression paths. Resolve identities, never navigate
    // with an original-asset node pointer: it is not in the editor's graph.
    TSet<FGuid> Ids;
    for (const FString& Id : Hint.NodeIds)
    {
        FGuid Guid;
        if (FGuid::Parse(Id, Guid)) Ids.Add(Guid);
    }
    auto ResolveOriginalId = [&](UMaterialExpression* Expression)
    {
        if (Expression && (Hint.NodeIds.Contains(Expression->GetName()) || Hint.NodeIds.Contains(Expression->GetPathName())))
            Ids.Add(Expression->MaterialExpressionGuid);
    };
    if (UMaterial* Material = Cast<UMaterial>(Asset))
    {
        for (UMaterialExpression* Expression : Material->GetExpressions()) ResolveOriginalId(Expression);
        for (UMaterialExpressionComment* Comment : Material->GetExpressionCollection().EditorComments) ResolveOriginalId(Comment);
    }
    else if (UMaterialFunctionInterface* Function = Cast<UMaterialFunctionInterface>(Asset))
    {
        for (UMaterialExpression* Expression : Function->GetExpressions()) ResolveOriginalId(Expression);
    }
    TArray<UMaterialExpression*> Matches;
    for (UMaterialExpression* Expression : Expressions)
    {
        if (!Ids.Contains(Expression->MaterialExpressionGuid)
            && !Hint.NodeIds.Contains(Expression->GetName())
            && !Hint.NodeIds.Contains(Expression->GetPathName())
            && !Ids.Contains(Expression->GraphNode->NodeGuid)) continue;
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
    for (UMaterialExpression* Expression : Matches) Editor->AddToSelection(Expression);
}
}

bool FDSHAssetPresentation::PrepareMaterialTransaction(FString& Reason)
{
    using namespace DSHMaterialPresentationPrivate;
    Reason.Reset();
    UTransBuffer* Buffer = GEditor ? Cast<UTransBuffer>(GEditor->Trans) : nullptr;
    if (!Buffer)
    {
        Reason = TEXT("A native material edit requires the editor transaction buffer for safe Undo/Redo");
        return false;
    }
    if (MaterialUndoSync.Transactor.Get() != Buffer)
    {
        MaterialUndoSync.Shutdown();
        MaterialUndoSync.Transactor = Buffer;
        MaterialUndoSync.StateHandle = Buffer->OnTransactionStateChanged().AddRaw(&MaterialUndoSync, &FMaterialUndoSync::StateChanged);
    }
    FlushPendingMaterialEditorSync();
    return true;
}

void FDSHAssetPresentation::FlushPendingMaterialEditorSync()
{
    using namespace DSHMaterialPresentationPrivate;
    if (GIsTransacting || !GEditor || GEditor->IsTransactionActive() || !MaterialUndoSync.Operations.IsEmpty()) return;
    TArray<TWeakObjectPtr<UObject>> Assets = MoveTemp(MaterialUndoSync.PendingAssets);
    MaterialUndoSync.PendingAssets.Reset();
    const bool bNotifyViews = MaterialUndoSync.bNotifyViews;
    MaterialUndoSync.bNotifyViews = false;
    for (const TWeakObjectPtr<UObject>& Weak : Assets)
    {
        UObject* Asset = Weak.Get();
        if (!Asset) continue;
        FString Reason;
        if (RefreshOpenMaterialEditors(Asset, Reason)) continue;
        const FString Message = TEXT("DSH material Undo/Redo restored the asset, but its editor view was not synchronized: ") + Reason;
        UE_LOG(LogTemp, Warning, TEXT("%s"), *Message);
        if (FSlateApplication::IsInitialized())
        {
            FNotificationInfo Notification(FText::FromString(Message));
            Notification.ExpireDuration = 8.0f;
            FSlateNotificationManager::Get().AddNotification(Notification);
        }
    }
    if (bNotifyViews && !GEditor->bSuspendBroadcastPostUndoRedo)
    {
        // These non-client notifications normally follow the suppressed client
        // loop. Do not replay BroadcastPostUndoRedo (which would Apply copies).
        GEditor->RedrawAllViewports(true);
        FEditorDelegates::PostUndoRedo.Broadcast();
    }
}

void FDSHAssetPresentation::ShutdownMaterialTransactions()
{
    DSHMaterialPresentationPrivate::MaterialUndoSync.Shutdown();
}

bool FDSHAssetPresentation::CanEditMaterialAsset(UObject* Asset, FString& Reason)
{
    Reason.Reset();
    UAssetEditorSubsystem* Editors = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
    if (!Editors) return true; // Headless operation has no editable preview copy.
    for (IAssetEditorInstance* Instance : Editors->FindEditorsForAsset(Asset))
        if (Instance && Instance->GetEditorName() == TEXT("MaterialEditor")
            && !DSHMaterialPresentationPrivate::CanRefresh(static_cast<IMaterialEditor*>(Instance), Asset, Reason)) return false;
    return true;
}

bool FDSHAssetPresentation::RefreshOpenMaterialEditors(UObject* Asset, FString& Reason)
{
    Reason.Reset();
    if (GIsTransacting || (GEditor && GEditor->IsTransactionActive()))
    {
        Reason = TEXT("The native edit committed, but its Material Editor refresh was skipped during an active transaction");
        return false;
    }
    if (!CanEditMaterialAsset(Asset, Reason)) return false;
    UAssetEditorSubsystem* Editors = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
    if (!Editors) return true;
    for (IAssetEditorInstance* Instance : Editors->FindEditorsForAsset(Asset))
    {
        if (!Instance || Instance->GetEditorName() != TEXT("MaterialEditor")) continue;
        IMaterialEditor* Editor = static_cast<IMaterialEditor*>(Instance);
        // Refresh can dispatch UI callbacks. Recheck each copy immediately
        // before replacing it, even though all were checked before mutation.
        if (!DSHMaterialPresentationPrivate::CanRefresh(Editor, Asset, Reason)) return false;
        Editor->RefreshGraphFromOriginal();
    }
    return true;
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

