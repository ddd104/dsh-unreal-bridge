#if WITH_DEV_AUTOMATION_TESTS
#include "DSHBlueprintOps.h"
#include "Dom/JsonValue.h"
#include "Misc/AutomationTest.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHBlueprintTimerPatch,"DSH.Bridge.BlueprintTimerPatch",EAutomationTestFlags::EditorContext|EAutomationTestFlags::EngineFilter)
bool FDSHBlueprintTimerPatch::RunTest(const FString&)
{
    FDSHBlueprintOps Ops;FString Code,Error;
    const FString Path=TEXT("/Game/DSHBridgeTests/BP_Timer_")+FGuid::NewGuid().ToString(EGuidFormats::Digits);
    auto Create=MakeShared<FJsonObject>();Create->SetStringField(TEXT("assetPath"),Path);Create->SetStringField(TEXT("parent"),TEXT("Actor"));
    const auto Created=Ops.Execute(TEXT("create_blueprint"),Create,Code,Error);
    if(!TestTrue(TEXT("Create timer test blueprint: ")+Error,Created.IsValid()))return false;
    auto Read=MakeShared<FJsonObject>();Read->SetStringField(TEXT("assetPath"),Path);Read->SetStringField(TEXT("graph"),TEXT("EventGraph"));Read->SetStringField(TEXT("detail"),TEXT("full"));
    const auto Before=Ops.Execute(TEXT("read_blueprint"),Read,Code,Error);
    if(!TestTrue(TEXT("Read timer test blueprint: ")+Error,Before.IsValid()))return false;
    FString BeginPlayId;
    for(const auto& Node:Before->GetArrayField(TEXT("graphs"))[0]->AsObject()->GetArrayField(TEXT("nodes")))
    {
        FString FunctionPath;
        if(Node->AsObject()->TryGetStringField(TEXT("functionPath"),FunctionPath)&&FunctionPath==TEXT("/Script/Engine.Actor:ReceiveBeginPlay"))BeginPlayId=Node->AsObject()->GetStringField(TEXT("id"));
    }
    if(!TestFalse(TEXT("BeginPlay is available"),BeginPlayId.IsEmpty()))return false;

    auto Patch=MakeShared<FJsonObject>();Patch->SetStringField(TEXT("assetPath"),Path);Patch->SetStringField(TEXT("graph"),TEXT("EventGraph"));Patch->SetStringField(TEXT("baseRevision"),Before->GetStringField(TEXT("revision")));
    TArray<TSharedPtr<FJsonValue>> Operations;
    auto Add=[&](const TSharedPtr<FJsonObject>& Op){Operations.Add(MakeShared<FJsonValueObject>(Op));};
    auto Event=MakeShared<FJsonObject>();Event->SetStringField(TEXT("op"),TEXT("add_custom_event"));Event->SetStringField(TEXT("nodeId"),TEXT("timerEvent"));Event->SetStringField(TEXT("eventName"),TEXT("PrintTime"));Add(Event);
    auto Timer=MakeShared<FJsonObject>();Timer->SetStringField(TEXT("op"),TEXT("add_node"));Timer->SetStringField(TEXT("nodeId"),TEXT("timer"));Timer->SetStringField(TEXT("kind"),TEXT("call_function"));Timer->SetStringField(TEXT("functionPath"),TEXT("/Script/Engine.KismetSystemLibrary:K2_SetTimerDelegate"));Add(Timer);
    auto Print=MakeShared<FJsonObject>();Print->SetStringField(TEXT("op"),TEXT("add_node"));Print->SetStringField(TEXT("nodeId"),TEXT("start"));Print->SetStringField(TEXT("kind"),TEXT("call_function"));Print->SetStringField(TEXT("functionPath"),TEXT("/Script/Engine.KismetSystemLibrary:PrintString"));Add(Print);
    auto Default=[&](const TCHAR* NodeId,const TCHAR* Pin,const TCHAR* Value){auto Op=MakeShared<FJsonObject>();Op->SetStringField(TEXT("op"),TEXT("set_pin_default"));Op->SetStringField(TEXT("nodeId"),NodeId);Op->SetStringField(TEXT("pin"),Pin);Op->SetStringField(TEXT("value"),Value);Add(Op);};
    Default(TEXT("timer"),TEXT("Time"),TEXT("1.0"));Default(TEXT("timer"),TEXT("bLooping"),TEXT("true"));Default(TEXT("start"),TEXT("InString"),TEXT("Start"));
    auto Connect=[&](const FString& FromNode,const TCHAR* FromPin,const TCHAR* ToNode,const TCHAR* ToPin){auto Op=MakeShared<FJsonObject>();Op->SetStringField(TEXT("op"),TEXT("connect"));auto From=MakeShared<FJsonObject>();From->SetStringField(TEXT("node"),FromNode);From->SetStringField(TEXT("pin"),FromPin);auto To=MakeShared<FJsonObject>();To->SetStringField(TEXT("node"),ToNode);To->SetStringField(TEXT("pin"),ToPin);Op->SetObjectField(TEXT("from"),From);Op->SetObjectField(TEXT("to"),To);Add(Op);};
    Connect(BeginPlayId,TEXT("then"),TEXT("start"),TEXT("execute"));
    Connect(TEXT("start"),TEXT("then"),TEXT("timer"),TEXT("execute"));
    Connect(TEXT("timerEvent"),TEXT("OutputDelegate"),TEXT("timer"),TEXT("Delegate"));
    Patch->SetArrayField(TEXT("operations"),Operations);
    const auto Preview=Ops.Execute(TEXT("preview_patch"),Patch,Code,Error);
    if(!TestTrue(TEXT("Preview complete timer graph: ")+Error,Preview.IsValid()))return false;
    TestEqual(TEXT("Preview did not change the asset"),Ops.Execute(TEXT("read_blueprint"),Read,Code,Error)->GetStringField(TEXT("revision")),Before->GetStringField(TEXT("revision")));
    const auto Applied=Ops.Execute(TEXT("apply_patch"),Patch,Code,Error);
    if(!TestTrue(TEXT("Apply complete timer graph: ")+Error,Applied.IsValid()))return false;
    TestTrue(TEXT("Timer graph compiled"),Applied->GetBoolField(TEXT("compiled")));
    bool FoundEvent=false,FoundDelegate=false;
    const auto After=Ops.Execute(TEXT("read_blueprint"),Read,Code,Error);
    for(const auto& Node:After->GetArrayField(TEXT("graphs"))[0]->AsObject()->GetArrayField(TEXT("nodes")))
    {
        const auto N=Node->AsObject();FString EventName;
        if(!N->TryGetStringField(TEXT("customEventName"),EventName)||EventName!=TEXT("PrintTime"))continue;
        FoundEvent=true;
        for(const auto& Pin:N->GetArrayField(TEXT("pins")))if(Pin->AsObject()->GetStringField(TEXT("name"))==TEXT("OutputDelegate"))FoundDelegate=Pin->AsObject()->GetArrayField(TEXT("links")).Num()==1;
    }
    TestTrue(TEXT("Read-back identifies the custom event"),FoundEvent);
    TestTrue(TEXT("Timer delegate is linked"),FoundDelegate);
    return true;
}
#endif
