#include "DSHEditorSelection.h"
#include "DSHRuntimeInspector.h"

#include "AssetRegistry/AssetData.h"
#include "BlueprintEditor.h"
#include "BlueprintEditorModule.h"
#include "Components/ActorComponent.h"
#include "ContentBrowserModule.h"
#include "Editor.h"
#include "Elements/Framework/TypedElementSelectionSet.h"
#include "Engine/Blueprint.h"
#include "Engine/InheritableComponentHandler.h"
#include "Engine/World.h"
#include "Features/IModularFeatures.h"
#include "GameFramework/Actor.h"
#include "IContentBrowserSingleton.h"
#include "Modules/ModuleManager.h"
#include "Selection.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "SSubobjectEditor.h"
#include "SubobjectData.h"
#include "Subsystems/AssetEditorSubsystem.h"

namespace
{
bool IsLevelActor(const AActor* Actor)
{
    return IsValid(Actor) && !Actor->IsActorBeingDestroyed() && !Actor->IsTemplate() && Actor->GetWorld()
        && (Actor->GetWorld()->WorldType == EWorldType::Editor || Actor->GetWorld()->WorldType == EWorldType::PIE);
}

void AddBlueprint(const UObject* Object, const TCHAR* Field, const TSharedRef<FJsonObject>& Entry)
{
    // A native subclass may inherit a Blueprint farther up the class hierarchy.
    for (const UClass* Class = Object->GetClass(); Class; Class = Class->GetSuperClass())
    {
        if (const UBlueprint* Blueprint = Cast<UBlueprint>(Class->ClassGeneratedBy))
        {
            Entry->SetStringField(Field, Blueprint->GetPathName());
            break;
        }
    }
}
}

void FDSHEditorSelection::Start()
{
    Stop();
    auto& Browser = FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
    AssetHandle = Browser.GetOnAssetSelectionChanged().AddRaw(this, &FDSHEditorSelection::AssetsChanged);
    LevelHandle = USelection::SelectionChangedEvent.AddRaw(this, &FDSHEditorSelection::LevelChanged);
    ObjectHandle = USelection::SelectObjectEvent.AddRaw(this, &FDSHEditorSelection::LevelChanged);
    SelectionSetHandle = USelection::SelectionElementSelectionPtrChanged.AddRaw(this, &FDSHEditorSelection::SelectionSetChanged);
    BindSelectionSets();
    MapHandle = FEditorDelegates::MapChange.AddLambda([this](uint32) { if (Source == ESource::Level) bPending = true; });
    IModularFeatures::Get().RegisterModularFeature(IBlueprintSelectionNotifier::GetModularFeatureName(), this);
    bBlueprintNotifierRegistered = true;
    AssetEditors = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
    if (AssetEditors.IsValid()) BlueprintClosedHandle = AssetEditors->OnAssetClosedInEditor().AddRaw(this, &FDSHEditorSelection::BlueprintClosed);
    TArray<FAssetData> Assets;
    Browser.Get().GetSelectedAssets(Assets);
    AssetsChanged(Assets, true);
    if (!ReadLevelSelection().IsEmpty()) Source = ESource::Level;
    if (FBlueprintEditorModule* Module = FModuleManager::GetModulePtr<FBlueprintEditorModule>(TEXT("Kismet")))
    {
        TSharedPtr<FBlueprintEditor> Latest;
        for (const auto& Editor : Module->GetBlueprintEditors())
        {
            auto Candidate = StaticCastSharedRef<FBlueprintEditor>(Editor);
            if (!Candidate->GetSelectedSubobjectEditorTreeNodes().IsEmpty()
                && (!Latest || Candidate->GetLastActivationTime() > Latest->GetLastActivationTime())) Latest = Candidate;
        }
        if (Latest && Latest->GetUISelectionState() == FBlueprintEditor::SelectionState_Components)
            OnBlueprintSelectionUpdated(Latest.Get(), Latest->GetBlueprintObj(), {});
    }
    Tick();
}

