#include "ProjectKnowledgeService.h"
#include "ProjectKnowledgeTools.h"

#include "DSHUnrealBridgeKnowledgeModule.h"
#include "Async/Async.h"
#include "Dom/JsonObject.h"
#include "Engine/Blueprint.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/Paths.h"
#include "Misc/PackageName.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/UObjectIterator.h"
#include "UObject/UnrealType.h"
#include "UObject/Package.h"
#include <atomic>

namespace ProjectKnowledge
{
    constexpr int32 MaxProperties = 96;
    constexpr int32 MaxElements = 64;
    constexpr int32 MaxDepth = 4;
    constexpr int32 MaxText = 2048;

    // 请求状态与模块生命周期分离，取消不会留下继续访问编辑器的后台任务。
    struct FRequest
    {
        std::atomic<bool> Cancelled{false};
        FProjectKnowledgeService::FCompletion Completion;
        TFuture<void> Future;
    };

    struct FState
    {
        std::atomic<bool> Active{true};
        TMap<FGuid, TSharedPtr<FRequest, ESPMode::ThreadSafe>> Requests;
    };

    TSharedPtr<FState, ESPMode::ThreadSafe> State;

    TSharedPtr<FJsonObject> Error(const FString& Message)
    {
        TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("error"), Message);
        return Result;
    }

    bool InWorld(const UObject* Object, const UWorld* World)
    {
        return IsValid(Object) && IsValid(World) && !Object->IsTemplate() &&
            (Object->GetWorld() == World || Object->IsIn(World));
    }

    TSharedPtr<FJsonValue> ObjectReference(const UObject* Object)
    {
        if (!IsValid(Object))
        {
            return MakeShared<FJsonValueNull>();
        }
        TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
        Value->SetStringField(TEXT("path"), Object->GetPathName());
        Value->SetStringField(TEXT("classPath"), Object->GetClass()->GetPathName());
        return MakeShared<FJsonValueObject>(Value);
    }

    TSharedPtr<FJsonValue> PropertyValue(const FProperty* Property, const void* Address, UObject* Owner, int32 Depth, bool& bTruncated, int32 ElementOffset = 0, int32 ElementLimit = MaxElements)
    {
        if (Depth >= MaxDepth)
        {
            bTruncated = true;
            return MakeShared<FJsonValueString>(TEXT("<depth limit>"));
        }
        if (const FBoolProperty* Bool = CastField<FBoolProperty>(Property))
        {
            return MakeShared<FJsonValueBoolean>(Bool->GetPropertyValue(Address));
        }
        if (const FEnumProperty* Enum = CastField<FEnumProperty>(Property))
        {
            const int64 Number = Enum->GetUnderlyingProperty()->GetSignedIntPropertyValue(Address);
            TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
            Value->SetNumberField(TEXT("value"), Number);
            Value->SetStringField(TEXT("name"), Enum->GetEnum()->GetNameStringByValue(Number));
            return MakeShared<FJsonValueObject>(Value);
        }
        if (const FNumericProperty* Number = CastField<FNumericProperty>(Property))
        {
            // 超出 JSON 精确整数区间时保留原始十进制文本，避免协议值被四舍五入。
            if (Number->IsInteger())
            {
                const FString Decimal = Number->GetNumericPropertyValueToString(Address);
                const double AsDouble = FCString::Atod(*Decimal);
                return FMath::Abs(AsDouble) > 9007199254740991.0
                    ? StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueString>(Decimal))
                    : StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueNumber>(AsDouble));
            }
            const double Value = Number->GetFloatingPointPropertyValue(Address);
            return FMath::IsFinite(Value) ? StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueNumber>(Value))
                : StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueString>(TEXT("<non-finite>")));
        }
        if (const FSoftObjectProperty* SoftProperty = CastField<FSoftObjectProperty>(Property))
        {
            // 软引用即使尚未加载也保留资产路径，不能误报为不存在的候选。
            TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
            Value->SetStringField(TEXT("path"), SoftProperty->GetPropertyValue(Address).ToSoftObjectPath().ToString());
            Value->SetBoolField(TEXT("softReference"), true);
            return MakeShared<FJsonValueObject>(Value);
        }
        if (const FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
        {
            return ObjectReference(ObjectProperty->GetObjectPropertyValue(Address));
        }
        if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
        {
            FScriptArrayHelper Helper(Array, Address);
            TArray<TSharedPtr<FJsonValue>> Values;
            for (int32 Index = ElementOffset; Index < FMath::Min(Helper.Num(), ElementOffset + ElementLimit); ++Index)
            {
                Values.Add(PropertyValue(Array->Inner, Helper.GetRawPtr(Index), Owner, Depth + 1, bTruncated));
            }
            TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
            Value->SetArrayField(TEXT("items"), Values);
            Value->SetNumberField(TEXT("count"), Helper.Num());
            Value->SetNumberField(TEXT("elementOffset"), ElementOffset);
            Value->SetNumberField(TEXT("nextElementOffset"), ElementOffset + Values.Num());
            Value->SetBoolField(TEXT("truncated"), Helper.Num() > ElementOffset + Values.Num());
            bTruncated |= Helper.Num() > ElementOffset + Values.Num();
            return MakeShared<FJsonValueObject>(Value);
        }
        if (const FSetProperty* Set = CastField<FSetProperty>(Property))
        {
            FScriptSetHelper Helper(Set, Address);
            TArray<TSharedPtr<FJsonValue>> Values;
            int32 Ordinal = 0;
            for (int32 Index = 0; Index < Helper.GetMaxIndex() && Values.Num() < ElementLimit; ++Index)
            {
                if (Helper.IsValidIndex(Index))
                {
                    if (Ordinal++ < ElementOffset) continue;
                    Values.Add(PropertyValue(Set->ElementProp, Helper.GetElementPtr(Index), Owner, Depth + 1, bTruncated));
                }
            }
            TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
            Value->SetArrayField(TEXT("items"), Values);
            Value->SetNumberField(TEXT("count"), Helper.Num());
            Value->SetNumberField(TEXT("elementOffset"), ElementOffset);
            Value->SetNumberField(TEXT("nextElementOffset"), ElementOffset + Values.Num());
            Value->SetBoolField(TEXT("truncated"), Helper.Num() > ElementOffset + Values.Num());
            bTruncated |= Helper.Num() > ElementOffset + Values.Num();
            return MakeShared<FJsonValueObject>(Value);
        }
        if (const FMapProperty* Map = CastField<FMapProperty>(Property))
        {
            FScriptMapHelper Helper(Map, Address);
            TArray<TSharedPtr<FJsonValue>> Values;
            int32 Ordinal = 0;
            for (int32 Index = 0; Index < Helper.GetMaxIndex() && Values.Num() < ElementLimit; ++Index)
            {
                if (!Helper.IsValidIndex(Index)) continue;
                if (Ordinal++ < ElementOffset) continue;
                TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
                Entry->SetField(TEXT("key"), PropertyValue(Map->KeyProp, Helper.GetKeyPtr(Index), Owner, Depth + 1, bTruncated));
                Entry->SetField(TEXT("value"), PropertyValue(Map->ValueProp, Helper.GetValuePtr(Index), Owner, Depth + 1, bTruncated));
                Values.Add(MakeShared<FJsonValueObject>(Entry));
            }
            TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
            Value->SetArrayField(TEXT("entries"), Values);
            Value->SetNumberField(TEXT("count"), Helper.Num());
            Value->SetNumberField(TEXT("elementOffset"), ElementOffset);
            Value->SetNumberField(TEXT("nextElementOffset"), ElementOffset + Values.Num());
            Value->SetBoolField(TEXT("truncated"), Helper.Num() > ElementOffset + Values.Num());
            bTruncated |= Helper.Num() > ElementOffset + Values.Num();
            return MakeShared<FJsonValueObject>(Value);
        }
        if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
        {
            TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
            int32 Count = 0;
            for (TFieldIterator<FProperty> It(Struct->Struct); It; ++It)
            {
                if (++Count > MaxElements) { bTruncated = true; break; }
                Value->SetField(It->GetName(), PropertyValue(*It, It->ContainerPtrToValuePtr<void>(Address), Owner, Depth + 1, bTruncated));
            }
            return MakeShared<FJsonValueObject>(Value);
        }
        FString Text;
        Property->ExportTextItem_Direct(Text, Address, nullptr, Owner, PPF_None);
        bTruncated |= Text.Len() > MaxText;
        return MakeShared<FJsonValueString>(Text.Left(MaxText));
    }

    TSharedPtr<FJsonObject> DescribeObject(UObject* Object, const TSharedPtr<FJsonObject>& Arguments, int32 PropertyLimit = MaxProperties)
    {
        // 顶层容器按属性分页，截断后可继续取证，不能把前 64 项误作完整候选。
        double OffsetValue = 0, LimitValue = MaxElements;
        if ((Arguments->HasField(TEXT("elementOffset")) && !Arguments->TryGetNumberField(TEXT("elementOffset"), OffsetValue)) ||
            (Arguments->HasField(TEXT("maxElements")) && !Arguments->TryGetNumberField(TEXT("maxElements"), LimitValue)) ||
            OffsetValue < 0 || OffsetValue > 1000000 || LimitValue < 1 || LimitValue > 256 ||
            OffsetValue != FMath::FloorToDouble(OffsetValue) || LimitValue != FMath::FloorToDouble(LimitValue))
            return Error(TEXT("elementOffset must be a non-negative integer; maxElements must be an integer in 1..256."));
        const TArray<TSharedPtr<FJsonValue>>* Requested = nullptr;
        TSet<FString> Names;
        if (Arguments->HasField(TEXT("properties")))
        {
            if (!Arguments->TryGetArrayField(TEXT("properties"), Requested) || Requested->Num() > PropertyLimit)
                return Error(FString::Printf(TEXT("properties must be an array of at most %d reflected property names."), PropertyLimit));
            for (const TSharedPtr<FJsonValue>& Value : *Requested)
            {
                FString Name;
                if (!Value->TryGetString(Name) || Name.IsEmpty() || Name.Len() > 256)
                    return Error(TEXT("Each property name must be a non-empty string of at most 256 characters."));
                Names.Add(Name);
            }
        }
        TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
        Result->SetStringField(TEXT("path"), Object->GetPathName());
        Result->SetStringField(TEXT("classPath"), Object->GetClass()->GetPathName());
        Result->SetBoolField(TEXT("isDefaultObject"), Object->HasAnyFlags(RF_ClassDefaultObject));
        TArray<TSharedPtr<FJsonValue>> Hierarchy;
        for (UClass* Class = Object->GetClass(); Class; Class = Class->GetSuperClass())
        {
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("classPath"), Class->GetPathName());
            if (Class->ClassGeneratedBy) Entry->SetStringField(TEXT("generatedBy"), Class->ClassGeneratedBy->GetPathName());
            if (Class->HasMetaData(TEXT("ModuleRelativePath"))) Entry->SetStringField(TEXT("source"), Class->GetMetaData(TEXT("ModuleRelativePath")));
            Hierarchy.Add(MakeShared<FJsonValueObject>(Entry));
        }
        Result->SetArrayField(TEXT("classHierarchy"), Hierarchy);
        TArray<TSharedPtr<FJsonValue>> Values;
        int32 Available = 0;
        for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
        {
            FProperty* Property = *It;
            if (Property->HasAnyPropertyFlags(CPF_Deprecated)) continue;
            if (!Names.IsEmpty() && !Names.Contains(Property->GetName())) continue;
            ++Available;
            if (Values.Num() >= PropertyLimit) continue;
            bool bTruncated = false;
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("name"), Property->GetName());
            Entry->SetStringField(TEXT("type"), Property->GetCPPType());
            Entry->SetStringField(TEXT("owner"), Property->GetOwnerStruct()->GetPathName());
            Entry->SetField(TEXT("value"), PropertyValue(Property, Property->ContainerPtrToValuePtr<void>(Object), Object, 0, bTruncated, static_cast<int32>(OffsetValue), static_cast<int32>(LimitValue)));
            Entry->SetBoolField(TEXT("truncated"), bTruncated);
            // 同时读取类默认值，区分运行状态与蓝图/脚本覆写的初始配置。
            UObject* Defaults = Object->GetClass()->GetDefaultObject(false);
            if (Defaults && Defaults != Object)
            {
                bool bDefaultTruncated = false;
                Entry->SetField(TEXT("defaultValue"), PropertyValue(Property, Property->ContainerPtrToValuePtr<void>(Defaults), Defaults, 0, bDefaultTruncated, static_cast<int32>(OffsetValue), static_cast<int32>(LimitValue)));
                Entry->SetBoolField(TEXT("defaultTruncated"), bDefaultTruncated);
            }
            Values.Add(MakeShared<FJsonValueObject>(Entry));
        }
        Result->SetArrayField(TEXT("properties"), Values);
        Result->SetNumberField(TEXT("propertyCount"), Available);
        Result->SetBoolField(TEXT("truncated"), Available > Values.Num());
        TArray<TSharedPtr<FJsonValue>> Missing;
        for (const FString& Name : Names)
            if (!FindFProperty<FProperty>(Object->GetClass(), *Name)) Missing.Add(MakeShared<FJsonValueString>(Name));
        Result->SetArrayField(TEXT("missingProperties"), Missing);
        return Result;
    }

    TSharedPtr<FJsonObject> Inspect(const FString& Tool, const TSharedPtr<FJsonObject>& Args, UWorld* World)
    {
        check(IsInGameThread());
        if (Tool == TEXT("find_objects"))
        {
            if (!IsValid(World)) return Error(TEXT("Select a live editor/PIE session before searching runtime objects."));
            FString ClassPath, Name;
            if ((Args->HasField(TEXT("classPath")) && !Args->TryGetStringField(TEXT("classPath"), ClassPath)) ||
                (Args->HasField(TEXT("name")) && !Args->TryGetStringField(TEXT("name"), Name)))
                return Error(TEXT("classPath and name must be strings."));
            double LimitValue = 30;
            if ((Args->HasField(TEXT("maxResults")) && !Args->TryGetNumberField(TEXT("maxResults"), LimitValue)) ||
                LimitValue < 1 || LimitValue > 100 || LimitValue != FMath::FloorToDouble(LimitValue))
                return Error(TEXT("maxResults must be an integer in 1..100."));
            UClass* Class = ClassPath.IsEmpty() ? UObject::StaticClass() : FindObject<UClass>(nullptr, *ClassPath);
            if (!Class) return Error(TEXT("classPath must identify a currently loaded class; inspect the asset to load defaults first."));
            TArray<TSharedPtr<FJsonValue>> Matches;
            bool bTruncated = false;
            for (TObjectIterator<UObject> It; It; ++It)
            {
                UObject* Object = *It;
                if (!InWorld(Object, World) || !Object->IsA(Class) || (!Name.IsEmpty() && !Object->GetPathName().Contains(Name))) continue;
                if (Matches.Num() >= static_cast<int32>(LimitValue)) { bTruncated = true; break; }
                Matches.Add(ObjectReference(Object));
            }
            TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
            Result->SetStringField(TEXT("world"), World->GetPathName());
            Result->SetArrayField(TEXT("objects"), Matches);
            Result->SetBoolField(TEXT("truncated"), bTruncated);
            return Result;
        }

        FString Path;
        if (!Args->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty() || Path.Len() > 1024 ||
            Path.Contains(TEXT("..")) || Path.Contains(TEXT("\\")) || !Path.StartsWith(TEXT("/")))
            return Error(TEXT("path must be a canonical UE object or asset path, without traversal."));
        if (Tool == TEXT("inspect_object"))
        {
            UObject* Object = FindObject<UObject>(nullptr, *Path);
            if (!InWorld(Object, World)) return Error(TEXT("Object does not belong to the selected World. Use inspect_asset for class defaults."));
            TSharedPtr<FJsonObject> Result = DescribeObject(Object, Args);
            Result->SetStringField(TEXT("world"), World->GetPathName());
            Result->SetBoolField(TEXT("runtimeEvidence"), true);
            return Result;
        }

        // 资产读取仅接受包对象路径，不允许借由子对象路径跨入其他 PIE 世界。
        if (Path.Contains(TEXT(":")) || Path.Contains(TEXT("UEDPIE_")) || Path.StartsWith(TEXT("/Temp/")) || Path.StartsWith(TEXT("/Engine/Transient")))
            return Error(TEXT("inspect_asset only accepts saved asset or class paths; runtime subobjects require inspect_object."));
        if (!Path.Contains(TEXT("."))) Path += TEXT(".") + FPackageName::GetShortName(Path);
        if (!FPackageName::IsValidObjectPath(Path)) return Error(TEXT("Invalid UE asset path."));
        UObject* Asset = StaticLoadObject(UObject::StaticClass(), nullptr, *Path);
        if (!Asset) return Error(TEXT("Asset could not be loaded. Check the asset registry path."));
        if (Asset->GetWorld()) return Error(TEXT("World/map assets are not accepted as default objects."));
        UBlueprint* Blueprint = Cast<UBlueprint>(Asset);
        UClass* Class = Blueprint ? Blueprint->GeneratedClass.Get() : Cast<UClass>(Asset);
        UObject* Defaults = Class ? Class->GetDefaultObject() : Asset;
        if (!Defaults) return Error(TEXT("Asset has no generated class defaults; compile it in the editor before retrying."));
        TSharedPtr<FJsonObject> Result = DescribeObject(Defaults, Args);
        Result->SetStringField(TEXT("assetPath"), Asset->GetPathName());
        Result->SetBoolField(TEXT("runtimeEvidence"), false);
        Result->SetBoolField(TEXT("packageDirty"), Asset->GetOutermost()->IsDirty());
        bool bIncludeGraph = false;
        if (Args->HasField(TEXT("includeGraph")) && !Args->TryGetBoolField(TEXT("includeGraph"), bIncludeGraph))
            return Error(TEXT("includeGraph must be a boolean."));
        if (Blueprint && bIncludeGraph)
        {
            TSharedPtr<FJsonObject> Graphs = FDSHUnrealBridgeKnowledgeModule::DescribeBlueprint(Blueprint, Args);
            if (Graphs->HasField(TEXT("error"))) return Graphs;
            Result->SetObjectField(TEXT("blueprint"), Graphs);
        }
        return Result;
    }

    void RunWorker(const FString& Executable, const FString& Worker, const FString& Plugin, const FString& Project,
        const FString& Payload, const TSharedPtr<FRequest, ESPMode::ThreadSafe>& Request, bool& bSuccess, TSharedPtr<FJsonObject>& Result)
    {
        void* ReadOutput = nullptr; void* WriteOutput = nullptr;
        void* ReadInput = nullptr; void* WriteInput = nullptr;
        void* ReadError = nullptr; void* WriteError = nullptr;
        FPlatformProcess::CreatePipe(ReadOutput, WriteOutput);
        FPlatformProcess::CreatePipe(ReadInput, WriteInput, true);
        FPlatformProcess::CreatePipe(ReadError, WriteError);
        // 固定运行插件内的 Node，隐藏子进程窗口，不经过 shell 或 PATH。
        const FString Params = FString::Printf(TEXT("\"%s\" --project \"%s\" --plugin \"%s\" --once"), *Worker, *Project, *Plugin);
        FProcHandle Process = FPlatformProcess::CreateProc(*Executable, *Params, false, true, true, nullptr, 0, *Plugin, WriteOutput, ReadInput, WriteError);
        TArray<uint8> OutputBytes;
        FString Stderr;
        if (!Process.IsValid())
        {
            Result = Error(TEXT("Could not launch the plugin's bundled knowledge runtime."));
        }
        else if (!FPlatformProcess::WritePipe(WriteInput, Payload + TEXT("\n")))
        {
            Result = Error(TEXT("Could not send the knowledge request to the bundled worker."));
        }
        else
        {
            const double Started = FPlatformTime::Seconds();
            while (true)
            {
                TArray<uint8> Chunk;
                FPlatformProcess::ReadPipeToArray(ReadOutput, Chunk);
                OutputBytes.Append(Chunk);
                Stderr += FPlatformProcess::ReadPipe(ReadError);
                Stderr = Stderr.Right(16384);
                if (Request->Cancelled.load()) { Result = Error(TEXT("Knowledge request cancelled.")); break; }
                if (OutputBytes.Num() > 4 * 1024 * 1024) { Result = Error(TEXT("Knowledge result exceeded 4 MiB; narrow the query.")); break; }
                if (FPlatformTime::Seconds() - Started > 300.0) { Result = Error(TEXT("Knowledge query timed out; evidence is incomplete, not proof of unsupported behavior.")); break; }
                if (!FPlatformProcess::IsProcRunning(Process))
                {
                    Chunk.Reset();
                    FPlatformProcess::ReadPipeToArray(ReadOutput, Chunk);
                    OutputBytes.Append(Chunk);
                    break;
                }
                FPlatformProcess::Sleep(0.02f);
            }
            if (!Result.IsValid())
            {
                const FUTF8ToTCHAR Converted(reinterpret_cast<const ANSICHAR*>(OutputBytes.GetData()), OutputBytes.Num());
                const FString Output(Converted.Length(), Converted.Get());
                TSharedPtr<FJsonObject> Envelope;
                if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Output.TrimStartAndEnd()), Envelope) && Envelope.IsValid())
                {
                    bool bIsError = false;
                    const TSharedPtr<FJsonObject>* Body = nullptr;
                    if (Envelope->TryGetObjectField(TEXT("result"), Body)) Result = *Body;
                    else Result = Error(TEXT("Knowledge worker returned a non-object result."));
                    Envelope->TryGetBoolField(TEXT("isError"), bIsError);
                    if (bIsError && !Result->HasField(TEXT("error")))
                    {
                        // worker 保留结构化 code/message，同时给调用方稳定的可显示错误字段。
                        FString Message;
                        Result->TryGetStringField(TEXT("message"), Message);
                        Result->SetStringField(TEXT("error"), Message.IsEmpty() ? TEXT("Knowledge worker failed.") : Message);
                    }
                    bSuccess = !bIsError && !Result->HasField(TEXT("error"));
                }
                else Result = Error(TEXT("Knowledge worker returned invalid JSON. ") + Stderr.Left(1024));
            }
        }
        if (Process.IsValid())
        {
            if (FPlatformProcess::IsProcRunning(Process)) FPlatformProcess::TerminateProc(Process, true);
            FPlatformProcess::CloseProc(Process);
        }
        FPlatformProcess::ClosePipe(ReadOutput, WriteOutput);
        FPlatformProcess::ClosePipe(ReadInput, WriteInput);
        FPlatformProcess::ClosePipe(ReadError, WriteError);
    }
}

