#if WITH_DEV_AUTOMATION_TESTS
#include "DSHRuntimeInspector.h"
#include "DSHEditorSelection.h"
#include "Components/SceneComponent.h"
#include "Editor.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/PlatformTime.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Selection.h"
#include "Tests/AutomationEditorCommon.h"

namespace
{
// This also supplies a short-lived fixture for scripts/runtime-e2e.mjs. It never saves assets.
class FRuntimePIECommand final : public IAutomationLatentCommand
{
public:
    explicit FRuntimePIECommand(FAutomationTestBase* InTest) : Test(InTest), Started(FPlatformTime::Seconds())
    {
        Inspector.Start();
        Selection.SetRuntimeInspector(&Inspector);
        Selection.Start();
    }
    virtual bool Update() override
    {
        const double Now = FPlatformTime::Seconds();
        if (Now - Started > 90)
        {
            Test->AddError(TEXT("Timed out waiting for the disposable PIE lifecycle test"));
            if (GEditor->PlayWorld) GEditor->RequestEndPlayMap();
            return Finish();
        }
        Inspector.Tick();
        switch (Stage)
        {
        case 0:
            Play(); Stage = 1; break;
        case 1:
            if (GEditor->PlayWorld)
            {
                Create(TEXT("DSHRuntime_First"));
                First = Inspector.Describe(Actor.Get());
                if (!Test->TestTrue(TEXT("PIE actor gets a runtime identity"), First.IsValid())) return Finish();
                Select(Actor.Get(), false);
                Test->TestTrue(TEXT("PIE actor selection includes runtime identity"),
                    Selection.GetSelection().Num() == 1 && Selection.GetSelection()[0]->AsObject()->HasField(TEXT("runtime")));
                auto Params = MakeShared<FJsonObject>(); Params->SetObjectField(TEXT("target"), First);
                FString Code, Error;
                const auto Snapshot = Inspector.Snapshot(Params, Code, Error);
                Test->TestTrue(TEXT("Real PIE actor snapshot succeeds"), Snapshot.IsValid());
                Stage = 2; Changed = Now;
            }
            break;
        case 2:
            if (Now - Changed >= 4)
            {
                GEditor->SetPIEWorldsPaused(true);
                Select(Component.Get(), true);
                Test->TestTrue(TEXT("PIE component selection includes runtime identity"),
                    Selection.GetSelection().Num() == 1 && Selection.GetSelection()[0]->AsObject()->HasField(TEXT("runtime")));
                Stage = 3; Changed = Now;
            }
            break;
        case 3:
            if (Now - Changed >= 4)
            {
                Test->TestEqual(TEXT("Programmatic pause updates runtime state"), Inspector.GetState()->GetStringField(TEXT("status")), FString(TEXT("paused")));
                Test->TestEqual(TEXT("Paused PIE keeps the same run"), Inspector.GetState()->GetStringField(TEXT("playSessionId")), First->GetStringField(TEXT("playSessionId")));
                GEditor->GetSelectedComponents()->DeselectAll(); GEditor->GetSelectedActors()->DeselectAll();
                Actor->Destroy(); Inspector.Tick();
                auto Params = MakeShared<FJsonObject>(); Params->SetObjectField(TEXT("target"), First);
                FString Code, Error;
                Test->TestFalse(TEXT("Destroyed actor cannot be sampled"), Inspector.Snapshot(Params, Code, Error).IsValid());
                Test->TestEqual(TEXT("Destroy returns explicit expiry"), Code, FString(TEXT("RUNTIME_TARGET_EXPIRED")));
                Stage = 4; Changed = Now;
            }
            break;
        case 4:
            if (Now - Changed >= 3) { GEditor->RequestEndPlayMap(); Stage = 5; }
            break;
        case 5:
            if (!GEditor->PlayWorld)
            {
                Test->TestEqual(TEXT("Ending PIE stops the runtime"), Inspector.GetState()->GetStringField(TEXT("status")), FString(TEXT("stopped")));
                Play(); Stage = 6;
            }
            break;
        case 6:
            if (GEditor->PlayWorld)
            {
                Create(TEXT("DSHRuntime_Second"));
                const auto Second = Inspector.Describe(Actor.Get());
                if (!Test->TestTrue(TEXT("Restart creates a new runtime target"), Second.IsValid())) return Finish();
                Test->TestNotEqual(TEXT("Restart never reuses run identity"), First->GetStringField(TEXT("playSessionId")), Second->GetStringField(TEXT("playSessionId")));
                Test->TestNotEqual(TEXT("Restart never reuses object identity"), First->GetStringField(TEXT("objectId")), Second->GetStringField(TEXT("objectId")));
                auto Params = MakeShared<FJsonObject>(); Params->SetObjectField(TEXT("target"), First);
                FString Code, Error;
                Test->TestFalse(TEXT("Restart cannot revive the previous target"), Inspector.Snapshot(Params, Code, Error).IsValid());
                Select(Actor.Get(), false); Stage = 7; Changed = Now;
            }
            break;
        case 7:
            if (Now - Changed >= 4) { GEditor->RequestEndPlayMap(); Stage = 8; }
            break;
        case 8:
            if (!GEditor->PlayWorld) return Finish();
            break;
        }
        return false;
    }
private:
    void Play()
    {
        FRequestPlaySessionParams Params;
        Params.WorldType = EPlaySessionWorldType::SimulateInEditor;
        Params.bAllowOnlineSubsystem = false;
        GEditor->RequestPlaySession(Params);
    }
    void Create(const TCHAR* Label)
    {
        FActorSpawnParameters Params; Params.Name = TEXT("DSHRuntimeFixture"); Params.ObjectFlags = RF_Transient;
        Actor = GEditor->PlayWorld->SpawnActor<AActor>(Params);
        if (!Actor.IsValid()) { Test->AddError(TEXT("Failed to spawn PIE fixture")); return; }
        Actor->SetActorLabel(Label);
        Component = NewObject<USceneComponent>(Actor.Get(), TEXT("RuntimeFixtureComponent"), RF_Transient);
        Actor->AddInstanceComponent(Component.Get()); Actor->SetRootComponent(Component.Get()); Component->RegisterComponent();
        Component->SetVisibility(false);
    }
    void Select(UObject* Object, bool bComponent)
    {
        GEditor->GetSelectedComponents()->DeselectAll(); GEditor->GetSelectedActors()->DeselectAll();
        if (bComponent) GEditor->SelectComponent(CastChecked<UActorComponent>(Object), true, true);
        else GEditor->SelectActor(CastChecked<AActor>(Object), true, true);
        Selection.Tick();
    }
    bool Finish() { Selection.Stop(); Inspector.Stop(); return true; }
    FAutomationTestBase* Test;
    FDSHRuntimeInspector Inspector;
    FDSHEditorSelection Selection;
    TWeakObjectPtr<AActor> Actor;
    TWeakObjectPtr<USceneComponent> Component;
    TSharedPtr<FJsonObject> First;
    double Started, Changed = 0;
    int32 Stage = 0;
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHRuntimePIEIntegrationTest, "DSH.Bridge.RuntimePIEIntegration", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHRuntimePIEIntegrationTest::RunTest(const FString&)
{
    FString Project = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()); Project.ReplaceInline(TEXT("\\"), TEXT("/"));
    if (!FParse::Param(FCommandLine::Get(), TEXT("DSHRuntimePIETest")) || !Project.Contains(TEXT("/.test-state/")))
    {
        AddInfo(TEXT("PIE fixture skipped: requires -DSHRuntimePIETest and a disposable .test-state project."));
        return true;
    }
    if (!TestNotNull(TEXT("Editor available"), GEditor) || GEditor->PlayWorld) return false;
    if (!TestNotNull(TEXT("Create disposable unsaved map"), FAutomationEditorCommonUtils::CreateNewMap())) return false;
    ADD_LATENT_AUTOMATION_COMMAND(FRuntimePIECommand(this));
    return true;
}
#endif
