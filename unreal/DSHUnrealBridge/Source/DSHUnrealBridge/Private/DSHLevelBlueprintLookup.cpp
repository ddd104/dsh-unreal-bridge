#include "DSHLevelBlueprintLookup.h"

#include "EdGraph/EdGraph.h"
#include "Engine/Level.h"
#include "Engine/LevelScriptBlueprint.h"
#include "Engine/World.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"

TSharedPtr<FJsonObject> FDSHLevelBlueprintLookup::Resolve(const TSharedPtr<FJsonObject>& Params,
    FString& ErrorCode, FString& ErrorMessage)
{
    check(IsInGameThread());
    ErrorCode.Reset();
    ErrorMessage.Reset();
    FString Path;
    if (!Params.IsValid() || !Params->TryGetStringField(TEXT("mapPath"), Path) ||
        Path.IsEmpty() || Path.Len() > 512 || Path.Contains(TEXT(":")) ||
        Path.Contains(TEXT("..")) || Path.Contains(TEXT("\\")) || Path.Contains(TEXT("UEDPIE_")))
    {
        ErrorCode = TEXT("INVALID_MAP_PATH");
        ErrorMessage = TEXT("Use a /Game/ map package or canonical World object path, without subobjects or PIE prefixes.");
        return nullptr;
    }
    const FString Package = FPackageName::ObjectPathToPackageName(Path);
    const FString ObjectPath = Package + TEXT(".") + FPackageName::GetShortName(Package);
    if (!Package.StartsWith(TEXT("/Game/")) || !FPackageName::IsValidLongPackageName(Package) ||
        (Path != Package && Path != ObjectPath))
    {
        ErrorCode = TEXT("INVALID_MAP_PATH");
        ErrorMessage = TEXT("mapPath must identify a /Game/ map package or its same-named World object.");
        return nullptr;
    }

    // Loading a map object does not open it in the level editor or replace its World context.
    UWorld* World = LoadObject<UWorld>(nullptr, *ObjectPath, nullptr, LOAD_NoWarn | LOAD_Quiet);
    if (!World || !World->PersistentLevel)
    {
        ErrorCode = TEXT("MAP_NOT_FOUND");
        ErrorMessage = TEXT("The map World or its persistent level could not be loaded: ") + ObjectPath;
        return nullptr;
    }
    ULevel* Level = World->PersistentLevel;
    ULevelScriptBlueprint* Existing = Level->LevelScriptBlueprint;
    const FString OriginalFriendlyName = Existing ? Existing->FriendlyName : FString();
    // The true argument forbids creation. UE still refreshes FriendlyName in this getter;
    // restore it so an inspection leaves even that editor-only field unchanged.
    ULevelScriptBlueprint* Blueprint = Level->GetLevelScriptBlueprint(true);
    if (Existing) Existing->FriendlyName = OriginalFriendlyName;
    if (!Blueprint)
    {
        ErrorCode = TEXT("LEVEL_BLUEPRINT_NOT_FOUND");
        ErrorMessage = TEXT("This map has no existing level script Blueprint. Lookup did not create one: ") + ObjectPath;
        return nullptr;
    }

    auto Result = MakeShared<FJsonObject>();
    auto BlueprintReference = MakeShared<FJsonObject>();
    BlueprintReference->SetStringField(TEXT("refPath"), Blueprint->GetPathName());
    Result->SetStringField(TEXT("status"), TEXT("available"));
    Result->SetStringField(TEXT("mapPath"), World->GetPathName());
    Result->SetObjectField(TEXT("blueprint"), BlueprintReference);
    auto SaveTarget = MakeShared<FJsonObject>();
    SaveTarget->SetStringField(TEXT("refPath"), World->GetPathName());
    Result->SetObjectField(TEXT("saveTarget"), SaveTarget);
    Result->SetStringField(TEXT("savingNote"), TEXT("The level Blueprint belongs to the map package; save the map package after an authorized edit."));
    Result->SetBoolField(TEXT("packageDirty"), World->GetOutermost()->IsDirty());
    Result->SetBoolField(TEXT("compileError"), Blueprint->Status == BS_Error);
    TArray<UEdGraph*> Graphs;
    Blueprint->GetAllGraphs(Graphs);
    TArray<TSharedPtr<FJsonValue>> GraphValues;
    for (const UEdGraph* Graph : Graphs)
    {
        if (!Graph) continue;
        auto Summary = MakeShared<FJsonObject>();
        Summary->SetStringField(TEXT("name"), Graph->GetName());
        Summary->SetStringField(TEXT("refPath"), Graph->GetPathName());
        Summary->SetNumberField(TEXT("nodeCount"), Graph->Nodes.Num());
        GraphValues.Add(MakeShared<FJsonValueObject>(Summary));
    }
    Result->SetArrayField(TEXT("graphs"), GraphValues);
    return Result;
}