TSharedPtr<FJsonObject> FProjectKnowledgeService::DescribeRuntimeObject(UObject* Object, UWorld* World, const TSharedPtr<FJsonObject>& Args)
{
    check(IsInGameThread());
    if (!Args.IsValid() || !ProjectKnowledge::InWorld(Object, World))
        return ProjectKnowledge::Error(TEXT("Object does not belong to the supplied live World."));
    double Limit = 80;
    if ((Args->HasField(TEXT("maxProperties")) && !Args->TryGetNumberField(TEXT("maxProperties"), Limit)) ||
        !FMath::IsFinite(Limit) || Limit < 1 || Limit > 200 || Limit != FMath::FloorToDouble(Limit))
        return ProjectKnowledge::Error(TEXT("maxProperties must be an integer in 1..200."));
    return ProjectKnowledge::DescribeObject(Object, Args, static_cast<int32>(Limit));
}

FString FProjectKnowledgeService::GetPluginDirectory()
{
    const TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("DSHUnrealBridge"));
    return Plugin.IsValid() ? FPaths::ConvertRelativePathToFull(Plugin->GetBaseDir()) : FString();
}

FString FProjectKnowledgeService::GetCacheDirectory()
{
    return FPaths::Combine(GetPluginDirectory(), TEXT("Cache"));
}

