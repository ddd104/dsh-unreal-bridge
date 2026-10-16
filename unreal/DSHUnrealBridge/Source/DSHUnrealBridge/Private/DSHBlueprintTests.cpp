#if WITH_DEV_AUTOMATION_TESTS
#include "DSHBlueprintOps.h"
#include "DSHAssetPresentation.h"
#include "DSHMcpEditAdapter.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "BlueprintEditor.h"
#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "Misc/AutomationTest.h"
#include "Misc/PackageName.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Engine/Blueprint.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "UObject/UObjectGlobals.h"
#include "Widgets/Docking/SDockTab.h"
#include "Widgets/SWindow.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintRoundTrip,"DSH.Bridge.BlueprintRoundTrip",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintRoundTrip::RunTest(const FString&)
{
    FDSHBlueprintOps Ops;FString Code,Error;auto Params=MakeShared<FJsonObject>();
    const FString Path=TEXT("/Game/DSHBridgeTests/BP_")+FGuid::NewGuid().ToString(EGuidFormats::Digits);
    Params->SetStringField(TEXT("assetPath"),Path);Params->SetStringField(TEXT("parent"),TEXT("Actor"));
    auto Created=Ops.Execute(TEXT("create_blueprint"),Params,Code,Error);
    if(!TestTrue(TEXT("Create blueprint: ")+Error,Created.IsValid()))return false;
    auto ReadParams=MakeShared<FJsonObject>();ReadParams->SetStringField(TEXT("assetPath"),Path);ReadParams->SetStringField(TEXT("detail"),TEXT("full"));
    auto Before=Ops.Execute(TEXT("read_blueprint"),ReadParams,Code,Error);
    if(!TestTrue(TEXT("Read created blueprint"),Before.IsValid()))return false;
    const FString Revision=Before->GetStringField(TEXT("revision"));
    TestEqual(TEXT("Repeated read has a stable revision"),Ops.Execute(TEXT("read_blueprint"),ReadParams,Code,Error)->GetStringField(TEXT("revision")),Revision);
    auto Patch=MakeShared<FJsonObject>();Patch->SetStringField(TEXT("assetPath"),Path);Patch->SetStringField(TEXT("graph"),TEXT("EventGraph"));Patch->SetStringField(TEXT("baseRevision"),Revision);
    auto Add=MakeShared<FJsonObject>();Add->SetStringField(TEXT("op"),TEXT("add_node"));Add->SetStringField(TEXT("nodeId"),TEXT("print1"));Add->SetStringField(TEXT("kind"),TEXT("call_function"));Add->SetStringField(TEXT("functionPath"),TEXT("/Script/Engine.KismetSystemLibrary:PrintString"));
    auto Default=MakeShared<FJsonObject>();Default->SetStringField(TEXT("op"),TEXT("set_pin_default"));Default->SetStringField(TEXT("nodeId"),TEXT("print1"));Default->SetStringField(TEXT("pin"),TEXT("InString"));Default->SetStringField(TEXT("value"),TEXT("Hello DSH"));
    FString BeginPlayId;
    for(const auto& G:Before->GetArrayField(TEXT("graphs")))for(const auto& N:G->AsObject()->GetArrayField(TEXT("nodes")))
    {FString Function;if(N->AsObject()->TryGetStringField(TEXT("functionPath"),Function)&&Function==TEXT("/Script/Engine.Actor:ReceiveBeginPlay"))
        {BeginPlayId=N->AsObject()->GetStringField(TEXT("id"));TestTrue(TEXT("Unconnected default event is reported as a ghost"),N->AsObject()->GetBoolField(TEXT("isAutomaticallyPlacedGhostNode")));}}
    if(!TestFalse(TEXT("Existing BeginPlay node is present"),BeginPlayId.IsEmpty()))return false;
    auto From=MakeShared<FJsonObject>();From->SetStringField(TEXT("node"),BeginPlayId);From->SetStringField(TEXT("pin"),TEXT("then"));
    auto To=MakeShared<FJsonObject>();To->SetStringField(TEXT("node"),TEXT("print1"));To->SetStringField(TEXT("pin"),TEXT("execute"));
    auto Connect=MakeShared<FJsonObject>();Connect->SetStringField(TEXT("op"),TEXT("connect"));Connect->SetObjectField(TEXT("from"),From);Connect->SetObjectField(TEXT("to"),To);
    Patch->SetArrayField(TEXT("operations"),{MakeShared<FJsonValueObject>(Add),MakeShared<FJsonValueObject>(Default),MakeShared<FJsonValueObject>(Connect)});
    auto Preview=Ops.Execute(TEXT("preview_patch"),Patch,Code,Error);
    if(!TestTrue(TEXT("Preview and compile transient copy: ")+Error,Preview.IsValid()))return false;
    TestEqual(TEXT("Preview leaves original unchanged"),Ops.Execute(TEXT("read_blueprint"),ReadParams,Code,Error)->GetStringField(TEXT("revision")),Revision);
    auto GraphRef=MakeShared<FJsonObject>();GraphRef->SetStringField(TEXT("refPath"),Created->GetStringField(TEXT("assetPath"))+TEXT(":EventGraph"));
    auto DslArgs=MakeShared<FJsonObject>();DslArgs->SetObjectField(TEXT("graph"),GraphRef);
    auto NullResult=MakeShared<FJsonObject>();NullResult->SetField(TEXT("returnValue"),MakeShared<FJsonValueNull>());
    auto McpHints=FDSHMcpEditAdapter::FromCall(TEXT("write_graph_dsl"),DslArgs,NullResult);
    if(!TestEqual(TEXT("Wrapped DSL graph reference identifies its asset"),McpHints.Num(),1))return false;
    const auto GraphSnapshot=FDSHMcpEditAdapter::CaptureGraphs(McpHints);
    if(!TestEqual(TEXT("Capture only the requested graph"),GraphSnapshot.Num(),1))return false;
    auto NoChangeHints=McpHints;FDSHMcpEditAdapter::IncludeGraphChanges(NoChangeHints,GraphSnapshot);
    TestTrue(TEXT("An unchanged graph has no changed-node hints"),NoChangeHints[0].NodeIds.IsEmpty());
    FDSHAssetViewHint ViewHint;
    auto Applied=Ops.Execute(TEXT("apply_patch"),Patch,Code,Error,&ViewHint);
    if(!TestTrue(TEXT("Apply and compile blueprint: ")+Error,Applied.IsValid()))return false;
    TestEqual(TEXT("Committed edit identifies the actual asset"),ViewHint.AssetPath,Created->GetStringField(TEXT("assetPath")));
    TestFalse(TEXT("Committed edit identifies a graph"),ViewHint.Graph.IsEmpty());
    TestTrue(TEXT("Committed edit identifies generated nodes"),ViewHint.NodeIds.Num()>0);
    TestNotEqual(TEXT("Edit changes revision"),Applied->GetStringField(TEXT("revision")),Revision);
    TestFalse(TEXT("Edit does not save automatically"),Applied->GetBoolField(TEXT("saved")));
    FDSHMcpEditAdapter::IncludeGraphChanges(McpHints,GraphSnapshot);
    TestTrue(TEXT("Null-result MCP write identifies the changed existing event"),McpHints[0].NodeIds.Contains(BeginPlayId));
    TestEqual(TEXT("Focus includes only the connected event and new print node"),McpHints[0].NodeIds.Num(),2);
    auto After=Ops.Execute(TEXT("read_blueprint"),ReadParams,Code,Error);
    for(const auto& G:After->GetArrayField(TEXT("graphs")))for(const auto& N:G->AsObject()->GetArrayField(TEXT("nodes")))
        if(N->AsObject()->GetStringField(TEXT("id"))==BeginPlayId)
        {
            TestFalse(TEXT("Connecting BeginPlay activates the ghost event"),N->AsObject()->GetBoolField(TEXT("isAutomaticallyPlacedGhostNode")));
            TestEqual(TEXT("Connected BeginPlay is enabled"),N->AsObject()->GetStringField(TEXT("enabledState")),FString(TEXT("Enabled")));
        }
    UBlueprint* Actual=LoadObject<UBlueprint>(nullptr,*Created->GetStringField(TEXT("assetPath")));
    TArray<UEdGraph*> ActualGraphs;Actual->GetAllGraphs(ActualGraphs);UEdGraphNode* CommentNode=ActualGraphs[0]->Nodes[0];const FString OriginalComment=CommentNode->NodeComment;
    CommentNode->NodeComment=TEXT("\u4F60\u597D");const FString FirstUnicodeRevision=FDSHBlueprintOps::Revision(Actual);
    CommentNode->NodeComment=TEXT("\u518D\u89C1");TestNotEqual(TEXT("Different Chinese content has different revisions"),FDSHBlueprintOps::Revision(Actual),FirstUnicodeRevision);CommentNode->NodeComment=OriginalComment;
    TestFalse(TEXT("Reject stale revision"),Ops.Execute(TEXT("apply_patch"),Patch,Code,Error).IsValid());TestEqual(TEXT("Stale error is CONFLICT"),Code,FString(TEXT("CONFLICT")));
    auto Undo=MakeShared<FJsonObject>();Undo->SetStringField(TEXT("assetPath"),Path);Undo->SetStringField(TEXT("baseRevision"),Applied->GetStringField(TEXT("revision")));
    auto Undone=Ops.Execute(TEXT("undo"),Undo,Code,Error);
    if(TestTrue(TEXT("Undo owned transaction: ")+Error,Undone.IsValid()))TestEqual(TEXT("Undo restores original revision"),Undone->GetStringField(TEXT("revision")),Revision);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintReject,"DSH.Bridge.RejectUnsafeInputs",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintReject::RunTest(const FString&)
{
    FDSHBlueprintOps Ops;FString Code,Error;auto P=MakeShared<FJsonObject>();P->SetStringField(TEXT("assetPath"),TEXT("/Engine/Forbidden"));P->SetStringField(TEXT("parent"),TEXT("Actor"));
    TestFalse(TEXT("Reject writes outside /Game"),Ops.Execute(TEXT("create_blueprint"),P,Code,Error).IsValid());
    P->SetStringField(TEXT("assetPath"),TEXT("/Game/../Engine/Forbidden"));TestFalse(TEXT("Reject traversal"),Ops.Execute(TEXT("create_blueprint"),P,Code,Error).IsValid());
    const auto Catalog=Ops.Execute(TEXT("catalog"),MakeShared<FJsonObject>(),Code,Error);TestTrue(TEXT("Catalog available"),Catalog.IsValid());
    if(Catalog)TestTrue(TEXT("Catalog contains callable functions"),Catalog->GetArrayField(TEXT("functions")).Num()>0);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMcpPresentationHints,"DSH.Bridge.McpPresentationHints",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHMcpPresentationHints::RunTest(const FString&)
{
    auto ToolArguments=MakeShared<FJsonObject>();
    ToolArguments->SetStringField(TEXT("asset_path"),TEXT("/Game/Materials/M_Test"));
    ToolArguments->SetStringField(TEXT("expression_guid"),TEXT("DEADBEEF"));
    auto Call=MakeShared<FJsonObject>();
    Call->SetStringField(TEXT("tool_name"),TEXT("set_expression_property"));
    Call->SetObjectField(TEXT("arguments"),ToolArguments);
    auto Result=MakeShared<FJsonObject>();
    auto Hints=FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result);
    if(!TestEqual(TEXT("One edited asset"),Hints.Num(),1))return false;
    TestEqual(TEXT("Package path becomes an object path"),Hints[0].AssetPath,FString(TEXT("/Game/Materials/M_Test.M_Test")));
    TestTrue(TEXT("Expression is available for material focus"),Hints[0].NodeIds.Contains(TEXT("DEADBEEF")));
    Result->SetBoolField(TEXT("isError"),true);
    TestTrue(TEXT("Failed MCP calls do not open assets"),FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result).IsEmpty());
    Call->SetStringField(TEXT("tool_name"),TEXT("get_expression_property"));
    Result->SetBoolField(TEXT("isError"),false);
    TestTrue(TEXT("Read-only MCP calls do not open assets"),FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result).IsEmpty());
    auto Graph=MakeShared<FJsonObject>();
    Graph->SetStringField(TEXT("graph"),TEXT("/Game/Blueprints/BP_Test.BP_Test:EventGraph"));
    auto Position=MakeShared<FJsonObject>();Position->SetNumberField(TEXT("x"),420);Position->SetNumberField(TEXT("y"),120);
    Graph->SetObjectField(TEXT("pos"),Position);
    Call->SetStringField(TEXT("tool_name"),TEXT("create_node"));Call->SetObjectField(TEXT("arguments"),Graph);
    Hints=FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result);
    if(!TestEqual(TEXT("Graph reference identifies its Blueprint"),Hints.Num(),1))return false;
    TestEqual(TEXT("Graph reference resolves to Blueprint asset"),Hints[0].AssetPath,FString(TEXT("/Game/Blueprints/BP_Test.BP_Test")));
    TestEqual(TEXT("Graph reference is preserved for navigation"),Hints[0].Graph,FString(TEXT("/Game/Blueprints/BP_Test.BP_Test:EventGraph")));
    TestTrue(TEXT("Node position is available for centering"),Hints[0].Center.IsSet());
    auto WrappedGraph=MakeShared<FJsonObject>();WrappedGraph->SetStringField(TEXT("refPath"),TEXT("/Game/Blueprints/BP_Test.BP_Test:EventGraph"));
    Graph->SetObjectField(TEXT("graph"),WrappedGraph);
    Call->SetStringField(TEXT("tool_name"),TEXT("write_graph_dsl"));
    Hints=FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result);
    if(!TestEqual(TEXT("UE UObject graph wrapper identifies the asset"),Hints.Num(),1))return false;
    TestEqual(TEXT("Wrapped graph retains its graph path"),Hints[0].Graph,FString(TEXT("/Game/Blueprints/BP_Test.BP_Test:EventGraph")));
    auto WrappedNode=MakeShared<FJsonObject>();WrappedNode->SetStringField(TEXT("refPath"),TEXT("/Game/Blueprints/BP_Test.BP_Test:EventGraph.K2Node_CallFunction_0"));
    auto NodeArgs=MakeShared<FJsonObject>();NodeArgs->SetObjectField(TEXT("node"),WrappedNode);
    Call->SetStringField(TEXT("tool_name"),TEXT("set_node_property"));Call->SetObjectField(TEXT("arguments"),NodeArgs);
    Hints=FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result);
    if(!TestEqual(TEXT("Wrapped node reference identifies its Blueprint"),Hints.Num(),1))return false;
    TestEqual(TEXT("Wrapped node identifies its graph"),Hints[0].Graph,FString(TEXT("/Game/Blueprints/BP_Test.BP_Test:EventGraph")));
    TestTrue(TEXT("Wrapped node identifies the focus target"),Hints[0].NodeIds.Contains(TEXT("K2Node_CallFunction_0")));
    Result->SetBoolField(TEXT("isError"),true);
    TestTrue(TEXT("Failed wrapped calls do not produce focus hints"),FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result).IsEmpty());
    Result->SetBoolField(TEXT("isError"),false);
    auto Material=MakeShared<FJsonObject>();
    auto WrappedMaterial=MakeShared<FJsonObject>();WrappedMaterial->SetStringField(TEXT("refPath"),TEXT("/Game/Materials/M_Test.M_Test"));
    Material->SetObjectField(TEXT("material_or_function"),WrappedMaterial);
    Material->SetNumberField(TEXT("x"),350);Material->SetNumberField(TEXT("y"),200);
    Call->SetStringField(TEXT("tool_name"),TEXT("add_expression"));Call->SetObjectField(TEXT("arguments"),Material);
    Hints=FDSHMcpEditAdapter::FromCall(TEXT("call_tool"),Call,Result);
    if(!TestEqual(TEXT("Material tool identifies edited material"),Hints.Num(),1))return false;
    TestTrue(TEXT("Material coordinates are available for centering"),Hints[0].Center.IsSet());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHAssetPresentationWindow,"DSH.Bridge.PresentationWindow",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHAssetPresentationWindow::RunTest(const FString&)
{
    if(IsRunningCommandlet()||!FSlateApplication::IsInitialized())return true;
    FDSHBlueprintOps Ops;FString Code,Error;
    const FString Path=TEXT("/Game/DSHBridgeTests/BP_View_")+FGuid::NewGuid().ToString(EGuidFormats::Digits);
    auto Params=MakeShared<FJsonObject>();Params->SetStringField(TEXT("assetPath"),Path);Params->SetStringField(TEXT("parent"),TEXT("Actor"));
    auto Created=Ops.Execute(TEXT("create_blueprint"),Params,Code,Error);
    if(!TestTrue(TEXT("Create presentation fixture: ")+Error,Created.IsValid()))return false;
    UBlueprint* Blueprint=LoadObject<UBlueprint>(nullptr,*Created->GetStringField(TEXT("assetPath")));
    if(!TestNotNull(TEXT("Created Blueprint is loaded"),Blueprint))return false;
    TArray<UEdGraph*> Graphs;Blueprint->GetAllGraphs(Graphs);
    UEdGraph* TargetGraph=nullptr;
    for(UEdGraph* Graph:Graphs)if(Graph&&Graph->GetName()==TEXT("EventGraph"))TargetGraph=Graph;
    if(!TestTrue(TEXT("Blueprint has an event graph with nodes"),TargetGraph&&TargetGraph->Nodes.Num()>=2))return false;
    FDSHAssetViewHint Hint;Hint.AssetPath=Blueprint->GetPathName();Hint.Graph=TargetGraph->GetPathName();
    Hint.NodeIds.Add(TargetGraph->Nodes[0]->NodeGuid.ToString());
    Hint.NodeIds.Add(TargetGraph->Nodes[1]->NodeGuid.ToString());
    FDSHAssetPresentation Presentation;Presentation.Queue(Hint);Presentation.Tick();Presentation.Tick();
    UAssetEditorSubsystem* Editors=GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    IAssetEditorInstance* Instance=Editors?Editors->FindEditorForAsset(Blueprint,false):nullptr;
    if(!TestNotNull(TEXT("Asset editor opened"),Instance))return false;
    TSharedPtr<FTabManager> Tabs=Instance->GetAssociatedTabManager();
    TSharedPtr<SDockTab> Tab=Tabs.IsValid()?Tabs->GetOwnerTab():nullptr;
    TSharedPtr<SWindow> Window=Tab.IsValid()?Tab->GetParentWindow():FSlateApplication::Get().GetActiveTopLevelWindow();
    if(!TestTrue(TEXT("Asset editor has a window"),Window.IsValid()))return false;
    TestTrue(TEXT("Asset editor window is maximized"),Window->IsWindowMaximized());
    if(Instance->GetEditorName()==TEXT("BlueprintEditor"))
    {
        FBlueprintEditor* BlueprintEditor=static_cast<FBlueprintEditor*>(Instance);
        TestEqual(TEXT("Blueprint canvas shows the modified graph"),BlueprintEditor->GetFocusedGraph(),TargetGraph);
        const auto Selection=BlueprintEditor->GetSelectedNodes();
        TestEqual(TEXT("Only the two changed nodes are selected for focus"),Selection.Num(),2);
        TestTrue(TEXT("First changed node is focused"),Selection.Contains(TargetGraph->Nodes[0]));
        TestTrue(TEXT("Second changed node is focused"),Selection.Contains(TargetGraph->Nodes[1]));
    }
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHMaterialPresentationWindow,"DSH.Bridge.MaterialPresentationWindow",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHMaterialPresentationWindow::RunTest(const FString&)
{
    if(IsRunningCommandlet()||!FSlateApplication::IsInitialized())return true;
    const FString PackageName=TEXT("/Game/DSHBridgeTests/M_View_")+FGuid::NewGuid().ToString(EGuidFormats::Digits);
    UPackage* Package=CreatePackage(*PackageName);
    UMaterial* Material=NewObject<UMaterial>(Package,FName(*FPackageName::GetShortName(PackageName)),RF_Public|RF_Standalone);
    if(!TestNotNull(TEXT("Create material fixture"),Material))return false;
    FAssetRegistryModule::AssetCreated(Material);
    UMaterialExpressionConstant* Expression=NewObject<UMaterialExpressionConstant>(Material,NAME_None,RF_Transactional);
    if(!TestNotNull(TEXT("Material expression created"),Expression))return false;
    Material->GetExpressionCollection().AddExpression(Expression);
    Expression->Material=Material;
    Expression->MaterialExpressionEditorX=350;
    Expression->MaterialExpressionEditorY=200;
    Expression->MaterialExpressionGuid=FGuid::NewGuid();
    FDSHAssetViewHint Hint;Hint.AssetPath=Material->GetPathName();Hint.NodeIds.Add(Expression->MaterialExpressionGuid.ToString());Hint.Center=FVector2D(350,200);
    FDSHAssetPresentation Presentation;Presentation.Queue(Hint);Presentation.Tick();Presentation.Tick();
    UAssetEditorSubsystem* Editors=GEditor->GetEditorSubsystem<UAssetEditorSubsystem>();
    IAssetEditorInstance* Instance=Editors?Editors->FindEditorForAsset(Material,false):nullptr;
    if(!TestNotNull(TEXT("Material editor opened"),Instance))return false;
    TestEqual(TEXT("Material editor handles expression focus"),Instance->GetEditorName(),FName(TEXT("MaterialEditor")));
    TSharedPtr<FTabManager> Tabs=Instance->GetAssociatedTabManager();
    TSharedPtr<SDockTab> Tab=Tabs.IsValid()?Tabs->GetOwnerTab():nullptr;
    TSharedPtr<SWindow> Window=Tab.IsValid()?Tab->GetParentWindow():FSlateApplication::Get().GetActiveTopLevelWindow();
    if(!TestTrue(TEXT("Material editor has a window"),Window.IsValid()))return false;
    TestTrue(TEXT("Material editor window is maximized"),Window->IsWindowMaximized());
    return true;
}
#endif
