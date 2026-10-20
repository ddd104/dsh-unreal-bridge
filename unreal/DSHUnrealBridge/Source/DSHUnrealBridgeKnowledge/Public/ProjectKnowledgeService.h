#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class UWorld;

// 通用项目取证入口：只读 UE 对象，知识索引由插件内置运行环境处理。
class DSHUNREALBRIDGEKNOWLEDGE_API FProjectKnowledgeService
{
public:
    using FCompletion = TFunction<void(bool, TSharedPtr<FJsonObject>)>;

    static FGuid Execute(const FString& Tool, const TSharedPtr<FJsonObject>& Arguments, UWorld* World, FCompletion Completion);
    // Bridge admission, write protection and service routing share one tool catalog.
    // Internal tools such as project_update are executable but not bridge-exposed.
    static bool IsBridgeTool(const FString& Tool);
    static bool IsWriteTool(const FString& Tool);
    static bool IsAvailable();
    static void Cancel(const FGuid& RequestId);
    static void CancelAll();
    static void Initialize();
    static void Shutdown();
    static FString GetPluginDirectory();
    static FString GetCacheDirectory();

    // Game-thread-only reflection of an already resolved live instance. Never loads an asset,
    // resolves an object path or invokes a reflected function. Args uses properties,
    // maxProperties (1..200), elementOffset and maxElements for bounded reads.
    static TSharedPtr<FJsonObject> DescribeRuntimeObject(UObject* Object, UWorld* World, const TSharedPtr<FJsonObject>& Args);

    // 资产快照由游戏线程读取真实内存状态，缓存独立于图谱/记忆重建目录。
    static TSharedPtr<FJsonObject> CaptureAssetSnapshot(const FString& AssetPath, FString& Error);
    static TSharedPtr<FJsonObject> ReadCachedAssetSnapshot(const FString& AssetPath, FString& Error);
    static void BeginAssetSnapshotScan();
    static TArray<FString> GetStaleAssetSnapshotPaths();
    static bool EndAssetSnapshotScan(const TArray<FString>& AssetPaths, const TArray<FString>& Errors, bool bComplete, FString& Error,
        const TSharedPtr<FJsonObject>& DiskCoverage = nullptr);

private:
    friend class FProjectAssetSnapshotTest;
    // 自动化测试通过私有分页入口验证目录索引，不扩大生产接口。
    friend class FProjectMaterialSnapshotIndexTest;
    static void InitializeAssetSnapshots();
    static void ShutdownAssetSnapshots();
    static TSharedPtr<FJsonObject> ExecuteSnapshotTool(const FString& Tool, const TSharedPtr<FJsonObject>& Arguments);
};