bool FProjectKnowledgeService::IsAvailable()
{
    const FString Plugin = GetPluginDirectory();
    return !Plugin.IsEmpty() && IFileManager::Get().FileExists(*FPaths::Combine(Plugin, TEXT("Runtime/Win64/node.exe"))) &&
        IFileManager::Get().FileExists(*FPaths::Combine(Plugin, TEXT("Tools/knowledge-worker.mjs")));
}

bool FProjectKnowledgeService::IsBridgeTool(const FString& Tool)
{
    const auto* Spec = ProjectKnowledgeTools::Find(Tool);
    return Spec && Spec->bBridgeExposed;
}

bool FProjectKnowledgeService::IsWriteTool(const FString& Tool)
{
    const auto* Spec = ProjectKnowledgeTools::Find(Tool);
    return Spec && Spec->bWrite;
}

void FProjectKnowledgeService::Initialize()
{
    check(IsInGameThread());
    if (!ProjectKnowledge::State.IsValid()) ProjectKnowledge::State = MakeShared<ProjectKnowledge::FState, ESPMode::ThreadSafe>();
    InitializeAssetSnapshots();
}

FGuid FProjectKnowledgeService::Execute(const FString& Tool, const TSharedPtr<FJsonObject>& Arguments, UWorld* World, FCompletion Completion)
{
    check(IsInGameThread());
    Initialize();
    const FGuid Id = FGuid::NewGuid();
    const TSharedPtr<FJsonObject> Args = Arguments.IsValid() ? Arguments : MakeShared<FJsonObject>();
    // 快照读取同样在游戏线程执行，避免缓存与编辑器对象并发变化。
    const auto* Spec = ProjectKnowledgeTools::Find(Tool);
    const bool bSnapshot = Spec && Spec->Backend == ProjectKnowledgeTools::EBackend::Snapshot;
    const bool bUE = Spec && Spec->Backend != ProjectKnowledgeTools::EBackend::Worker;
    TSharedPtr<ProjectKnowledge::FRequest, ESPMode::ThreadSafe> Request = MakeShared<ProjectKnowledge::FRequest, ESPMode::ThreadSafe>();
    Request->Completion = MoveTemp(Completion);
    ProjectKnowledge::State->Requests.Add(Id, Request);
    const TWeakPtr<ProjectKnowledge::FState, ESPMode::ThreadSafe> WeakState = ProjectKnowledge::State;

    auto Finish = [WeakState, Request, Id](bool bSuccess, TSharedPtr<FJsonObject> Result)
    {
        const TSharedPtr<ProjectKnowledge::FState, ESPMode::ThreadSafe> Current = WeakState.Pin();
        if (!Current.IsValid() || !Current->Active.load()) return;
        Current->Requests.Remove(Id);
        if (Request->Cancelled.load()) { bSuccess = false; Result = ProjectKnowledge::Error(TEXT("Knowledge request cancelled.")); }
        if (Request->Completion) Request->Completion(bSuccess, Result);
    };

    if (bUE)
    {
        const TWeakObjectPtr<UWorld> WeakWorld(World);
        AsyncTask(ENamedThreads::GameThread, [WeakState, Request, Finish, Tool, Args, WeakWorld, bSnapshot]() mutable
        {
            const auto Current = WeakState.Pin();
            if (!Current.IsValid() || !Current->Active.load()) return;
            const TSharedPtr<FJsonObject> Result = Request->Cancelled.load() ? ProjectKnowledge::Error(TEXT("Knowledge request cancelled."))
                : bSnapshot ? ExecuteSnapshotTool(Tool, Args) : ProjectKnowledge::Inspect(Tool, Args, WeakWorld.Get());
            Finish(!Result->HasField(TEXT("error")), Result);
        });
        return Id;
    }
    if (!Spec || !IsAvailable())
    {
        const FString Message = !Spec ? TEXT("Unknown knowledge tool.") : TEXT("Plugin-local runtime or tools are missing; install the complete DSHUnrealBridge knowledge tools.");
        AsyncTask(ENamedThreads::GameThread, [Finish, Message]() mutable { Finish(false, ProjectKnowledge::Error(Message)); });
        return Id;
    }
    TSharedPtr<FJsonObject> Envelope = MakeShared<FJsonObject>();
    Envelope->SetStringField(TEXT("id"), Id.ToString(EGuidFormats::Digits));
    Envelope->SetStringField(TEXT("tool"), Tool);
    Envelope->SetObjectField(TEXT("arguments"), Args);
    FString Payload;
    FJsonSerializer::Serialize(Envelope.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Payload));
    const FString Plugin = GetPluginDirectory();
    const FString Project = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
    Request->Future = Async(EAsyncExecution::Thread, [WeakState, Request, Finish, Payload, Plugin, Project]() mutable
    {
        bool bSuccess = false;
        TSharedPtr<FJsonObject> Result;
        ProjectKnowledge::RunWorker(FPaths::Combine(Plugin, TEXT("Runtime/Win64/node.exe")), FPaths::Combine(Plugin, TEXT("Tools/knowledge-worker.mjs")), Plugin, Project, Payload, Request, bSuccess, Result);
        const auto Current = WeakState.Pin();
        if (Current.IsValid() && Current->Active.load())
            AsyncTask(ENamedThreads::GameThread, [Finish, bSuccess, Result = MoveTemp(Result)]() mutable { Finish(bSuccess, MoveTemp(Result)); });
    });
    return Id;
}

