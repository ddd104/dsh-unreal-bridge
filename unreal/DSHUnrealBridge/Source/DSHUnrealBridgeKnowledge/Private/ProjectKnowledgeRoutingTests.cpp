#if WITH_DEV_AUTOMATION_TESTS

#include "ProjectKnowledgeService.h"
#include "ProjectKnowledgeTools.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformTime.h"
#include "Misc/AutomationTest.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectKnowledgeToolCatalogTest, "DSHUnrealBridge.Knowledge.ToolCatalog", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectKnowledgeToolCatalogTest::RunTest(const FString& Parameters)
{
    TSet<FString> Names;
    for (const auto& Tool : ProjectKnowledgeTools::All())
    {
        TestFalse(FString(TEXT("Unique tool: ")) + Tool.Name, Names.Contains(Tool.Name));
        Names.Add(Tool.Name);
    }
    for (const TCHAR* Name : {TEXT("graph_query"), TEXT("graph_feature"), TEXT("graph_impact")})
    {
        const auto* Tool = ProjectKnowledgeTools::Find(Name);
        if (TestNotNull(TEXT("Graph tool has a route"), Tool))
            TestTrue(TEXT("Graph queries run in the worker"), Tool->Backend == ProjectKnowledgeTools::EBackend::Worker);
        TestTrue(TEXT("Graph query is bridge-exposed"), FProjectKnowledgeService::IsBridgeTool(Name));
        TestFalse(TEXT("Graph query is read-only"), FProjectKnowledgeService::IsWriteTool(Name));
    }
    TestFalse(TEXT("Update remains internal"), FProjectKnowledgeService::IsBridgeTool(TEXT("project_update")));
    TestTrue(TEXT("Update is classified as writing"), FProjectKnowledgeService::IsWriteTool(TEXT("project_update")));
    TestFalse(TEXT("Live object inspection remains internal"), FProjectKnowledgeService::IsBridgeTool(TEXT("inspect_object")));
    TestFalse(TEXT("Unknown tool is not bridge-exposed"), FProjectKnowledgeService::IsBridgeTool(TEXT("graph_unknown")));
    TestNull(TEXT("Unknown tool has no backend"), ProjectKnowledgeTools::Find(TEXT("graph_unknown")));
    return true;
}

namespace
{
    struct FWorkerRouteResult
    {
        bool bComplete = false;
        bool bSuccess = false;
        TSharedPtr<FJsonObject> Result;
    };

    class FKnowledgeWorkerRouteCommand : public IAutomationLatentCommand
    {
    public:
        FKnowledgeWorkerRouteCommand(FAutomationTestBase* InTest, const FString& InTool)
            : Test(InTest), Tool(InTool), State(MakeShared<FWorkerRouteResult>()) {}

        virtual bool Update() override
        {
            if (!bStarted)
            {
                bStarted = true;
                StartedAt = FPlatformTime::Seconds();
                const auto CapturedState = State;
                // Empty arguments produce worker validation errors or an absent-cache error.
                // Neither requires indexing, loading or modifying project assets.
                Request = FProjectKnowledgeService::Execute(Tool, MakeShared<FJsonObject>(), nullptr,
                    [CapturedState](bool bSuccess, TSharedPtr<FJsonObject> Result)
                    {
                        CapturedState->bComplete = true;
                        CapturedState->bSuccess = bSuccess;
                        CapturedState->Result = MoveTemp(Result);
                    });
            }
            if (!State->bComplete)
            {
                if (FPlatformTime::Seconds() - StartedAt < 30) return false;
                FProjectKnowledgeService::Cancel(Request);
                Test->AddError(Tool + TEXT(" did not return from the worker within 30 seconds."));
                return true;
            }
            Test->TestFalse(Tool + TEXT(" rejects empty arguments"), State->bSuccess);
            if (Test->TestTrue(Tool + TEXT(" returns structured worker evidence"), State->Result.IsValid()))
            {
                FString Code;
                State->Result->TryGetStringField(TEXT("code"), Code);
                Test->TestTrue(Tool + TEXT(" reaches worker validation instead of unknown routing: ") + Code,
                    Code == TEXT("cache_identity_mismatch") || Code == TEXT("graph_disabled") ||
                    Code == (Tool == TEXT("graph_impact") ? TEXT("invalid_node") : TEXT("invalid_query")));
            }
            return true;
        }

    private:
        FAutomationTestBase* Test;
        FString Tool;
        TSharedPtr<FWorkerRouteResult> State;
        FGuid Request;
        double StartedAt = 0;
        bool bStarted = false;
    };
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectKnowledgeGraphWorkerRoutingTest, "DSHUnrealBridge.Knowledge.GraphWorkerRouting", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectKnowledgeGraphWorkerRoutingTest::RunTest(const FString& Parameters)
{
    if (!TestTrue(TEXT("Bundled knowledge worker is available"), FProjectKnowledgeService::IsAvailable())) return false;
    for (const TCHAR* Tool : {TEXT("graph_query"), TEXT("graph_feature"), TEXT("graph_impact")})
    {
        ADD_LATENT_AUTOMATION_COMMAND(FKnowledgeWorkerRouteCommand(this, Tool));
    }
    return true;
}

#endif
