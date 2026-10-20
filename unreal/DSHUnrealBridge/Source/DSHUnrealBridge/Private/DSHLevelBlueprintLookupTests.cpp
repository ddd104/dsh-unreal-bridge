#include "DSHLevelBlueprintLookup.h"

#if WITH_DEV_AUTOMATION_TESTS
#include "Editor.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/World.h"
#include "Misc/AutomationTest.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"

namespace
{
struct FLookupTestWorld
{
    UWorld* World;
    FString PackagePath;
    explicit FLookupTestWorld(bool bLiveFixture = false)
    {
        const FString Name = bLiveFixture ? TEXT("Map_LevelLookup_Live") : TEXT("Map_LevelLookup_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
        PackagePath = TEXT("/Game/DSHBridgeTests/") + Name;
        UPackage* Package = CreatePackage(*PackagePath);
        const auto Values = UWorld::InitializationValues().CreatePhysicsScene(false).CreateNavigation(false)
            .CreateAISystem(false).ShouldSimulatePhysics(false).AllowAudioPlayback(false);
        World = UWorld::CreateWorld(EWorldType::Inactive, false, FName(*Name), Package, true, ERHIFeatureLevel::Num, &Values);
    }
    ~FLookupTestWorld() { if (World) World->DestroyWorld(false); }
};
TSharedPtr<FJsonObject> LookupArgs(const FString& Path)
{
    auto Params = MakeShared<FJsonObject>();
    Params->SetStringField(TEXT("mapPath"), Path);
    return Params;
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHLevelBlueprintLookupExisting, "DSH.Bridge.LevelBlueprintLookup.Existing",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHLevelBlueprintLookupExisting::RunTest(const FString&)
{
    // Keep a synthetic in-memory map only when the independent bridge E2E explicitly
    // requests it inside a disposable project. No map is created on disk.
    FString ProjectPath = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
    FPaths::NormalizeFilename(ProjectPath);
    const bool bLiveFixture = FParse::Param(FCommandLine::Get(), TEXT("DSHLevelBlueprintLookupFixture")) && ProjectPath.Contains(TEXT("/.test-state/"));
    FLookupTestWorld Fixture(bLiveFixture);
    if (!TestNotNull(TEXT("Fixture world"), Fixture.World)) return false;
    ULevelScriptBlueprint* Blueprint = Fixture.World->PersistentLevel->GetLevelScriptBlueprint(false);
    if (!TestNotNull(TEXT("Existing fixture Blueprint"), Blueprint)) return false;
    UWorld* Current = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    Blueprint->FriendlyName = TEXT("Existing friendly name must be preserved");
    const FString Name = Blueprint->FriendlyName;
    const int32 GraphCount = Blueprint->UbergraphPages.Num();
    FString Code, Error;
    for (const bool bDirty : { false, true })
    {
        Fixture.World->GetOutermost()->SetDirtyFlag(bDirty);
        auto Result = FDSHLevelBlueprintLookup::Resolve(LookupArgs(Fixture.PackagePath), Code, Error);
        if (!TestTrue(TEXT("Package lookup succeeds: ") + Error, Result.IsValid())) return false;
        TestEqual(TEXT("World canonical object path"), Result->GetStringField(TEXT("mapPath")), Fixture.World->GetPathName());
        TestEqual(TEXT("Exact existing subobject reference"), Result->GetObjectField(TEXT("blueprint"))->GetStringField(TEXT("refPath")), Blueprint->GetPathName());
        TestEqual(TEXT("Save target is the map World"), Result->GetObjectField(TEXT("saveTarget"))->GetStringField(TEXT("refPath")), Fixture.World->GetPathName());
        TestEqual(TEXT("Dirty status reported"), Result->GetBoolField(TEXT("packageDirty")), bDirty);
        TestEqual(TEXT("Dirty state is unchanged"), Fixture.World->GetOutermost()->IsDirty(), bDirty);
        TestEqual(TEXT("Friendly name remains unchanged"), Blueprint->FriendlyName, Name);
        TestEqual(TEXT("No graph is created"), Blueprint->UbergraphPages.Num(), GraphCount);
        TestTrue(TEXT("Current editor World is unchanged"), !GEditor || GEditor->GetEditorWorldContext().World() == Current);
        TestTrue(TEXT("Object path also resolves"), FDSHLevelBlueprintLookup::Resolve(LookupArgs(Fixture.World->GetPathName()), Code, Error).IsValid());
    }
    if (bLiveFixture) Fixture.World = nullptr; // UWorld::CreateWorld added the fixture to the root set.
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FDSHLevelBlueprintLookupMissing, "DSH.Bridge.LevelBlueprintLookup.NoCreation",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FDSHLevelBlueprintLookupMissing::RunTest(const FString&)
{
    FLookupTestWorld Fixture;
    if (!TestNotNull(TEXT("Fixture world"), Fixture.World)) return false;
    Fixture.World->PersistentLevel->LevelScriptBlueprint = nullptr;
    Fixture.World->GetOutermost()->SetDirtyFlag(false);
    FString Code, Error;
    TestFalse(TEXT("No existing Blueprint returns a structured error"), FDSHLevelBlueprintLookup::Resolve(LookupArgs(Fixture.PackagePath), Code, Error).IsValid());
    TestEqual(TEXT("Missing Blueprint error"), Code, FString(TEXT("LEVEL_BLUEPRINT_NOT_FOUND")));
    TestNull(TEXT("Lookup did not create a level Blueprint"), Fixture.World->PersistentLevel->LevelScriptBlueprint.Get());
    TestFalse(TEXT("Lookup did not dirty map"), Fixture.World->GetOutermost()->IsDirty());
    for (const FString& Invalid : { FString(TEXT("/Engine/Maps/Entry")), FString(TEXT("/Game/../Other")),
        Fixture.World->GetPathName() + TEXT(":PersistentLevel"), Fixture.PackagePath + TEXT(".OtherObject") })
    {
        TestFalse(TEXT("Invalid lookup rejected"), FDSHLevelBlueprintLookup::Resolve(LookupArgs(Invalid), Code, Error).IsValid());
        TestEqual(TEXT("Invalid map path error"), Code, FString(TEXT("INVALID_MAP_PATH")));
    }
    return true;
}
#endif
