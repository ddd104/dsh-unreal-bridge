#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "IBlueprintSelectionNotifier.h"

struct FAssetData;
class USelection;
class UTypedElementSelectionSet;
class UAssetEditorSubsystem;
class FDSHRuntimeInspector;

// Tracks the most recently used selection source, without retaining scene objects.
class FDSHEditorSelection : public IBlueprintSelectionNotifier
{
public:
    virtual ~FDSHEditorSelection() { Stop(); }
    void Start();
    void Stop();
    bool Tick();
    void SetRuntimeInspector(FDSHRuntimeInspector* Inspector) { RuntimeInspector = Inspector; }
    void RefreshRuntimeSelection() { if (Source == ESource::Level) bPending = true; }
    const TArray<TSharedPtr<FJsonValue>>& GetSelection() const { return Selection; }
    void OnBlueprintSelectionUpdated(IAssetEditorInstance* Editor, UBlueprint* Blueprint, const TArray<FTypedElementHandle>& SelectedElements) override;

private:
    friend class FDSHRuntimeSelectionTest;
    void AssetsChanged(const TArray<FAssetData>& Assets, bool bPrimary);
    void LevelChanged(UObject* Object);
    void TypedLevelChanged(const UTypedElementSelectionSet* SelectionSet);
    void SelectionSetChanged(USelection* SelectionSet, UTypedElementSelectionSet* OldSet, UTypedElementSelectionSet* NewSet);
    void BindSelectionSets();
    TArray<TSharedPtr<FJsonValue>> ReadLevelSelection();
    void BlueprintClosed(UObject* Asset, IAssetEditorInstance* Editor);

    FDelegateHandle AssetHandle, LevelHandle, ObjectHandle, SelectionSetHandle, MapHandle, BlueprintClosedHandle;
    TMap<TWeakObjectPtr<UTypedElementSelectionSet>, FDelegateHandle> TypedHandles;
    bool bPending = false;
    enum class ESource { Assets, Level, Blueprint };
    ESource Source = ESource::Assets;
    bool bBlueprintNotifierRegistered = false;
    TWeakObjectPtr<UAssetEditorSubsystem> AssetEditors;
    TWeakObjectPtr<UBlueprint> SelectedBlueprint;
    TArray<TSharedPtr<FJsonValue>> Selection, PendingAssets, PendingBlueprint;
    FString LastPayload;
    FDSHRuntimeInspector* RuntimeInspector = nullptr;
};
