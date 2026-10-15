#if WITH_DEV_AUTOMATION_TESTS
#include "DSHBlueprintOps.h"
#include "Misc/AutomationTest.h"
#include "Engine/Blueprint.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "UObject/UObjectGlobals.h"

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
    {FString Function;if(N->AsObject()->TryGetStringField(TEXT("functionPath"),Function)&&Function==TEXT("/Script/Engine.Actor:ReceiveBeginPlay"))BeginPlayId=N->AsObject()->GetStringField(TEXT("id"));}
    if(!TestFalse(TEXT("Existing BeginPlay node is present"),BeginPlayId.IsEmpty()))return false;
    auto From=MakeShared<FJsonObject>();From->SetStringField(TEXT("node"),BeginPlayId);From->SetStringField(TEXT("pin"),TEXT("then"));
    auto To=MakeShared<FJsonObject>();To->SetStringField(TEXT("node"),TEXT("print1"));To->SetStringField(TEXT("pin"),TEXT("execute"));
    auto Connect=MakeShared<FJsonObject>();Connect->SetStringField(TEXT("op"),TEXT("connect"));Connect->SetObjectField(TEXT("from"),From);Connect->SetObjectField(TEXT("to"),To);
    Patch->SetArrayField(TEXT("operations"),{MakeShared<FJsonValueObject>(Add),MakeShared<FJsonValueObject>(Default),MakeShared<FJsonValueObject>(Connect)});
    auto Preview=Ops.Execute(TEXT("preview_patch"),Patch,Code,Error);
    if(!TestTrue(TEXT("Preview and compile transient copy: ")+Error,Preview.IsValid()))return false;
    TestEqual(TEXT("Preview leaves original unchanged"),Ops.Execute(TEXT("read_blueprint"),ReadParams,Code,Error)->GetStringField(TEXT("revision")),Revision);
    auto Applied=Ops.Execute(TEXT("apply_patch"),Patch,Code,Error);
    if(!TestTrue(TEXT("Apply and compile blueprint: ")+Error,Applied.IsValid()))return false;
    TestNotEqual(TEXT("Edit changes revision"),Applied->GetStringField(TEXT("revision")),Revision);
    TestFalse(TEXT("Edit does not save automatically"),Applied->GetBoolField(TEXT("saved")));
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
#endif