void FDSHEditorSelection::Stop()
{
    if (FModuleManager::Get().IsModuleLoaded(TEXT("ContentBrowser")))
        FModuleManager::GetModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser")).GetOnAssetSelectionChanged().Remove(AssetHandle);
    USelection::SelectionChangedEvent.Remove(LevelHandle);
    USelection::SelectObjectEvent.Remove(ObjectHandle);
    USelection::SelectionElementSelectionPtrChanged.Remove(SelectionSetHandle);
    if (bBlueprintNotifierRegistered)
        IModularFeatures::Get().UnregisterModularFeature(IBlueprintSelectionNotifier::GetModularFeatureName(), this);
    bBlueprintNotifierRegistered = false;
    if (AssetEditors.IsValid()) AssetEditors->OnAssetClosedInEditor().Remove(BlueprintClosedHandle);
    AssetEditors.Reset(); SelectedBlueprint.Reset(); BlueprintClosedHandle.Reset(); PendingBlueprint.Reset();
    FEditorDelegates::MapChange.Remove(MapHandle);
    for (const auto& Binding : TypedHandles)
        if (UTypedElementSelectionSet* Set = Binding.Key.Get()) Set->OnChanged().Remove(Binding.Value);
    TypedHandles.Reset(); SelectionSetHandle.Reset(); MapHandle.Reset();
    AssetHandle.Reset(); LevelHandle.Reset(); ObjectHandle.Reset();
    bPending = false;
    Source = ESource::Assets;
    Selection.Reset(); PendingAssets.Reset(); LastPayload.Reset();
}

void FDSHEditorSelection::BindSelectionSets()
{
    for (const auto& Binding : TypedHandles)
        if (UTypedElementSelectionSet* Set = Binding.Key.Get()) Set->OnChanged().Remove(Binding.Value);
    TypedHandles.Reset();
    if (!GEditor) return;
    for (USelection* Selected : { GEditor->GetSelectedActors(), GEditor->GetSelectedComponents() })
    {
        UTypedElementSelectionSet* Set = Selected ? Selected->GetElementSelectionSet() : nullptr;
        if (Set && !TypedHandles.Contains(Set))
            TypedHandles.Add(Set, Set->OnChanged().AddRaw(this, &FDSHEditorSelection::TypedLevelChanged));
    }
}

void FDSHEditorSelection::SelectionSetChanged(USelection* Selected, UTypedElementSelectionSet*, UTypedElementSelectionSet*)
{
    if (GEditor && (Selected == GEditor->GetSelectedActors() || Selected == GEditor->GetSelectedComponents()))
    {
        BindSelectionSets();
        Source = ESource::Level;
        bPending = true;
    }
}

void FDSHEditorSelection::TypedLevelChanged(const UTypedElementSelectionSet*)
{
    // UE5 viewport selections may explicitly suppress legacy USelection events.
    Source = ESource::Level;
    bPending = true;
}

void FDSHEditorSelection::AssetsChanged(const TArray<FAssetData>& Assets, bool bPrimary)
{
    if (!bPrimary) return;
    PendingAssets.Reset();
    for (const FAssetData& Asset : Assets)
    {
        if (PendingAssets.Num() >= 256) break;
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());
        Entry->SetStringField(TEXT("class"), Asset.AssetClassPath.ToString());
        PendingAssets.Add(MakeShared<FJsonValueObject>(Entry));
    }
    Source = ESource::Assets;
    bPending = true;
}

void FDSHEditorSelection::LevelChanged(UObject* Object)
{
    if (!GEditor) return;
    const AActor* Actor = Cast<AActor>(Object);
    if (const UActorComponent* Component = Cast<UActorComponent>(Object)) Actor = Component->GetOwner();
    // Ignore private selection sets and actors in asset-editor preview worlds.
    if (Object == GEditor->GetSelectedActors() || Object == GEditor->GetSelectedComponents() || IsLevelActor(Actor))
    {
        Source = ESource::Level;
        bPending = true;
    }
}