void FProjectKnowledgeService::Cancel(const FGuid& RequestId)
{
    check(IsInGameThread());
    if (ProjectKnowledge::State.IsValid())
        if (const auto* Request = ProjectKnowledge::State->Requests.Find(RequestId)) (*Request)->Cancelled.store(true);
}

void FProjectKnowledgeService::CancelAll()
{
    check(IsInGameThread());
    if (ProjectKnowledge::State.IsValid())
        for (const auto& Pair : ProjectKnowledge::State->Requests) Pair.Value->Cancelled.store(true);
}

void FProjectKnowledgeService::Shutdown()
{
    check(IsInGameThread());
    ShutdownAssetSnapshots();
    if (!ProjectKnowledge::State.IsValid()) return;
    ProjectKnowledge::State->Active.store(false);
    CancelAll();
    for (const auto& Pair : ProjectKnowledge::State->Requests)
        if (Pair.Value->Future.IsValid()) Pair.Value->Future.Wait();
    ProjectKnowledge::State.Reset();
}

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "GameFramework/Actor.h"
#include "Components/SceneComponent.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectKnowledgePathsTest, "DSHUnrealBridge.Knowledge.PluginPaths", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectKnowledgePathsTest::RunTest(const FString& Parameters)
{
    // 验证运行环境和缓存都随插件目录定位，不依赖机器 PATH 或项目 .ai。
    TestTrue(TEXT("Plugin directory exists"), IFileManager::Get().DirectoryExists(*FProjectKnowledgeService::GetPluginDirectory()));
    TestEqual(TEXT("Cache is plugin-owned"), FProjectKnowledgeService::GetCacheDirectory(), FPaths::Combine(FProjectKnowledgeService::GetPluginDirectory(), TEXT("Cache")));
    TestTrue(TEXT("Bundled worker/runtime available"), FProjectKnowledgeService::IsAvailable());
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectKnowledgeReflectionTest, "DSHUnrealBridge.Knowledge.ReflectionAndWorldBoundary", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectKnowledgeReflectionTest::RunTest(const FString& Parameters)
{
    // 用独立临时世界验证真实数组读取与跨世界拒绝，不加载或保存任何业务资产。
    UWorld* Selected = UWorld::CreateWorld(EWorldType::Game, false, FName(TEXT("KnowledgeSelectedTest")));
    UWorld* Other = UWorld::CreateWorld(EWorldType::Game, false, FName(TEXT("KnowledgeOtherTest")));
    if (!TestNotNull(TEXT("Selected world"), Selected) || !TestNotNull(TEXT("Other world"), Other)) return false;
    AActor* Actor = Selected->SpawnActor<AActor>();
    AActor* ForeignActor = Other->SpawnActor<AActor>();
    if (!TestNotNull(TEXT("Test actor"), Actor) || !TestNotNull(TEXT("Other actor"), ForeignActor))
    {
        Selected->DestroyWorld(false); Other->DestroyWorld(false); return false;
    }
    Actor->Tags = {FName(TEXT("FirstChoice")), FName(TEXT("SecondChoice"))};
    TSharedPtr<FJsonObject> Args = MakeShared<FJsonObject>();
    Args->SetStringField(TEXT("path"), Actor->GetPathName());
    Args->SetArrayField(TEXT("properties"), {MakeShared<FJsonValueString>(TEXT("Tags"))});
    TSharedPtr<FJsonObject> Result = ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, Selected);
    TestFalse(TEXT("Owned actor is inspectable"), Result->HasField(TEXT("error")));
    const TArray<TSharedPtr<FJsonValue>>* Properties = nullptr;
    if (TestTrue(TEXT("Properties returned"), Result->TryGetArrayField(TEXT("properties"), Properties)) && Properties->Num() > 0)
    {
        const TSharedPtr<FJsonObject> Value = (*Properties)[0]->AsObject()->GetObjectField(TEXT("value"));
        TestEqual(TEXT("Reads actual array count"), static_cast<int32>(Value->GetNumberField(TEXT("count"))), 2);
        TestEqual(TEXT("Reads actual first entry"), Value->GetArrayField(TEXT("items"))[0]->AsString(), FString(TEXT("FirstChoice")));
    }
    // 分页读取超出默认上限的真实数组，并验证没有漏掉最后一页。
    Actor->Tags.Reset();
    for (int32 Index = 0; Index < 70; ++Index) Actor->Tags.Add(FName(*FString::Printf(TEXT("Choice_%d"), Index)));
    Result = ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, Selected);
    TSharedPtr<FJsonObject> Page = Result->GetArrayField(TEXT("properties"))[0]->AsObject()->GetObjectField(TEXT("value"));
    TestEqual(TEXT("First page has 64 entries"), Page->GetArrayField(TEXT("items")).Num(), 64);
    TestTrue(TEXT("First page reports remaining entries"), Page->GetBoolField(TEXT("truncated")));
    Args->SetNumberField(TEXT("elementOffset"), Page->GetNumberField(TEXT("nextElementOffset")));
    Result = ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, Selected);
    Page = Result->GetArrayField(TEXT("properties"))[0]->AsObject()->GetObjectField(TEXT("value"));
    TestEqual(TEXT("Last page has six entries"), Page->GetArrayField(TEXT("items")).Num(), 6);
    TestFalse(TEXT("Last page is complete"), Page->GetBoolField(TEXT("truncated")));
    TestEqual(TEXT("Last actual item retained"), Page->GetArrayField(TEXT("items"))[5]->AsString(), FString(TEXT("Choice_69")));
    Args->SetNumberField(TEXT("elementOffset"), -1);
    TestTrue(TEXT("Invalid collection page refused"), ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, Selected)->HasField(TEXT("error")));
    Args->RemoveField(TEXT("elementOffset"));
    // 使用非抽象组件构造嵌套 outer 链，避免测试实例化 UE5.8 的抽象 UObject。
    USceneComponent* Container = NewObject<USceneComponent>(Selected);
    UObject* Nested = NewObject<USceneComponent>(Container);
    Args->SetStringField(TEXT("path"), Nested->GetPathName());
    TestFalse(TEXT("Nested object owned by selected World accepted"), ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, Selected)->HasField(TEXT("error")));
    Args->SetStringField(TEXT("path"), ForeignActor->GetPathName());
    TestTrue(TEXT("Different World refused"), ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, Selected)->HasField(TEXT("error")));
    Args->SetStringField(TEXT("path"), Actor->GetPathName());
    TestTrue(TEXT("Missing selected World refused"), ProjectKnowledge::Inspect(TEXT("inspect_object"), Args, nullptr)->HasField(TEXT("error")));
    Args->SetStringField(TEXT("path"), TEXT("/Game/../Forbidden"));
    TestTrue(TEXT("Traversal refused"), ProjectKnowledge::Inspect(TEXT("inspect_asset"), Args, Selected)->HasField(TEXT("error")));
    Args->SetNumberField(TEXT("maxResults"), 101);
    TestTrue(TEXT("Unbounded search refused"), ProjectKnowledge::Inspect(TEXT("find_objects"), Args, Selected)->HasField(TEXT("error")));
    Selected->DestroyWorld(false);
    Other->DestroyWorld(false);
    return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectKnowledgeBlueprintTest, "DSHUnrealBridge.Knowledge.BlueprintEvidencePaging", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectKnowledgeBlueprintTest::RunTest(const FString& Parameters)
{
    // 临时 Blueprint 提供真实节点与引脚，校验分页保留默认值及连接证据。
    UBlueprint* Blueprint = NewObject<UBlueprint>();
    Blueprint->ParentClass = AActor::StaticClass();
    UEdGraph* Graph = NewObject<UEdGraph>(Blueprint, TEXT("EvidenceGraph"));
    Blueprint->FunctionGraphs.Add(Graph);
    UEdGraphNode* First = NewObject<UEdGraphNode>(Graph);
    UEdGraphNode* Second = NewObject<UEdGraphNode>(Graph);
    First->CreateNewGuid(); Second->CreateNewGuid();
    Graph->Nodes.Add(First); Graph->Nodes.Add(Second);
    UEdGraphPin* Output = First->CreatePin(EGPD_Output, TEXT("int"), TEXT("Result"));
    UEdGraphPin* Input = Second->CreatePin(EGPD_Input, TEXT("int"), TEXT("Value"));
    Input->DefaultValue = TEXT("42");
    Output->MakeLinkTo(Input);
    TSharedPtr<FJsonObject> Args = MakeShared<FJsonObject>();
    Args->SetNumberField(TEXT("maxNodes"), 1);
    Args->SetStringField(TEXT("graphName"), TEXT("EvidenceGraph"));
    TSharedPtr<FJsonObject> Result = FDSHUnrealBridgeKnowledgeModule::DescribeBlueprint(Blueprint, Args);
    TestTrue(TEXT("One of two nodes is marked truncated"), Result->GetBoolField(TEXT("truncated")));
    Args->SetNumberField(TEXT("nodeOffset"), 1);
    Result = FDSHUnrealBridgeKnowledgeModule::DescribeBlueprint(Blueprint, Args);
    TestFalse(TEXT("Second page completes graph"), Result->GetBoolField(TEXT("truncated")));
    const TSharedPtr<FJsonObject> Node = Result->GetArrayField(TEXT("graphs"))[0]->AsObject()->GetArrayField(TEXT("nodes"))[0]->AsObject();
    const TSharedPtr<FJsonObject> Pin = Node->GetArrayField(TEXT("pins"))[0]->AsObject();
    TestEqual(TEXT("Actual pin default retained"), Pin->GetStringField(TEXT("defaultValue")), FString(TEXT("42")));
    Args->SetNumberField(TEXT("nodeOffset"), -1);
    TestTrue(TEXT("Invalid page refused"), FDSHUnrealBridgeKnowledgeModule::DescribeBlueprint(Blueprint, Args)->HasField(TEXT("error")));
    return true;
}
#endif
