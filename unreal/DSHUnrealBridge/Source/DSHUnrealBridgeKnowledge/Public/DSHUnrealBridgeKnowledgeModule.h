#pragma once

#include "CoreMinimal.h"
#include "HAL/IConsoleManager.h"
#include "Modules/ModuleManager.h"
#include "Containers/Ticker.h"

class UBlueprint;
class UMaterial;
struct FProjectKnowledgeUpdate;

class FDSHUnrealBridgeKnowledgeModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    // 复用已有图表读取器，按节点分页返回真实 Blueprint 证据。
    static TSharedPtr<FJsonObject> DescribeBlueprint(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Arguments);
    // 全量缓存复用现有 IR 读取器，不把模型分页上限带入磁盘快照。
    static TSharedPtr<FJsonObject> DescribeBlueprintSnapshot(UBlueprint* Blueprint);
    static TSharedPtr<FJsonObject> DescribeMaterialSnapshot(UMaterial* Material);

private:
    // 自动化通过实际菜单委托覆盖更新/取消链路，不公开额外运行时控制入口。
    friend class FProjectKnowledgeMenuTest;
    friend class FWaitProjectKnowledgeMenu;
    TArray<IConsoleObject*> ConsoleCommands;
    TSharedPtr<FProjectKnowledgeUpdate, ESPMode::ThreadSafe> KnowledgeUpdate;
    FTSTicker::FDelegateHandle KnowledgeTicker;

    void RegisterMenus();
    void StartKnowledgeUpdate();
    void CancelKnowledgeUpdate();
    bool TickKnowledgeUpdate(float DeltaTime);

    void RegisterConsoleCommands();
    void UnregisterConsoleCommands();
    void HandleExportAllCommand(const TArray<FString>& Args);
    void HandleExportBlueprintCommand(const TArray<FString>& Args);
    void HandleExportAssetsCommand(const TArray<FString>& Args);
    void HandleExportMaterialsCommand(const TArray<FString>& Args);

    TSharedPtr<FJsonObject> ExportAll();
    TSharedPtr<FJsonObject> ExportAssets();
    TSharedPtr<FJsonObject> ExportAllBlueprints();
    TSharedPtr<FJsonObject> ExportBlueprint(const FString& AssetPath);
    TSharedPtr<FJsonObject> ExportAllMaterials();
    TSharedPtr<FJsonObject> ExportMaterial(const FString& AssetPath);
};