void FDSHEditorSelection::OnBlueprintSelectionUpdated(IAssetEditorInstance* Editor, UBlueprint* Blueprint, const TArray<FTypedElementHandle>&)
{
    if (!Editor || Editor->GetEditorName() != TEXT("BlueprintEditor") || !IsValid(Blueprint)) return;
    const auto* BlueprintEditor = static_cast<FBlueprintEditor*>(Editor);
    PendingBlueprint.Reset();
    for (const auto& Node : BlueprintEditor->GetSelectedSubobjectEditorTreeNodes())
    {
        if (PendingBlueprint.Num() >= 256) break;
        if (!Node.IsValid() || !Node->IsComponentNode()) continue;
        const FSubobjectData* Data = Node->GetDataSource();
        const UActorComponent* Component = Node->GetComponentTemplate();
        if (!Data || !IsValid(Component)) continue;
        // Read an existing child override without creating one while syncing selection.
        if (UInheritableComponentHandler* Handler = Blueprint->GetInheritableComponentHandler(false))
            if (UActorComponent* Override = Handler->GetOverridenComponentTemplate(Handler->FindKey(Node->GetVariableName()))) Component = Override;
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("kind"), TEXT("component"));
        Entry->SetStringField(TEXT("source"), TEXT("blueprint_editor"));
        Entry->SetStringField(TEXT("path"), Component->GetPathName());
        Entry->SetStringField(TEXT("class"), Component->GetClass()->GetPathName());
        Entry->SetStringField(TEXT("name"), Component->GetName());
        Entry->SetStringField(TEXT("label"), Node->GetDisplayString());
        Entry->SetStringField(TEXT("componentVariableName"), Node->GetVariableName().ToString());
        Entry->SetStringField(TEXT("ownerLabel"), Blueprint->GetName());
        Entry->SetStringField(TEXT("ownerBlueprintPath"), Blueprint->GetPathName());
        Entry->SetBoolField(TEXT("isInherited"), Data->IsInheritedComponent());
        AddBlueprint(Component, TEXT("blueprintPath"), Entry);
        PendingBlueprint.Add(MakeShared<FJsonValueObject>(Entry));
    }
    // The actor root and other Blueprint contexts identify the asset itself.
    if (PendingBlueprint.IsEmpty())
    {
        auto Entry = MakeShared<FJsonObject>();
        Entry->SetStringField(TEXT("path"), Blueprint->GetPathName());
        Entry->SetStringField(TEXT("class"), Blueprint->GetClass()->GetPathName());
        PendingBlueprint.Add(MakeShared<FJsonValueObject>(Entry));
    }
    SelectedBlueprint = Blueprint;
    Source = ESource::Blueprint;
    bPending = true;
}

void FDSHEditorSelection::BlueprintClosed(UObject* Asset, IAssetEditorInstance*)
{
    if (Source != ESource::Blueprint || Asset != SelectedBlueprint.Get()) return;
    SelectedBlueprint.Reset(); PendingBlueprint.Reset(); bPending = true;
}

TArray<TSharedPtr<FJsonValue>> FDSHEditorSelection::ReadLevelSelection()
{
    TArray<TSharedPtr<FJsonValue>> Entries;
    if (!GEditor) return Entries;
    auto Append = [this, &Entries](USelection* Selected, bool bComponents)
    {
        if (!Selected) return;
        for (FSelectionIterator It(*Selected); It && Entries.Num() < 256; ++It)
        {
            UObject* Object = *It;
            UActorComponent* Component = Cast<UActorComponent>(Object);
            AActor* Actor = bComponents ? (IsValid(Component) ? Component->GetOwner() : nullptr) : Cast<AActor>(Object);
            if (!IsValid(Object) || Object->IsTemplate() || !IsLevelActor(Actor)) continue;
            TSharedPtr<FJsonObject> Runtime;
            if (Actor->GetWorld()->WorldType == EWorldType::PIE)
            {
                Runtime = RuntimeInspector ? RuntimeInspector->Describe(Object) : nullptr;
                if (!Runtime) continue;
            }
            auto Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("path"), Object->GetPathName());
            Entry->SetStringField(TEXT("class"), Object->GetClass()->GetPathName());
            Entry->SetStringField(TEXT("kind"), bComponents ? TEXT("component") : TEXT("actor"));
            Entry->SetStringField(TEXT("name"), Object->GetName());
            Entry->SetStringField(TEXT("label"), bComponents ? Object->GetName() : Actor->GetActorLabel());
            Entry->SetStringField(TEXT("worldPath"), Actor->GetWorld()->GetPathName());
            if (Runtime) Entry->SetObjectField(TEXT("runtime"), Runtime);
            AddBlueprint(Object, TEXT("blueprintPath"), Entry);
            if (bComponents)
            {
                Entry->SetStringField(TEXT("ownerPath"), Actor->GetPathName());
                Entry->SetStringField(TEXT("ownerLabel"), Actor->GetActorLabel());
                AddBlueprint(Actor, TEXT("ownerBlueprintPath"), Entry);
            }
            Entries.Add(MakeShared<FJsonValueObject>(Entry));
        }
    };
    Append(GEditor->GetSelectedComponents(), true);
    // Component selection takes precedence over its implicitly selected owner.
    if (Entries.IsEmpty()) Append(GEditor->GetSelectedActors(), false);
    return Entries;
}

bool FDSHEditorSelection::Tick()
{
    if (!bPending) return false;
    bPending = false;
    auto Next = Source == ESource::Level ? ReadLevelSelection() : Source == ESource::Blueprint ? PendingBlueprint : PendingAssets;
    FString Payload;
    FJsonSerializer::Serialize(Next, TJsonWriterFactory<>::Create(&Payload));
    if (Payload == LastPayload) return false;
    LastPayload = MoveTemp(Payload);
    Selection = MoveTemp(Next);
    return true;
}
