#include "DSHUnrealBridgeKnowledgeModule.h"
#include "ProjectKnowledgeService.h"

#include "Async/Async.h"
#include "AssetRegistry/AssetData.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Containers/StringConv.h"
#include "Components/ActorComponent.h"
#include "Components/SceneComponent.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "Interfaces/IPluginManager.h"
#include "K2Node.h"
#include "K2Node_CallFunction.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "K2Node_MacroInstance.h"
#include "K2Node_Variable.h"
#include "MaterialShaderType.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeExit.h"
#include "Misc/Parse.h"
#include "Misc/PackageName.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UnrealType.h"
#include "ToolMenus.h"
#include "Framework/Notifications/NotificationManager.h"
#include "Widgets/Notifications/SNotificationList.h"
#include <atomic>

#define LOCTEXT_NAMESPACE "FDSHUnrealBridgeKnowledgeModule"

// 分帧为全项目资产生成快照，完成后交给后台 worker 全量重建图谱与记忆。
struct FProjectKnowledgeUpdate
{
    std::atomic<bool> Cancelled{false};
    TArray<FAssetData> Assets;
    TArray<TSharedPtr<FJsonValue>> Summaries;
    TArray<FString> AssetPaths;
    TArray<FString> SnapshotErrors;
    TArray<FString> ContentDirectories;
    TSharedPtr<FJsonObject> DiskCoverage;
    int32 ExcludedPackageCount = 0;
    TArray<FAssetData> RecheckAssets;
    int32 NextRecheckAsset = 0;
    int32 RecheckRounds = 0;
    bool bRechecking = false;
    bool bWaitingForStability = false;
    int32 NextAsset = 0;
    bool bRegistryReady = false;
    bool bFinalizing = false;
    bool bFinished = false;
    bool bSucceeded = false;
    FString CompletionError;
    FGuid WorkerRequest;
    TWeakPtr<SNotificationItem> Notification;
    TFuture<void> ExportFuture;
};

namespace
{
    constexpr const TCHAR* BlueprintCacheDirName = TEXT("UE/blueprint_ir");
    constexpr const TCHAR* AssetRegistryCacheDirName = TEXT("UE/asset_registry");
    constexpr const TCHAR* MaterialCacheDirName = TEXT("UE/material_ir");

    TSharedPtr<FJsonObject> MakeOk()
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetBoolField(TEXT("ok"), true);
        return Json;
    }

    TSharedPtr<FJsonObject> MakeWarningResult(const FString& Warning)
    {
        TSharedPtr<FJsonObject> Json = MakeOk();
        TArray<TSharedPtr<FJsonValue>> Warnings;
        Warnings.Add(MakeShared<FJsonValueString>(Warning));
        Json->SetBoolField(TEXT("success"), false);
        Json->SetArrayField(TEXT("warnings"), Warnings);
        return Json;
    }

    FString JsonToString(const TSharedPtr<FJsonObject>& Object)
    {
        FString Output;
        const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Output);
        FJsonSerializer::Serialize(Object.ToSharedRef(), Writer);
        return Output;
    }

    bool JsonFromString(const FString& Text, TSharedPtr<FJsonObject>& OutObject, FString& OutError)
    {
        if (Text.TrimStartAndEnd().IsEmpty())
        {
            OutObject = MakeShared<FJsonObject>();
            return true;
        }

        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        if (!FJsonSerializer::Deserialize(Reader, OutObject) || !OutObject.IsValid())
        {
            OutError = TEXT("Request body is not valid JSON.");
            return false;
        }
        return true;
    }

    TArray<TSharedPtr<FJsonValue>> StringArrayToJson(const TArray<FString>& Values)
    {
        TArray<TSharedPtr<FJsonValue>> JsonValues;
        for (const FString& Value : Values)
        {
            JsonValues.Add(MakeShared<FJsonValueString>(Value));
        }
        return JsonValues;
    }

    FString GuidToString(const FGuid& Guid)
    {
        return Guid.IsValid() ? Guid.ToString(EGuidFormats::DigitsWithHyphens) : FString();
    }

    FString PinDirectionToString(EEdGraphPinDirection Direction)
    {
        switch (Direction)
        {
        case EGPD_Input:
            return TEXT("Input");
        case EGPD_Output:
            return TEXT("Output");
        default:
            return TEXT("Unknown");
        }
    }

    FString PinContainerTypeToString(EPinContainerType ContainerType)
    {
        switch (ContainerType)
        {
        case EPinContainerType::None:
            return TEXT("None");
        case EPinContainerType::Array:
            return TEXT("Array");
        case EPinContainerType::Set:
            return TEXT("Set");
        case EPinContainerType::Map:
            return TEXT("Map");
        default:
            return TEXT("Unknown");
        }
    }

    bool IsExecPin(const UEdGraphPin* Pin)
    {
        return Pin && Pin->PinType.PinCategory == TEXT("exec");
    }

    TSharedPtr<FJsonObject> PinTypeJson(const FEdGraphPinType& PinType)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("category"), PinType.PinCategory.ToString());
        Json->SetStringField(TEXT("subCategory"), PinType.PinSubCategory.ToString());
        Json->SetStringField(TEXT("containerType"), PinContainerTypeToString(PinType.ContainerType));
        Json->SetBoolField(TEXT("isReference"), PinType.bIsReference != 0);
        Json->SetBoolField(TEXT("isConst"), PinType.bIsConst != 0);
        Json->SetBoolField(TEXT("isWeakPointer"), PinType.bIsWeakPointer != 0);
        Json->SetBoolField(TEXT("isUObjectWrapper"), PinType.bIsUObjectWrapper != 0);
        if (PinType.PinSubCategoryObject.IsValid())
        {
            Json->SetStringField(TEXT("subCategoryObject"), PinType.PinSubCategoryObject->GetPathName());
        }
        if (!PinType.PinValueType.TerminalCategory.IsNone())
        {
            TSharedPtr<FJsonObject> ValueType = MakeShared<FJsonObject>();
            ValueType->SetStringField(TEXT("category"), PinType.PinValueType.TerminalCategory.ToString());
            ValueType->SetStringField(TEXT("subCategory"), PinType.PinValueType.TerminalSubCategory.ToString());
            if (PinType.PinValueType.TerminalSubCategoryObject.IsValid())
            {
                ValueType->SetStringField(TEXT("subCategoryObject"), PinType.PinValueType.TerminalSubCategoryObject->GetPathName());
            }
            Json->SetObjectField(TEXT("valueType"), ValueType);
        }
        return Json;
    }

    TSharedPtr<FJsonObject> MetadataArrayJson(const TArray<FBPVariableMetaDataEntry>& MetadataArray)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        for (const FBPVariableMetaDataEntry& Entry : MetadataArray)
        {
            Json->SetStringField(Entry.DataKey.ToString(), Entry.DataValue);
        }
        return Json;
    }

    TArray<TSharedPtr<FJsonValue>> PinArrayJson(const TArray<UEdGraphPin*>& Pins);

    TSharedPtr<FJsonObject> PinConnectionJson(const UEdGraphPin* Pin)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Pin)
        {
            return Json;
        }

        const UEdGraphNode* OwningNode = Pin->GetOwningNodeUnchecked();
        Json->SetStringField(TEXT("pinId"), GuidToString(Pin->PinId));
        Json->SetStringField(TEXT("pinName"), Pin->PinName.ToString());
        Json->SetStringField(TEXT("direction"), PinDirectionToString(Pin->Direction));
        // 原生图工具使用同方向引脚序号；同时保留 GUID 供计划执行前重新核对。
        if (const UEdGraphNode* Owner = Pin->GetOwningNodeUnchecked())
        {
            int32 DirectionIndex = 0;
            for (const UEdGraphPin* Candidate : Owner->Pins)
            {
                if (Candidate == Pin) break;
                if (Candidate && Candidate->Direction == Pin->Direction) ++DirectionIndex;
            }
            Json->SetNumberField(TEXT("directionIndex"), DirectionIndex);
            Json->SetStringField(TEXT("nodePath"), Owner->GetPathName());
        }
        if (OwningNode)
        {
            Json->SetStringField(TEXT("nodeGuid"), GuidToString(OwningNode->NodeGuid));
            Json->SetStringField(TEXT("nodeTitle"), OwningNode->GetNodeTitle(ENodeTitleType::ListView).ToString());
            Json->SetStringField(TEXT("nodeClass"), OwningNode->GetClass()->GetPathName());
        }
        return Json;
    }

    TSharedPtr<FJsonObject> PinJson(const UEdGraphPin* Pin)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Pin)
        {
            return Json;
        }

        Json->SetStringField(TEXT("pinId"), GuidToString(Pin->PinId));
        Json->SetStringField(TEXT("persistentGuid"), GuidToString(Pin->PersistentGuid));
        // 与原生 PinID 的 index_id 保持相同方向序号。
        int32 DirectionIndex = 0;
        if (const UEdGraphNode* Owner = Pin->GetOwningNodeUnchecked())
            for (const UEdGraphPin* Candidate : Owner->Pins)
            {
                if (Candidate == Pin) break;
                if (Candidate && Candidate->Direction == Pin->Direction) ++DirectionIndex;
            }
        Json->SetNumberField(TEXT("directionIndex"), DirectionIndex);
        Json->SetStringField(TEXT("name"), Pin->PinName.ToString());
#if WITH_EDITORONLY_DATA
        Json->SetStringField(TEXT("friendlyName"), Pin->PinFriendlyName.ToString());
#endif
        Json->SetStringField(TEXT("direction"), PinDirectionToString(Pin->Direction));
        Json->SetObjectField(TEXT("type"), PinTypeJson(Pin->PinType));
        Json->SetStringField(TEXT("defaultValue"), Pin->DefaultValue);
        Json->SetStringField(TEXT("autogeneratedDefaultValue"), Pin->AutogeneratedDefaultValue);
        Json->SetStringField(TEXT("defaultTextValue"), Pin->DefaultTextValue.ToString());
        Json->SetBoolField(TEXT("defaultValueIsReadOnly"), Pin->bDefaultValueIsReadOnly != 0);
        Json->SetBoolField(TEXT("defaultValueIsIgnored"), Pin->bDefaultValueIsIgnored != 0);
        if (Pin->DefaultObject)
        {
            Json->SetStringField(TEXT("defaultObject"), Pin->DefaultObject->GetPathName());
        }

        TArray<TSharedPtr<FJsonValue>> Connections;
        for (const UEdGraphPin* LinkedPin : Pin->LinkedTo)
        {
            if (LinkedPin)
            {
                Connections.Add(MakeShared<FJsonValueObject>(PinConnectionJson(LinkedPin)));
            }
        }
        Json->SetArrayField(TEXT("connections"), Connections);

        TArray<TSharedPtr<FJsonValue>> SubPins;
        for (const UEdGraphPin* SubPin : Pin->SubPins)
        {
            if (SubPin)
            {
                SubPins.Add(MakeShared<FJsonValueObject>(PinJson(SubPin)));
            }
        }
        Json->SetArrayField(TEXT("subPins"), SubPins);
        return Json;
    }

    TArray<TSharedPtr<FJsonValue>> PinArrayJson(const TArray<UEdGraphPin*>& Pins)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (const UEdGraphPin* Pin : Pins)
        {
            if (Pin)
            {
                Values.Add(MakeShared<FJsonValueObject>(PinJson(Pin)));
            }
        }
        return Values;
    }

    TSharedPtr<FJsonObject> VariableDescriptionJson(const FBPVariableDescription& Variable)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("name"), Variable.VarName.ToString());
        Json->SetStringField(TEXT("guid"), GuidToString(Variable.VarGuid));
        Json->SetStringField(TEXT("friendlyName"), Variable.FriendlyName);
        Json->SetStringField(TEXT("category"), Variable.Category.ToString());
        Json->SetStringField(TEXT("defaultValue"), Variable.DefaultValue);
        Json->SetStringField(TEXT("pinCategory"), Variable.VarType.PinCategory.ToString());
        Json->SetStringField(TEXT("pinSubCategory"), Variable.VarType.PinSubCategory.ToString());
        if (Variable.VarType.PinSubCategoryObject.IsValid())
        {
            Json->SetStringField(TEXT("pinSubCategoryObject"), Variable.VarType.PinSubCategoryObject->GetPathName());
        }
        Json->SetObjectField(TEXT("type"), PinTypeJson(Variable.VarType));
        Json->SetObjectField(TEXT("metadata"), MetadataArrayJson(Variable.MetaDataArray));
        Json->SetNumberField(TEXT("propertyFlags"), static_cast<double>(Variable.PropertyFlags));
        Json->SetStringField(TEXT("repNotifyFunc"), Variable.RepNotifyFunc.ToString());
        Json->SetStringField(TEXT("replicationCondition"), FString::FromInt(static_cast<int32>(Variable.ReplicationCondition.GetValue())));

        const bool bInstanceEditable = (Variable.PropertyFlags & CPF_Edit) != 0;
        const bool bBlueprintVisible = (Variable.PropertyFlags & CPF_BlueprintVisible) != 0;
        const bool bBlueprintReadOnly = (Variable.PropertyFlags & CPF_BlueprintReadOnly) != 0;
        const bool bExposeOnSpawn = Variable.HasMetaData(TEXT("ExposeOnSpawn"));
        Json->SetBoolField(TEXT("instanceEditable"), bInstanceEditable);
        Json->SetBoolField(TEXT("blueprintVisible"), bBlueprintVisible);
        Json->SetBoolField(TEXT("blueprintReadOnly"), bBlueprintReadOnly);
        Json->SetBoolField(TEXT("exposeOnSpawn"), bExposeOnSpawn);
        Json->SetBoolField(TEXT("isExposed"), bInstanceEditable || bExposeOnSpawn || bBlueprintVisible);
        return Json;
    }

    TSharedPtr<FJsonObject> ExportEditableObjectDefaults(UObject* Object, int32 MaxProperties = MAX_int32)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Object)
        {
            return Json;
        }

        int32 ExportedCount = 0;
        for (TFieldIterator<FProperty> PropertyIt(Object->GetClass()); PropertyIt && ExportedCount < MaxProperties; ++PropertyIt)
        {
            FProperty* Property = *PropertyIt;
            if (!Property || !Property->HasAnyPropertyFlags(CPF_Edit | CPF_BlueprintVisible))
            {
                continue;
            }
            if (Property->HasAnyPropertyFlags(CPF_Transient | CPF_DuplicateTransient | CPF_NonPIEDuplicateTransient))
            {
                continue;
            }

            FString Value;
            const void* PropertyValue = Property->ContainerPtrToValuePtr<void>(Object);
            Property->ExportTextItem_Direct(Value, PropertyValue, nullptr, Object, PPF_None);
            // 磁盘快照保留全部默认值，展示分页由查询层负责。
            Json->SetStringField(Property->GetName(), Value);
            ++ExportedCount;
        }
        return Json;
    }

    void AddWarning(TArray<TSharedPtr<FJsonValue>>& Warnings, const FString& Warning)
    {
        Warnings.Add(MakeShared<FJsonValueString>(Warning));
        UE_LOG(LogTemp, Warning, TEXT("DSHUnrealBridgeKnowledge: %s"), *Warning);
    }

    FString CacheRoot(const TCHAR* RelativeDir)
    {
        // 所有导出产物归插件 Cache 所有，可随插件迁移或整体删除重建。
        return FPaths::Combine(FProjectKnowledgeService::GetCacheDirectory(), RelativeDir);
    }

    bool EnsureDirectory(const FString& Directory, TArray<TSharedPtr<FJsonValue>>& Warnings)
    {
        if (IFileManager::Get().MakeDirectory(*Directory, true))
        {
            return true;
        }

        AddWarning(Warnings, FString::Printf(TEXT("Failed to create output directory: %s"), *Directory));
        return false;
    }

    FString MakeObjectPath(const FString& AssetPath)
    {
        FString Normalized = AssetPath.TrimStartAndEnd();
        if (Normalized.IsEmpty())
        {
            return Normalized;
        }

        const int32 LastSlash = Normalized.Find(TEXT("/"), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
        const int32 LastDot = Normalized.Find(TEXT("."), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
        if (LastDot > LastSlash)
        {
            return Normalized;
        }

        FString Leaf = Normalized.Mid(LastSlash + 1);
        return FString::Printf(TEXT("%s.%s"), *Normalized, *Leaf);
    }

    FString SanitizedFileName(const FString& AssetPath)
    {
        FString Name = AssetPath;
        Name.ReplaceInline(TEXT("/"), TEXT("_"));
        Name.ReplaceInline(TEXT("\\"), TEXT("_"));
        Name.ReplaceInline(TEXT(":"), TEXT("_"));
        Name.ReplaceInline(TEXT("."), TEXT("_"));
        Name.TrimStartAndEndInline();
        if (Name.StartsWith(TEXT("_")))
        {
            Name.RightChopInline(1);
        }
        return Name.IsEmpty() ? TEXT("asset") : Name;
    }

    bool SaveJsonFile(const FString& Directory, const FString& FileName, const TSharedPtr<FJsonObject>& Json, FString& OutPath, TArray<TSharedPtr<FJsonValue>>& Warnings)
    {
        if (!EnsureDirectory(Directory, Warnings))
        {
            return false;
        }

        OutPath = FPaths::Combine(Directory, FileName);
        if (!FFileHelper::SaveStringToFile(JsonToString(Json), *OutPath))
        {
            AddWarning(Warnings, FString::Printf(TEXT("Failed to write JSON: %s"), *OutPath));
            return false;
        }
        return true;
    }

    FString ObjectPathOrEmpty(const UObject* Object)
    {
        return Object ? Object->GetPathName() : FString();
    }

    FString ClassPathOrEmpty(const UClass* Class)
    {
        return Class ? Class->GetPathName() : FString();
    }

    FString EnumValueToString(const UEnum* Enum, int64 Value)
    {
        return Enum ? Enum->GetNameStringByValue(Value) : FString::FromInt(static_cast<int32>(Value));
    }

    IAssetRegistry& AssetRegistry()
    {
        return FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
    }

    void PackageReferences(FName PackageName, TArray<FString>& OutDependencies, TArray<FString>& OutReferencers)
    {
        IAssetRegistry& Registry = AssetRegistry();

        TArray<FName> Dependencies;
        Registry.GetDependencies(PackageName, Dependencies, UE::AssetRegistry::EDependencyCategory::Package);
        Dependencies.Sort(FNameLexicalLess());
        for (const FName& Dependency : Dependencies)
        {
            OutDependencies.Add(Dependency.ToString());
        }

        TArray<FName> Referencers;
        Registry.GetReferencers(PackageName, Referencers, UE::AssetRegistry::EDependencyCategory::Package);
        Referencers.Sort(FNameLexicalLess());
        for (const FName& Referencer : Referencers)
        {
            OutReferencers.Add(Referencer.ToString());
        }
    }

    TSharedPtr<FJsonObject> AssetSummaryJson(const FAssetData& AssetData)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("assetPath"), AssetData.GetObjectPathString());
        Json->SetStringField(TEXT("assetName"), AssetData.AssetName.ToString());
        Json->SetStringField(TEXT("assetClass"), AssetData.AssetClassPath.ToString());
        Json->SetStringField(TEXT("packageName"), AssetData.PackageName.ToString());
        Json->SetStringField(TEXT("packagePath"), AssetData.PackagePath.ToString());

        TSharedPtr<FJsonObject> Tags = MakeShared<FJsonObject>();
        for (const auto TagValue : AssetData.TagsAndValues)
        {
            const FString Value = TagValue.Value.AsString();
            Tags->SetStringField(TagValue.Key.ToString(), Value.Len() > 512 ? Value.Left(512) + TEXT("...") : Value);
        }
        Json->SetObjectField(TEXT("tags"), Tags);

        FString ParentMaterial;
        if (AssetData.GetTagValue(TEXT("Parent"), ParentMaterial) || AssetData.GetTagValue(TEXT("ParentMaterial"), ParentMaterial))
        {
            Json->SetStringField(TEXT("parentMaterial"), ParentMaterial);
        }

        TArray<FString> Dependencies;
        TArray<FString> Referencers;
        PackageReferences(AssetData.PackageName, Dependencies, Referencers);
        Json->SetArrayField(TEXT("dependencies"), StringArrayToJson(Dependencies));
        Json->SetArrayField(TEXT("referencers"), StringArrayToJson(Referencers));
        return Json;
    }

    FString PackageFileIdentity(const FString& File)
    {
        FString FullPath = FPaths::ConvertRelativePathToFull(File);
        FPaths::NormalizeFilename(FullPath); FPaths::CollapseRelativeDirectories(FullPath);
        return FullPath.ToLower();
    }

    TSharedPtr<FJsonObject> DiskPackageCoverage(const TArray<FString>& ContentDirectories, const TArray<TSharedPtr<FJsonValue>>& Summaries)
    {
        // 只枚举文件名，不读取二进制；登记表会跳过不可加载/无资产登记信息的包，必须额外对账。
        TMap<FString, FString> DiskFiles;
        for (const FString& Directory : ContentDirectories)
            for (const TCHAR* Pattern : {TEXT("*.uasset"), TEXT("*.umap")})
            {
                TArray<FString> Files;
                IFileManager::Get().FindFilesRecursive(Files, *Directory, Pattern, true, false);
                for (const FString& File : Files) DiskFiles.Add(PackageFileIdentity(File), FPaths::ConvertRelativePathToFull(File));
            }
        TSet<FString> RegisteredFiles;
        for (const auto& Summary : Summaries)
        {
            FString File;
            if (Summary->AsObject()->TryGetStringField(TEXT("packageFile"), File)) RegisteredFiles.Add(PackageFileIdentity(File));
        }
        TArray<FString> DiskKeys; DiskFiles.GetKeys(DiskKeys); DiskKeys.Sort();
        int32 RegisteredPackageCount = 0;
        TArray<TSharedPtr<FJsonValue>> ExcludedPackages;
        for (const FString& Key : DiskKeys)
        {
            if (RegisteredFiles.Contains(Key)) { ++RegisteredPackageCount; continue; }
            const auto Excluded = MakeShared<FJsonObject>();
            Excluded->SetStringField(TEXT("filePath"), DiskFiles[Key]);
            FString PackageName;
            if (FPackageName::TryConvertFilenameToLongPackageName(DiskFiles[Key], PackageName)) Excluded->SetStringField(TEXT("packageName"), PackageName);
            Excluded->SetStringField(TEXT("status"), TEXT("unregistered"));
            Excluded->SetStringField(TEXT("reason"), TEXT("Forced AssetRegistry scan did not provide an asset identity for this file; the cause is unknown. The package may be unreadable, contain no registry asset, or have changed during scanning."));
            ExcludedPackages.Add(MakeShared<FJsonValueObject>(Excluded));
        }
        const auto Coverage = MakeShared<FJsonObject>();
        Coverage->SetNumberField(TEXT("diskPackageCount"), DiskFiles.Num());
        Coverage->SetNumberField(TEXT("registeredPackageCount"), RegisteredPackageCount);
        Coverage->SetArrayField(TEXT("excludedPackages"), ExcludedPackages);
        return Coverage;
    }

    TSharedPtr<FJsonObject> NodeReferenceJson(const UEdGraphNode* Node)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Node)
        {
            return Json;
        }

        if (const UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node))
        {
            const UFunction* Function = CallNode->GetTargetFunction();
            Json->SetStringField(TEXT("kind"), TEXT("function"));
            Json->SetStringField(TEXT("name"), Function ? Function->GetName() : CallNode->FunctionReference.GetMemberName().ToString());
            Json->SetStringField(TEXT("path"), Function ? Function->GetPathName() : CallNode->FunctionReference.GetMemberName().ToString());
            if (const UClass* ParentClass = CallNode->FunctionReference.GetMemberParentClass())
            {
                Json->SetStringField(TEXT("parentClass"), ParentClass->GetPathName());
            }
            return Json;
        }

        if (const UK2Node_Variable* VariableNode = Cast<UK2Node_Variable>(Node))
        {
            Json->SetStringField(TEXT("kind"), TEXT("variable"));
            Json->SetStringField(TEXT("name"), VariableNode->GetVarNameString());
            if (const UClass* SourceClass = VariableNode->GetVariableSourceClass())
            {
                Json->SetStringField(TEXT("sourceClass"), SourceClass->GetPathName());
            }
            return Json;
        }

        if (const UK2Node_MacroInstance* MacroNode = Cast<UK2Node_MacroInstance>(Node))
        {
            Json->SetStringField(TEXT("kind"), TEXT("macro"));
            if (const UEdGraph* MacroGraph = MacroNode->GetMacroGraph())
            {
                Json->SetStringField(TEXT("name"), MacroGraph->GetName());
                Json->SetStringField(TEXT("path"), MacroGraph->GetPathName());
            }
            if (const UBlueprint* SourceBlueprint = MacroNode->GetSourceBlueprint())
            {
                Json->SetStringField(TEXT("sourceBlueprint"), SourceBlueprint->GetPathName());
            }
            return Json;
        }

        Json->SetStringField(TEXT("kind"), TEXT("none"));
        return Json;
    }

    TSharedPtr<FJsonObject> NodeJson(const UEdGraphNode* Node)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Node)
        {
            return Json;
        }

        Json->SetStringField(TEXT("nodeGuid"), GuidToString(Node->NodeGuid));
        Json->SetStringField(TEXT("objectPath"), Node->GetPathName());
        Json->SetStringField(TEXT("nodeClass"), Node->GetClass()->GetPathName());
        Json->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
        Json->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
        Json->SetStringField(TEXT("fullTitle"), Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString());
        // Some broken Blueprint nodes assert while computing a tooltip. Titles, class and pins
        // are sufficient for graph evidence, so snapshots do not invoke this presentation API.
        Json->SetNumberField(TEXT("x"), Node->NodePosX);
        Json->SetNumberField(TEXT("y"), Node->NodePosY);
        TSharedPtr<FJsonObject> Position = MakeShared<FJsonObject>();
        Position->SetNumberField(TEXT("x"), Node->NodePosX);
        Position->SetNumberField(TEXT("y"), Node->NodePosY);
        Json->SetObjectField(TEXT("position"), Position);

        const UK2Node* K2Node = Cast<UK2Node>(Node);
        Json->SetBoolField(TEXT("isPure"), K2Node ? K2Node->IsNodePure() : false);
        Json->SetBoolField(TEXT("isK2Node"), K2Node != nullptr);
        Json->SetObjectField(TEXT("reference"), NodeReferenceJson(Node));
        Json->SetObjectField(TEXT("functionReference"), NodeReferenceJson(Node));
        Json->SetArrayField(TEXT("pins"), PinArrayJson(Node->Pins));
        return Json;
    }

    TSharedPtr<FJsonObject> GraphConnectionJson(const UEdGraphPin* FromPin, const UEdGraphPin* ToPin)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetObjectField(TEXT("from"), PinConnectionJson(FromPin));
        Json->SetObjectField(TEXT("to"), PinConnectionJson(ToPin));
        Json->SetStringField(TEXT("type"), IsExecPin(FromPin) || IsExecPin(ToPin) ? TEXT("execution") : TEXT("data"));
        return Json;
    }

    void AddGraphConnections(const UEdGraph* Graph, TArray<TSharedPtr<FJsonValue>>& ExecutionLines, TArray<TSharedPtr<FJsonValue>>& DataLines)
    {
        if (!Graph)
        {
            return;
        }

        TSet<FString> SeenConnections;
        for (const UEdGraphNode* Node : Graph->Nodes)
        {
            if (!Node)
            {
                continue;
            }

            for (const UEdGraphPin* Pin : Node->Pins)
            {
                if (!Pin || Pin->Direction != EGPD_Output)
                {
                    continue;
                }

                for (const UEdGraphPin* LinkedPin : Pin->LinkedTo)
                {
                    if (!LinkedPin)
                    {
                        continue;
                    }
                    const FString Key = FString::Printf(TEXT("%s:%s>%s:%s"),
                        *GuidToString(Pin->PinId),
                        *Pin->PinName.ToString(),
                        *GuidToString(LinkedPin->PinId),
                        *LinkedPin->PinName.ToString());
                    if (SeenConnections.Contains(Key))
                    {
                        continue;
                    }
                    SeenConnections.Add(Key);

                    TSharedPtr<FJsonValueObject> ConnectionValue = MakeShared<FJsonValueObject>(GraphConnectionJson(Pin, LinkedPin));
                    if (IsExecPin(Pin) || IsExecPin(LinkedPin))
                    {
                        ExecutionLines.Add(ConnectionValue);
                    }
                    else
                    {
                        DataLines.Add(ConnectionValue);
                    }
                }
            }
        }
    }

    TArray<TSharedPtr<FJsonValue>> GraphPinsByDirection(const UEdGraph* Graph, bool bInputs)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        if (!Graph)
        {
            return Values;
        }

        for (const UEdGraphNode* Node : Graph->Nodes)
        {
            if (const UK2Node_FunctionEntry* EntryNode = Cast<UK2Node_FunctionEntry>(Node))
            {
                if (bInputs)
                {
                    for (const UEdGraphPin* Pin : EntryNode->Pins)
                    {
                        if (Pin && Pin->Direction == EGPD_Output && !IsExecPin(Pin))
                        {
                            Values.Add(MakeShared<FJsonValueObject>(PinJson(Pin)));
                        }
                    }
                }
            }
            else if (const UK2Node_FunctionResult* ResultNode = Cast<UK2Node_FunctionResult>(Node))
            {
                if (!bInputs)
                {
                    for (const UEdGraphPin* Pin : ResultNode->Pins)
                    {
                        if (Pin && Pin->Direction == EGPD_Input && !IsExecPin(Pin))
                        {
                            Values.Add(MakeShared<FJsonValueObject>(PinJson(Pin)));
                        }
                    }
                }
            }
        }
        return Values;
    }

    TArray<TSharedPtr<FJsonValue>> LocalVariableArray(const UEdGraph* Graph)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        if (!Graph)
        {
            return Values;
        }

        for (const UEdGraphNode* Node : Graph->Nodes)
        {
            if (const UK2Node_FunctionEntry* EntryNode = Cast<UK2Node_FunctionEntry>(Node))
            {
                for (const FBPVariableDescription& LocalVariable : EntryNode->LocalVariables)
                {
                    Values.Add(MakeShared<FJsonValueObject>(VariableDescriptionJson(LocalVariable)));
                }
            }
        }
        return Values;
    }

    TArray<TSharedPtr<FJsonValue>> GraphSummaryArray(const TArray<TObjectPtr<UEdGraph>>& Graphs, const TCHAR* GraphKind)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (const UEdGraph* Graph : Graphs)
        {
            if (!Graph)
            {
                continue;
            }

            TSharedPtr<FJsonObject> GraphJson = MakeShared<FJsonObject>();
            GraphJson->SetStringField(TEXT("name"), Graph->GetName());
            GraphJson->SetStringField(TEXT("graphKind"), GraphKind);
            GraphJson->SetStringField(TEXT("path"), Graph->GetPathName());
            GraphJson->SetStringField(TEXT("graphGuid"), GuidToString(Graph->GraphGuid));
            GraphJson->SetNumberField(TEXT("nodeCount"), Graph->Nodes.Num());

            TArray<TSharedPtr<FJsonValue>> Nodes;
            for (const UEdGraphNode* Node : Graph->Nodes)
            {
                if (!Node)
                {
                    continue;
                }
                Nodes.Add(MakeShared<FJsonValueObject>(NodeJson(Node)));
            }
            GraphJson->SetArrayField(TEXT("nodes"), Nodes);
            GraphJson->SetArrayField(TEXT("inputs"), GraphPinsByDirection(Graph, true));
            GraphJson->SetArrayField(TEXT("outputs"), GraphPinsByDirection(Graph, false));
            GraphJson->SetArrayField(TEXT("localVariables"), LocalVariableArray(Graph));

            TArray<TSharedPtr<FJsonValue>> ExecutionLines;
            TArray<TSharedPtr<FJsonValue>> DataLines;
            AddGraphConnections(Graph, ExecutionLines, DataLines);
            GraphJson->SetArrayField(TEXT("executionLines"), ExecutionLines);
            GraphJson->SetArrayField(TEXT("dataLines"), DataLines);
            Values.Add(MakeShared<FJsonValueObject>(GraphJson));
        }
        return Values;
    }

    TArray<TSharedPtr<FJsonValue>> CalledFunctionArray(const UBlueprint* Blueprint)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        TSet<FString> Seen;
        TArray<UEdGraph*> Graphs;
        for (UEdGraph* Graph : Blueprint->FunctionGraphs)
        {
            Graphs.Add(Graph);
        }
        for (UEdGraph* Graph : Blueprint->UbergraphPages)
        {
            Graphs.Add(Graph);
        }

        for (const UEdGraph* Graph : Graphs)
        {
            if (!Graph)
            {
                continue;
            }

            for (const UEdGraphNode* Node : Graph->Nodes)
            {
                const UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node);
                if (!CallNode)
                {
                    continue;
                }

                const UFunction* Function = CallNode->GetTargetFunction();
                const FString FunctionPath = Function ? Function->GetPathName() : CallNode->FunctionReference.GetMemberName().ToString();
                const FString Key = FString::Printf(TEXT("%s|%s"), *Graph->GetName(), *FunctionPath);
                if (Seen.Contains(Key))
                {
                    continue;
                }
                Seen.Add(Key);

                TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
                Json->SetStringField(TEXT("graph"), Graph->GetName());
                Json->SetStringField(TEXT("function"), FunctionPath);
                Json->SetStringField(TEXT("nodeTitle"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
                Values.Add(MakeShared<FJsonValueObject>(Json));
            }
        }
        return Values;
    }

    TArray<TSharedPtr<FJsonValue>> VariableArray(const UBlueprint* Blueprint)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (const FBPVariableDescription& Variable : Blueprint->NewVariables)
        {
            Values.Add(MakeShared<FJsonValueObject>(VariableDescriptionJson(Variable)));
        }
        return Values;
    }

    TArray<TSharedPtr<FJsonValue>> InterfaceArray(const UBlueprint* Blueprint)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        for (const FBPInterfaceDescription& Interface : Blueprint->ImplementedInterfaces)
        {
            if (Interface.Interface)
            {
                Values.Add(MakeShared<FJsonValueString>(Interface.Interface->GetPathName()));
            }
        }
        return Values;
    }

    TArray<TSharedPtr<FJsonValue>> ComponentArray(const UBlueprint* Blueprint)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        const USimpleConstructionScript* SCS = Blueprint->SimpleConstructionScript;
        if (!SCS)
        {
            return Values;
        }

        for (const USCS_Node* Node : SCS->GetAllNodes())
        {
            if (!Node)
            {
                continue;
            }

            TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
            Json->SetStringField(TEXT("name"), Node->GetVariableName().ToString());
            Json->SetStringField(TEXT("componentClass"), ClassPathOrEmpty(Node->ComponentClass));
            Json->SetStringField(TEXT("variableGuid"), GuidToString(Node->VariableGuid));
            Json->SetStringField(TEXT("attachToName"), Node->AttachToName.ToString());
            Json->SetStringField(TEXT("attachParent"), Node->ParentComponentOrVariableName.ToString());
            Json->SetStringField(TEXT("parentComponentOwnerClassName"), Node->ParentComponentOwnerClassName.ToString());
            Json->SetBoolField(TEXT("isParentComponentNative"), Node->bIsParentComponentNative);
            Json->SetObjectField(TEXT("metadata"), MetadataArrayJson(Node->MetaDataArray));

            TArray<FString> ChildNames;
            for (const USCS_Node* ChildNode : Node->GetChildNodes())
            {
                if (ChildNode)
                {
                    ChildNames.Add(ChildNode->GetVariableName().ToString());
                }
            }
            Json->SetArrayField(TEXT("children"), StringArrayToJson(ChildNames));

            if (UActorComponent* ComponentTemplate = Node->ComponentTemplate)
            {
                Json->SetStringField(TEXT("templateName"), ComponentTemplate->GetName());
                Json->SetStringField(TEXT("templatePath"), ComponentTemplate->GetPathName());
                Json->SetObjectField(TEXT("defaultProperties"), ExportEditableObjectDefaults(ComponentTemplate));

                if (const USceneComponent* SceneComponent = Cast<USceneComponent>(ComponentTemplate))
                {
                    Json->SetStringField(TEXT("mobility"), StaticEnum<EComponentMobility::Type>()->GetNameStringByValue(static_cast<int64>(SceneComponent->Mobility.GetValue())));
                }
            }
            Values.Add(MakeShared<FJsonValueObject>(Json));
        }
        return Values;
    }

    TSharedPtr<FJsonObject> BlueprintIrJson(UBlueprint* Blueprint, const FString& AssetPath)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("assetPath"), AssetPath);
        Json->SetStringField(TEXT("blueprintName"), Blueprint->GetName());
        Json->SetStringField(TEXT("parentClass"), ClassPathOrEmpty(Blueprint->ParentClass));
        Json->SetStringField(TEXT("generatedClass"), ClassPathOrEmpty(Blueprint->GeneratedClass));
        Json->SetArrayField(TEXT("implementedInterfaces"), InterfaceArray(Blueprint));
        Json->SetArrayField(TEXT("variables"), VariableArray(Blueprint));
        Json->SetArrayField(TEXT("functions"), GraphSummaryArray(Blueprint->FunctionGraphs, TEXT("Function")));
        Json->SetArrayField(TEXT("macros"), GraphSummaryArray(Blueprint->MacroGraphs, TEXT("Macro")));
        Json->SetArrayField(TEXT("eventGraphs"), GraphSummaryArray(Blueprint->UbergraphPages, TEXT("EventGraph")));
        // 折叠图、接口和委托图也必须进入全量快照，不能只读三个顶层图表数组。
        TArray<UEdGraph*> AllGraphs; Blueprint->GetAllGraphs(AllGraphs);
        TArray<TObjectPtr<UEdGraph>> OtherGraphs;
        for (UEdGraph* Graph : AllGraphs)
            if (!Blueprint->FunctionGraphs.Contains(Graph) && !Blueprint->MacroGraphs.Contains(Graph) && !Blueprint->UbergraphPages.Contains(Graph)) OtherGraphs.Add(Graph);
        Json->SetArrayField(TEXT("otherGraphs"), GraphSummaryArray(OtherGraphs, TEXT("Other")));
        Json->SetArrayField(TEXT("components"), ComponentArray(Blueprint));
        Json->SetArrayField(TEXT("calledFunctions"), CalledFunctionArray(Blueprint));

        TArray<FString> Dependencies;
        TArray<FString> Referencers;
        PackageReferences(Blueprint->GetOutermost()->GetFName(), Dependencies, Referencers);
        Json->SetArrayField(TEXT("referencedAssets"), StringArrayToJson(Dependencies));
        return Json;
    }

    TSharedPtr<FJsonObject> MaterialIrJson(UMaterial* Material, const FString& AssetPath)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("assetPath"), AssetPath);
        Json->SetStringField(TEXT("materialDomain"), EnumValueToString(StaticEnum<EMaterialDomain>(), static_cast<int64>(Material->MaterialDomain)));
        Json->SetStringField(TEXT("blendMode"), EnumValueToString(StaticEnum<EBlendMode>(), static_cast<int64>(Material->BlendMode)));
        Json->SetStringField(TEXT("shadingModel"), GetShadingModelFieldString(Material->GetShadingModels()));

        TArray<TSharedPtr<FJsonValue>> Expressions;
        for (const TObjectPtr<UMaterialExpression>& ExpressionPtr : Material->GetExpressions())
        {
            UMaterialExpression* Expression = ExpressionPtr.Get();
            if (!Expression)
            {
                continue;
            }

            TArray<FString> Captions;
            Expression->GetCaption(Captions);

            TSharedPtr<FJsonObject> ExpressionJson = MakeShared<FJsonObject>();
            ExpressionJson->SetStringField(TEXT("name"), Expression->GetName());
            ExpressionJson->SetStringField(TEXT("class"), Expression->GetClass()->GetPathName());
            ExpressionJson->SetNumberField(TEXT("editorX"), Expression->MaterialExpressionEditorX);
            ExpressionJson->SetNumberField(TEXT("editorY"), Expression->MaterialExpressionEditorY);
            ExpressionJson->SetArrayField(TEXT("caption"), StringArrayToJson(Captions));
            ExpressionJson->SetNumberField(TEXT("inputCount"), Expression->CountInputs());
            Expressions.Add(MakeShared<FJsonValueObject>(ExpressionJson));
        }
        Json->SetArrayField(TEXT("expressions"), Expressions);
        return Json;
    }

    UObject* LoadAssetObject(const FString& AssetPath, TArray<TSharedPtr<FJsonValue>>& Warnings)
    {
        const FString ObjectPath = MakeObjectPath(AssetPath);
        if (ObjectPath.IsEmpty())
        {
            AddWarning(Warnings, TEXT("Asset path is empty."));
            return nullptr;
        }

        UObject* Object = StaticLoadObject(UObject::StaticClass(), nullptr, *ObjectPath);
        if (!Object)
        {
            AddWarning(Warnings, FString::Printf(TEXT("Failed to load asset for read-only export: %s"), *AssetPath));
        }
        return Object;
    }

    bool GetAssetsByClass(UClass* Class, TArray<FAssetData>& OutAssets)
    {
        FARFilter Filter;
        Filter.PackagePaths.Add(FName(TEXT("/Game")));
        Filter.ClassPaths.Add(Class->GetClassPathName());
        Filter.bRecursivePaths = true;
        Filter.bRecursiveClasses = true;
        return AssetRegistry().GetAssets(Filter, OutAssets);
    }
}

void FDSHUnrealBridgeKnowledgeModule::StartupModule()
{
#if WITH_EDITOR
    FProjectKnowledgeService::Initialize();
    if (IsRunningCommandlet())
    {
        return;
    }

    RegisterConsoleCommands();
    UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::RegisterMenus));
#endif
}

void FDSHUnrealBridgeKnowledgeModule::ShutdownModule()
{
#if WITH_EDITOR
    UToolMenus::UnRegisterStartupCallback(this);
    UToolMenus::UnregisterOwner(this);
    CancelKnowledgeUpdate();
    if (KnowledgeUpdate.IsValid() && KnowledgeUpdate->ExportFuture.IsValid()) KnowledgeUpdate->ExportFuture.Wait();
    KnowledgeUpdate.Reset();
    FProjectKnowledgeService::Shutdown();
    UnregisterConsoleCommands();
#endif
}

void FDSHUnrealBridgeKnowledgeModule::RegisterMenus()
{
    // 使用现有 Tools 菜单，用户可主动刷新也能取消耗时索引任务。
    FToolMenuOwnerScoped OwnerScoped(this);
    UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.MainMenu.Tools"));
    FToolMenuSection& Section = Menu->FindOrAddSection(TEXT("ProjectKnowledge"), LOCTEXT("KnowledgeSection", "AI 项目知识"));
    FToolUIAction UpdateAction;
    UpdateAction.ExecuteAction = FToolMenuExecuteAction::CreateLambda([this](const FToolMenuContext&) { StartKnowledgeUpdate(); });
    UpdateAction.CanExecuteAction = FToolMenuCanExecuteAction::CreateLambda([this](const FToolMenuContext&) { return !KnowledgeUpdate.IsValid() && FProjectKnowledgeService::IsAvailable(); });
    FToolUIAction CancelAction;
    CancelAction.ExecuteAction = FToolMenuExecuteAction::CreateLambda([this](const FToolMenuContext&) { CancelKnowledgeUpdate(); });
    CancelAction.CanExecuteAction = FToolMenuCanExecuteAction::CreateLambda([this](const FToolMenuContext&) { return KnowledgeUpdate.IsValid() && !KnowledgeUpdate->Cancelled.load(); });
    Section.AddMenuEntry(TEXT("UpdateProjectKnowledge"), LOCTEXT("UpdateKnowledge", "更新项目图谱与知识记忆"),
        LOCTEXT("UpdateKnowledgeTip", "扫描项目及插件资产，复用未变化的快照，并重建图谱与知识记忆。缓存位于 DSHUnrealBridge/Cache/UE/asset_snapshots。"),
        FSlateIcon(), UpdateAction);
    Section.AddMenuEntry(TEXT("CancelProjectKnowledge"), LOCTEXT("CancelKnowledge", "取消图谱与知识更新"),
        LOCTEXT("CancelKnowledgeTip", "停止当前索引任务，不修改项目源文件或资产。"), FSlateIcon(),
        CancelAction);
    // 工具栏与 Tools 菜单复用同一完整扫描委托，避免两个入口采用不同范围。
    UToolMenu* Toolbar = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.LevelEditorToolBar.User"));
    Toolbar->FindOrAddSection(TEXT("ProjectKnowledge")).AddEntry(FToolMenuEntry::InitToolBarButton(
        TEXT("UpdateProjectKnowledge"), UpdateAction, LOCTEXT("KnowledgeToolbar", "更新项目图谱"),
        LOCTEXT("KnowledgeToolbarTip", "全量扫描当前项目，为每个资产生成 JSON 快照并更新图谱与知识记忆。")));
}

void FDSHUnrealBridgeKnowledgeModule::StartKnowledgeUpdate()
{
    if (KnowledgeUpdate.IsValid()) return;
    KnowledgeUpdate = MakeShared<FProjectKnowledgeUpdate, ESPMode::ThreadSafe>();
    FProjectKnowledgeService::BeginAssetSnapshotScan();
    // 主动启动完整登记表扫描，不能只依赖编辑器此前浏览过的目录。
    AssetRegistry().SearchAllAssets(false);
    const TSharedPtr<FProjectKnowledgeUpdate, ESPMode::ThreadSafe> Update = KnowledgeUpdate;
    FNotificationInfo Info(LOCTEXT("KnowledgeScanning", "正在读取项目资产索引…"));
    Info.bFireAndForget = false;
    Info.ExpireDuration = 5.0f;
    Info.ButtonDetails.Add(FNotificationButtonInfo(LOCTEXT("CancelKnowledgeButton", "取消"), FText::GetEmpty(),
        FSimpleDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::CancelKnowledgeUpdate)));
    Update->Notification = FSlateNotificationManager::Get().AddNotification(Info);
    if (const TSharedPtr<SNotificationItem> Notification = Update->Notification.Pin()) Notification->SetCompletionState(SNotificationItem::CS_Pending);

    KnowledgeTicker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::TickKnowledgeUpdate));
}

void FDSHUnrealBridgeKnowledgeModule::CancelKnowledgeUpdate()
{
    if (!KnowledgeUpdate.IsValid()) return;
    KnowledgeUpdate->Cancelled.store(true);
    KnowledgeUpdate->bFinished = true;
    KnowledgeUpdate->CompletionError = TEXT("cancelled");
    FString SnapshotError;
    FProjectKnowledgeService::EndAssetSnapshotScan(KnowledgeUpdate->AssetPaths, KnowledgeUpdate->SnapshotErrors, false, SnapshotError);
    if (KnowledgeTicker.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(KnowledgeTicker);
    KnowledgeTicker.Reset();
    if (KnowledgeUpdate->WorkerRequest.IsValid()) FProjectKnowledgeService::Cancel(KnowledgeUpdate->WorkerRequest);
    if (const TSharedPtr<SNotificationItem> Notification = KnowledgeUpdate->Notification.Pin())
    {
        Notification->SetText(LOCTEXT("KnowledgeCancelled", "项目知识更新已取消"));
        Notification->SetCompletionState(SNotificationItem::CS_Fail);
        Notification->ExpireAndFadeout();
    }
    // 后台快照写入完成前保留任务，防止取消后立即重入与旧快照竞争。
    if (!KnowledgeUpdate->bFinalizing) KnowledgeUpdate.Reset();
}

bool FDSHUnrealBridgeKnowledgeModule::TickKnowledgeUpdate(float DeltaTime)
{
    const TSharedPtr<FProjectKnowledgeUpdate, ESPMode::ThreadSafe> Update = KnowledgeUpdate;
    if (!Update.IsValid() || Update->Cancelled.load()) return false;
    if (!Update->bRegistryReady)
    {
        // 完整项目范围包含 /Game 与所有已挂载的项目插件 Content，不包含引擎插件。
        if (AssetRegistry().IsLoadingAssets()) return true;
        TArray<FString> Roots = {TEXT("/Game")};
        Update->ContentDirectories.Add(FPaths::ConvertRelativePathToFull(FPaths::ProjectContentDir()));
        for (const auto& Plugin : IPluginManager::Get().GetEnabledPlugins())
            if (Plugin->CanContainContent() && Plugin->GetType() == EPluginType::Project)
            {
                Roots.AddUnique(Plugin->GetMountedAssetPath());
                Update->ContentDirectories.AddUnique(FPaths::ConvertRelativePathToFull(Plugin->GetContentDir()));
            }
        AssetRegistry().ScanPathsSynchronous(Roots, true);
        FARFilter Filter;
        for (const FString& Root : Roots) Filter.PackagePaths.Add(FName(*Root));
        Filter.bRecursivePaths = true;
        if (!AssetRegistry().GetAssets(Filter, Update->Assets)) Update->SnapshotErrors.Add(TEXT("AssetRegistry could not enumerate all project roots."));
        Update->Assets.Sort([](const FAssetData& A, const FAssetData& B) { return A.GetObjectPathString() < B.GetObjectPathString(); });
        for (const FAssetData& Asset : Update->Assets) Update->AssetPaths.Add(Asset.GetObjectPathString());
        Update->bRegistryReady = true;
    }
    const double Started = FPlatformTime::Seconds();
    int32 Batch = 0;
    const TArray<FAssetData>& Work = Update->bRechecking ? Update->RecheckAssets : Update->Assets;
    int32& Next = Update->bRechecking ? Update->NextRecheckAsset : Update->NextAsset;
    while (Next < Work.Num() && Batch++ < 4 && FPlatformTime::Seconds() - Started < 0.008)
    {
        const FAssetData& Asset = Work[Next++];
        TSharedPtr<FJsonObject> Summary = AssetSummaryJson(Asset);
        FString SnapshotError;
        auto AssetSnapshot = FProjectKnowledgeService::ReadCachedAssetSnapshot(Asset.GetObjectPathString(), SnapshotError);
        if (!AssetSnapshot.IsValid()) AssetSnapshot = FProjectKnowledgeService::CaptureAssetSnapshot(Asset.GetObjectPathString(), SnapshotError);
        if (!AssetSnapshot.IsValid())
        {
            Update->SnapshotErrors.Add(Asset.GetObjectPathString() + TEXT(": ") + SnapshotError);
            Summary->SetStringField(TEXT("snapshotError"), SnapshotError);
        }
        else
        {
            // 复读成功后清理此资产先前的瞬时读取错误，持续失败仍保留具体路径。
            Update->SnapshotErrors.RemoveAll([&Asset](const FString& Message) { return Message.StartsWith(Asset.GetObjectPathString() + TEXT(": ")); });
            Summary->SetStringField(TEXT("snapshotFingerprint"), AssetSnapshot->GetStringField(TEXT("fingerprint")));
            Summary->SetStringField(TEXT("snapshotCoverage"), AssetSnapshot->GetObjectField(TEXT("coverage"))->GetStringField(TEXT("status")));
        }
        FString PackageFile;
        if (FPackageName::DoesPackageExist(Asset.PackageName.ToString(), &PackageFile))
        {
            Summary->SetStringField(TEXT("packageFile"), FPaths::ConvertRelativePathToFull(PackageFile));
            Summary->SetStringField(TEXT("packageTimestamp"), IFileManager::Get().GetTimeStamp(*PackageFile).ToIso8601());
            Summary->SetNumberField(TEXT("packageSize"), IFileManager::Get().FileSize(*PackageFile));
        }
        if (Update->bRechecking)
        {
            const int32 OriginalIndex = Update->Assets.IndexOfByPredicate([&Asset](const FAssetData& Item) { return Item.GetObjectPathString() == Asset.GetObjectPathString(); });
            if (Update->Summaries.IsValidIndex(OriginalIndex)) Update->Summaries[OriginalIndex] = MakeShared<FJsonValueObject>(Summary);
        }
        else Update->Summaries.Add(MakeShared<FJsonValueObject>(Summary));
    }
    if (const TSharedPtr<SNotificationItem> Notification = Update->Notification.Pin())
        Notification->SetText(FText::Format(Update->bRechecking ? LOCTEXT("KnowledgeRecheckProgress", "正在复核变化的资产快照：{0}/{1}") : LOCTEXT("KnowledgeAssetsProgress", "正在生成资产快照：{0}/{1}"), Next, Work.Num()));
    if (Next < Work.Num()) return true;
    // 后续加载可能更新较早资产的登记表/依赖；排空一帧事件，再限轮数 live 复读失效项。
    // 真正的用户修改同样重新采集，持续变化则由最终完整性检查明确失败，不能直接清 stale。
    if (!Update->bWaitingForStability) { Update->bWaitingForStability = true; return true; }
    if (Update->RecheckRounds < 3)
    {
        TArray<FAssetData> Pending;
        for (const FString& Path : FProjectKnowledgeService::GetStaleAssetSnapshotPaths())
            if (Update->AssetPaths.Contains(Path))
            {
                const FAssetData Data = AssetRegistry().GetAssetByObjectPath(FSoftObjectPath(Path));
                if (Data.IsValid()) Pending.Add(Data);
            }
        if (!Pending.IsEmpty())
        {
            Update->RecheckAssets = MoveTemp(Pending); Update->NextRecheckAsset = 0; ++Update->RecheckRounds;
            Update->bRechecking = true; Update->bWaitingForStability = false; return true;
        }
    }
    Update->bFinalizing = true;
    Update->DiskCoverage = DiskPackageCoverage(Update->ContentDirectories, Update->Summaries);
    Update->ExcludedPackageCount = Update->DiskCoverage->GetArrayField(TEXT("excludedPackages")).Num();
    FString IndexError;
    if (!FProjectKnowledgeService::EndAssetSnapshotScan(Update->AssetPaths, Update->SnapshotErrors, true, IndexError, Update->DiskCoverage)) Update->SnapshotErrors.Add(IndexError);
    KnowledgeTicker.Reset();
    TSharedPtr<FJsonObject> Snapshot = MakeOk();
    Snapshot->SetStringField(TEXT("projectRoot"), FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
    Snapshot->SetNumberField(TEXT("assetCount"), Update->Summaries.Num());
    Snapshot->SetArrayField(TEXT("assets"), MoveTemp(Update->Summaries));
    Snapshot->SetStringField(TEXT("detailPolicy"), TEXT("One snapshot per project asset in UE/asset_snapshots; read_asset_snapshot provides paged cached evidence; asset_snapshot refreshes live evidence."));
    for (const TCHAR* Key : {TEXT("diskPackageCount"), TEXT("registeredPackageCount"), TEXT("excludedPackages")})
        Snapshot->SetField(Key, Update->DiskCoverage->TryGetField(Key));
    Snapshot->SetBoolField(TEXT("scanComplete"), true);
    Snapshot->SetBoolField(TEXT("captureComplete"), Update->SnapshotErrors.IsEmpty());
    Snapshot->SetBoolField(TEXT("complete"), Update->SnapshotErrors.IsEmpty() && Update->ExcludedPackageCount == 0);
    Snapshot->SetArrayField(TEXT("snapshotErrors"), StringArrayToJson(Update->SnapshotErrors));
    const FString Root = FProjectKnowledgeService::GetCacheDirectory();
    if (const TSharedPtr<SNotificationItem> Notification = Update->Notification.Pin())
        Notification->SetText(LOCTEXT("KnowledgeBuilding", "正在后台更新项目图谱与知识记忆…"));
    const TWeakPtr<FProjectKnowledgeUpdate, ESPMode::ThreadSafe> WeakUpdate = Update;
    Update->ExportFuture = Async(EAsyncExecution::Thread, [this, WeakUpdate, Snapshot = MoveTemp(Snapshot), Root]
    {
        const auto Current = WeakUpdate.Pin();
        if (!Current.IsValid()) return;
        FString Text;
        FJsonSerializer::Serialize(Snapshot.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text));
        const FString Registry = FPaths::Combine(Root, TEXT("UE/asset_registry"));
        IFileManager::Get().MakeDirectory(*Registry, true);
        const bool bSaved = !Current->Cancelled.load() && FFileHelper::SaveStringToFile(Text, *FPaths::Combine(Registry, TEXT("assets.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
        if (bSaved)
        {
            // 只清理旧格式 IR；逐资产快照保留并作为当前全量图谱的详细输入。
            for (const TCHAR* DetailDir : {TEXT("UE/blueprint_ir"), TEXT("UE/material_ir")})
            {
                const FString Directory = FPaths::Combine(Root, DetailDir);
                TArray<FString> Files;
                IFileManager::Get().FindFiles(Files, *FPaths::Combine(Directory, TEXT("*.json")), true, false);
                for (const FString& File : Files) IFileManager::Get().Delete(*FPaths::Combine(Directory, File), false, true);
            }
        }
        AsyncTask(ENamedThreads::GameThread, [this, WeakUpdate, bSaved]
        {
            const auto Current = WeakUpdate.Pin();
            if (!Current.IsValid()) return;
            if (Current->Cancelled.load()) { if (KnowledgeUpdate == Current) KnowledgeUpdate.Reset(); return; }
            if (!bSaved)
            {
                Current->bFinished = true;
                Current->CompletionError = TEXT("Could not write the plugin Cache directory.");
                if (const auto Notification = Current->Notification.Pin())
                {
                    Notification->SetText(LOCTEXT("KnowledgeSaveFailed", "项目知识更新失败：无法写入插件 Cache 目录"));
                    Notification->SetCompletionState(SNotificationItem::CS_Fail);
                    Notification->ExpireAndFadeout();
                }
                if (KnowledgeUpdate == Current) KnowledgeUpdate.Reset();
                return;
            }
            Current->WorkerRequest = FProjectKnowledgeService::Execute(TEXT("project_update"), MakeShared<FJsonObject>(), nullptr,
                [this, WeakUpdate](bool bSuccess, TSharedPtr<FJsonObject> Result)
                {
                    const auto Active = WeakUpdate.Pin();
                    if (!Active.IsValid()) return;
                    Active->bFinished = true;
                    double IndexedSnapshots = 0;
                    if (bSuccess && (!Result.IsValid() || !Result->TryGetNumberField(TEXT("assetSnapshotCount"), IndexedSnapshots) || IndexedSnapshots != Active->Assets.Num()))
                    {
                        bSuccess = false;
                        Active->SnapshotErrors.Add(TEXT("Graph build did not accept every asset snapshot; inspect the snapshot index errors and retry."));
                    }
                    bSuccess = bSuccess && Active->SnapshotErrors.IsEmpty();
                    Active->bSucceeded = bSuccess;
                    if (Result.IsValid()) Result->TryGetStringField(TEXT("error"), Active->CompletionError);
                    if (!Active->SnapshotErrors.IsEmpty()) Active->CompletionError = FString::Printf(TEXT("%d assets could not be snapshotted: %s"), Active->SnapshotErrors.Num(), *Active->SnapshotErrors[0]);
                    if (const auto Notification = Active->Notification.Pin())
                    {
                        FString Error;
                        if (Result.IsValid()) Result->TryGetStringField(TEXT("error"), Error);
                        if (!Active->CompletionError.IsEmpty()) Error = Active->CompletionError;
                        // 有未登记包时明确显示部分覆盖；有效资产快照与图谱仍可继续查询。
                        Notification->SetText(bSuccess
                            ? (Active->ExcludedPackageCount == 0 ? LOCTEXT("KnowledgeReady", "全项目资产快照、图谱与知识记忆已更新")
                                : FText::Format(LOCTEXT("KnowledgeExcludedPackages", "图谱已更新：{0} 份资产快照；{1} 个包无法登记，详情见缓存清单"), Active->Assets.Num(), Active->ExcludedPackageCount))
                            : FText::FromString(TEXT("项目知识更新失败：") + Error.Left(240)));
                        Notification->SetCompletionState(bSuccess && Active->ExcludedPackageCount == 0 ? SNotificationItem::CS_Success : SNotificationItem::CS_Fail);
                        Notification->ExpireAndFadeout();
                    }
                    if (KnowledgeUpdate == Active) KnowledgeUpdate.Reset();
                });
        });
    });
    return false;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::DescribeBlueprintSnapshot(UBlueprint* Blueprint)
{
    // 缓存读取使用无分页的同源 IR，普通取证接口继续限制单次节点数量。
    return BlueprintIrJson(Blueprint, Blueprint->GetPathName());
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::DescribeMaterialSnapshot(UMaterial* Material)
{
    TSharedPtr<FJsonObject> Result = MaterialIrJson(Material, Material->GetPathName());
    auto DescribeInput = [](const FExpressionInput* Input)
    {
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        if (!Input) return Json;
        Json->SetStringField(TEXT("expression"), Input->Expression ? Input->Expression->GetPathName() : FString());
        Json->SetNumberField(TEXT("outputIndex"), Input->OutputIndex); Json->SetNumberField(TEXT("mask"), Input->Mask);
        Json->SetNumberField(TEXT("maskR"), Input->MaskR); Json->SetNumberField(TEXT("maskG"), Input->MaskG);
        Json->SetNumberField(TEXT("maskB"), Input->MaskB); Json->SetNumberField(TEXT("maskA"), Input->MaskA); return Json;
    };
    TArray<TSharedPtr<FJsonValue>> Expressions;
    // 表达式输入、输出与资产引用均保留精确定位，未知内部字段仍由 coverage 明示。
    for (UMaterialExpression* Expression : Material->GetExpressions())
    {
        if (!Expression) continue;
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("name"), Expression->GetName()); Json->SetStringField(TEXT("objectPath"), Expression->GetPathName());
        Json->SetStringField(TEXT("class"), Expression->GetClass()->GetPathName());
        Json->SetStringField(TEXT("guid"), Expression->MaterialExpressionGuid.ToString());
        Json->SetObjectField(TEXT("properties"), ExportEditableObjectDefaults(Expression));
        TArray<TSharedPtr<FJsonValue>> Inputs, Outputs;
        for (int32 I = 0; I < Expression->CountInputs(); ++I)
        {
            const auto Input = DescribeInput(Expression->GetInput(I)); Input->SetStringField(TEXT("name"), Expression->GetInputName(I).ToString());
            Input->SetNumberField(TEXT("index"), I); Inputs.Add(MakeShared<FJsonValueObject>(Input));
        }
        for (const FExpressionOutput& Output : Expression->GetOutputs())
        {
            const auto JsonOutput = MakeShared<FJsonObject>(); JsonOutput->SetStringField(TEXT("name"), Output.OutputName.ToString());
            JsonOutput->SetNumberField(TEXT("mask"), Output.Mask); JsonOutput->SetNumberField(TEXT("maskR"), Output.MaskR);
            JsonOutput->SetNumberField(TEXT("maskG"), Output.MaskG); JsonOutput->SetNumberField(TEXT("maskB"), Output.MaskB); JsonOutput->SetNumberField(TEXT("maskA"), Output.MaskA);
            Outputs.Add(MakeShared<FJsonValueObject>(JsonOutput));
        }
        Json->SetArrayField(TEXT("inputs"), Inputs); Json->SetArrayField(TEXT("outputs"), Outputs);
        Expressions.Add(MakeShared<FJsonValueObject>(Json));
    }
    TSharedPtr<FJsonObject> Outputs = MakeShared<FJsonObject>();
    for (int32 I = 0; I < MP_MAX; ++I)
        if (const FExpressionInput* Input = Material->GetExpressionInputForProperty(static_cast<EMaterialProperty>(I)))
            Outputs->SetObjectField(LexToString(I), DescribeInput(Input));
    Result->SetArrayField(TEXT("expressions"), Expressions); Result->SetObjectField(TEXT("materialOutputs"), Outputs);
    return Result;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::DescribeBlueprint(UBlueprint* Blueprint, const TSharedPtr<FJsonObject>& Arguments)
{
    // 分页复用节点/引脚读取器，输出精确连线和默认值，同时限制单次结果规模。
    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetStringField(TEXT("assetPath"), Blueprint->GetPathName());
    Result->SetStringField(TEXT("parentClass"), ClassPathOrEmpty(Blueprint->ParentClass));
    Result->SetStringField(TEXT("generatedClass"), ClassPathOrEmpty(Blueprint->GeneratedClass));
    FString GraphName;
    if (Arguments->HasField(TEXT("graphName")) && !Arguments->TryGetStringField(TEXT("graphName"), GraphName))
    {
        Result->SetStringField(TEXT("error"), TEXT("graphName must be a string matching a reflected graph name."));
        return Result;
    }
    double OffsetValue = 0, LimitValue = 80;
    if ((Arguments->HasField(TEXT("nodeOffset")) && !Arguments->TryGetNumberField(TEXT("nodeOffset"), OffsetValue)) ||
        (Arguments->HasField(TEXT("maxNodes")) && !Arguments->TryGetNumberField(TEXT("maxNodes"), LimitValue)) ||
        OffsetValue < 0 || OffsetValue > 1000000 || LimitValue < 1 || LimitValue > 200 ||
        OffsetValue != FMath::FloorToDouble(OffsetValue) || LimitValue != FMath::FloorToDouble(LimitValue))
    {
        Result->SetStringField(TEXT("error"), TEXT("nodeOffset must be a non-negative integer; maxNodes must be an integer in 1..200."));
        return Result;
    }
    TArray<UEdGraph*> AllGraphs;
    for (UEdGraph* Graph : Blueprint->FunctionGraphs) AllGraphs.Add(Graph);
    for (UEdGraph* Graph : Blueprint->UbergraphPages) AllGraphs.Add(Graph);
    for (UEdGraph* Graph : Blueprint->MacroGraphs) AllGraphs.Add(Graph);
    TArray<TSharedPtr<FJsonValue>> Graphs;
    int32 NodeIndex = 0, Emitted = 0;
    for (UEdGraph* Graph : AllGraphs)
    {
        if (!Graph) continue;
        TSharedPtr<FJsonObject> GraphJson = MakeShared<FJsonObject>();
        GraphJson->SetStringField(TEXT("name"), Graph->GetName());
        GraphJson->SetStringField(TEXT("path"), Graph->GetPathName());
        GraphJson->SetNumberField(TEXT("nodeCount"), Graph->Nodes.Num());
        if (GraphName.IsEmpty() || GraphName == Graph->GetName())
        {
            TArray<TSharedPtr<FJsonValue>> Nodes;
            for (const UEdGraphNode* Node : Graph->Nodes)
            {
                if (!Node) continue;
                const int32 CurrentIndex = NodeIndex++;
                if (CurrentIndex < OffsetValue || Emitted >= LimitValue) continue;
                Nodes.Add(MakeShared<FJsonValueObject>(NodeJson(Node)));
                ++Emitted;
            }
            GraphJson->SetArrayField(TEXT("nodes"), Nodes);
        }
        Graphs.Add(MakeShared<FJsonValueObject>(GraphJson));
    }
    Result->SetArrayField(TEXT("graphs"), Graphs);
    Result->SetNumberField(TEXT("nodeOffset"), OffsetValue);
    Result->SetNumberField(TEXT("nextNodeOffset"), OffsetValue + Emitted);
    Result->SetNumberField(TEXT("matchingNodeCount"), NodeIndex);
    Result->SetBoolField(TEXT("truncated"), OffsetValue + Emitted < NodeIndex);
    return Result;
}

void FDSHUnrealBridgeKnowledgeModule::RegisterConsoleCommands()
{
    IConsoleManager& ConsoleManager = IConsoleManager::Get();
    ConsoleCommands.Add(ConsoleManager.RegisterConsoleCommand(
        TEXT("DSHUnrealBridge.Knowledge.ExportAll"),
        TEXT("Export read-only Blueprint, asset registry, and material summaries to the plugin Cache/UE directory."),
        FConsoleCommandWithArgsDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::HandleExportAllCommand),
        ECVF_Default));

    ConsoleCommands.Add(ConsoleManager.RegisterConsoleCommand(
        TEXT("DSHUnrealBridge.Knowledge.ExportBlueprint"),
        TEXT("Export one Blueprint summary. Usage: DSHUnrealBridge.Knowledge.ExportBlueprint /Game/Path/BP_Name"),
        FConsoleCommandWithArgsDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::HandleExportBlueprintCommand),
        ECVF_Default));

    ConsoleCommands.Add(ConsoleManager.RegisterConsoleCommand(
        TEXT("DSHUnrealBridge.Knowledge.ExportAssets"),
        TEXT("Export AssetRegistry summary to the plugin Cache/UE/asset_registry/assets.json."),
        FConsoleCommandWithArgsDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::HandleExportAssetsCommand),
        ECVF_Default));

    ConsoleCommands.Add(ConsoleManager.RegisterConsoleCommand(
        TEXT("DSHUnrealBridge.Knowledge.ExportMaterials"),
        TEXT("Export material summaries to the plugin Cache/UE/material_ir."),
        FConsoleCommandWithArgsDelegate::CreateRaw(this, &FDSHUnrealBridgeKnowledgeModule::HandleExportMaterialsCommand),
        ECVF_Default));
}

void FDSHUnrealBridgeKnowledgeModule::UnregisterConsoleCommands()
{
    IConsoleManager& ConsoleManager = IConsoleManager::Get();
    for (IConsoleObject* Command : ConsoleCommands)
    {
        if (Command)
        {
            ConsoleManager.UnregisterConsoleObject(Command);
        }
    }
    ConsoleCommands.Reset();
}

void FDSHUnrealBridgeKnowledgeModule::HandleExportAllCommand(const TArray<FString>& Args)
{
    UE_LOG(LogTemp, Display, TEXT("%s"), *JsonToString(ExportAll()));
}

void FDSHUnrealBridgeKnowledgeModule::HandleExportBlueprintCommand(const TArray<FString>& Args)
{
    if (Args.Num() < 1)
    {
        UE_LOG(LogTemp, Warning, TEXT("Usage: DSHUnrealBridge.Knowledge.ExportBlueprint /Game/Path/BP_Name"));
        return;
    }
    UE_LOG(LogTemp, Display, TEXT("%s"), *JsonToString(ExportBlueprint(Args[0])));
}

void FDSHUnrealBridgeKnowledgeModule::HandleExportAssetsCommand(const TArray<FString>& Args)
{
    UE_LOG(LogTemp, Display, TEXT("%s"), *JsonToString(ExportAssets()));
}

void FDSHUnrealBridgeKnowledgeModule::HandleExportMaterialsCommand(const TArray<FString>& Args)
{
    UE_LOG(LogTemp, Display, TEXT("%s"), *JsonToString(ExportAllMaterials()));
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::ExportAll()
{
    TSharedPtr<FJsonObject> Json = MakeOk();
    TArray<TSharedPtr<FJsonValue>> Warnings;

    TSharedPtr<FJsonObject> Assets = ExportAssets();
    TSharedPtr<FJsonObject> Blueprints = ExportAllBlueprints();
    TSharedPtr<FJsonObject> Materials = ExportAllMaterials();

    Json->SetObjectField(TEXT("assets"), Assets);
    Json->SetObjectField(TEXT("blueprints"), Blueprints);
    Json->SetObjectField(TEXT("materials"), Materials);

    auto AppendWarnings = [&Warnings](const TSharedPtr<FJsonObject>& Result)
    {
        const TArray<TSharedPtr<FJsonValue>>* SourceWarnings = nullptr;
        if (Result.IsValid() && Result->TryGetArrayField(TEXT("warnings"), SourceWarnings) && SourceWarnings)
        {
            Warnings.Append(*SourceWarnings);
        }
    };

    AppendWarnings(Assets);
    AppendWarnings(Blueprints);
    AppendWarnings(Materials);
    Json->SetArrayField(TEXT("warnings"), Warnings);
    return Json;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::ExportAssets()
{
    TSharedPtr<FJsonObject> Json = MakeOk();
    // 身份标记避免把连同插件复制来的旧项目资产当成当前项目证据。
    Json->SetStringField(TEXT("projectRoot"), FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
    TArray<TSharedPtr<FJsonValue>> Warnings;
    TArray<TSharedPtr<FJsonValue>> Assets;
    TMap<FString, int32> ClassCounts;

    FARFilter Filter;
    Filter.PackagePaths.Add(FName(TEXT("/Game")));
    Filter.bRecursivePaths = true;

    TArray<FAssetData> AssetDataList;
    if (!AssetRegistry().GetAssets(Filter, AssetDataList))
    {
        AddWarning(Warnings, TEXT("AssetRegistry GetAssets returned false."));
    }

    for (const FAssetData& AssetData : AssetDataList)
    {
        Assets.Add(MakeShared<FJsonValueObject>(AssetSummaryJson(AssetData)));
        ClassCounts.FindOrAdd(AssetData.AssetClassPath.ToString()) += 1;
    }

    TSharedPtr<FJsonObject> ClassCountsJson = MakeShared<FJsonObject>();
    for (const TPair<FString, int32>& Pair : ClassCounts)
    {
        ClassCountsJson->SetNumberField(Pair.Key, Pair.Value);
    }

    Json->SetArrayField(TEXT("assets"), Assets);
    Json->SetNumberField(TEXT("assetCount"), Assets.Num());
    Json->SetObjectField(TEXT("classCounts"), ClassCountsJson);
    Json->SetArrayField(TEXT("warnings"), Warnings);

    FString OutputPath;
    SaveJsonFile(CacheRoot(AssetRegistryCacheDirName), TEXT("assets.json"), Json, OutputPath, Warnings);
    Json->SetStringField(TEXT("outputPath"), OutputPath);
    Json->SetArrayField(TEXT("warnings"), Warnings);
    return Json;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::ExportAllBlueprints()
{
    TSharedPtr<FJsonObject> Json = MakeOk();
    TArray<TSharedPtr<FJsonValue>> Warnings;
    TArray<TSharedPtr<FJsonValue>> Outputs;

    TArray<FAssetData> BlueprintAssets;
    if (!GetAssetsByClass(UBlueprint::StaticClass(), BlueprintAssets))
    {
        AddWarning(Warnings, TEXT("AssetRegistry failed to query Blueprint assets."));
    }

    for (const FAssetData& AssetData : BlueprintAssets)
    {
        TSharedPtr<FJsonObject> Result = ExportBlueprint(AssetData.GetObjectPathString());
        Outputs.Add(MakeShared<FJsonValueObject>(Result));
        const TArray<TSharedPtr<FJsonValue>>* ResultWarnings = nullptr;
        if (Result->TryGetArrayField(TEXT("warnings"), ResultWarnings) && ResultWarnings)
        {
            Warnings.Append(*ResultWarnings);
        }
    }

    Json->SetNumberField(TEXT("exportedCount"), Outputs.Num());
    Json->SetArrayField(TEXT("outputs"), Outputs);
    Json->SetArrayField(TEXT("warnings"), Warnings);
    return Json;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::ExportBlueprint(const FString& AssetPath)
{
    TArray<TSharedPtr<FJsonValue>> Warnings;
    UObject* Object = LoadAssetObject(AssetPath, Warnings);
    UBlueprint* Blueprint = Cast<UBlueprint>(Object);
    if (!Blueprint)
    {
        FString ClassName = Object ? Object->GetClass()->GetPathName() : TEXT("<null>");
        AddWarning(Warnings, FString::Printf(TEXT("Asset is not a UBlueprint: %s (%s)"), *AssetPath, *ClassName));
        TSharedPtr<FJsonObject> Json = MakeOk();
        Json->SetBoolField(TEXT("success"), false);
        Json->SetStringField(TEXT("assetPath"), AssetPath);
        Json->SetArrayField(TEXT("warnings"), Warnings);
        return Json;
    }

    TSharedPtr<FJsonObject> Ir = BlueprintIrJson(Blueprint, Blueprint->GetPathName());
    FString OutputPath;
    const bool bSaved = SaveJsonFile(
        CacheRoot(BlueprintCacheDirName),
        SanitizedFileName(Blueprint->GetPathName()) + TEXT(".json"),
        Ir,
        OutputPath,
        Warnings);

    TSharedPtr<FJsonObject> Json = MakeOk();
    Json->SetBoolField(TEXT("success"), bSaved);
    Json->SetStringField(TEXT("assetPath"), Blueprint->GetPathName());
    Json->SetStringField(TEXT("outputPath"), OutputPath);
    Json->SetObjectField(TEXT("blueprint"), Ir);
    Json->SetArrayField(TEXT("warnings"), Warnings);
    return Json;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::ExportAllMaterials()
{
    TSharedPtr<FJsonObject> Json = MakeOk();
    TArray<TSharedPtr<FJsonValue>> Warnings;
    TArray<TSharedPtr<FJsonValue>> Outputs;

    TArray<FAssetData> MaterialAssets;
    if (!GetAssetsByClass(UMaterial::StaticClass(), MaterialAssets))
    {
        AddWarning(Warnings, TEXT("AssetRegistry failed to query Material assets."));
    }

    for (const FAssetData& AssetData : MaterialAssets)
    {
        TSharedPtr<FJsonObject> Result = ExportMaterial(AssetData.GetObjectPathString());
        Outputs.Add(MakeShared<FJsonValueObject>(Result));
        const TArray<TSharedPtr<FJsonValue>>* ResultWarnings = nullptr;
        if (Result->TryGetArrayField(TEXT("warnings"), ResultWarnings) && ResultWarnings)
        {
            Warnings.Append(*ResultWarnings);
        }
    }

    Json->SetNumberField(TEXT("exportedCount"), Outputs.Num());
    Json->SetArrayField(TEXT("outputs"), Outputs);
    Json->SetArrayField(TEXT("warnings"), Warnings);
    return Json;
}

TSharedPtr<FJsonObject> FDSHUnrealBridgeKnowledgeModule::ExportMaterial(const FString& AssetPath)
{
    TArray<TSharedPtr<FJsonValue>> Warnings;
    UObject* Object = LoadAssetObject(AssetPath, Warnings);
    UMaterial* Material = Cast<UMaterial>(Object);
    if (!Material)
    {
        FString ClassName = Object ? Object->GetClass()->GetPathName() : TEXT("<null>");
        AddWarning(Warnings, FString::Printf(TEXT("Asset is not a UMaterial: %s (%s)"), *AssetPath, *ClassName));
        TSharedPtr<FJsonObject> Json = MakeOk();
        Json->SetBoolField(TEXT("success"), false);
        Json->SetStringField(TEXT("assetPath"), AssetPath);
        Json->SetArrayField(TEXT("warnings"), Warnings);
        return Json;
    }

    TSharedPtr<FJsonObject> Ir = MaterialIrJson(Material, Material->GetPathName());
    FString OutputPath;
    const bool bSaved = SaveJsonFile(
        CacheRoot(MaterialCacheDirName),
        SanitizedFileName(Material->GetPathName()) + TEXT(".json"),
        Ir,
        OutputPath,
        Warnings);

    TSharedPtr<FJsonObject> Json = MakeOk();
    Json->SetBoolField(TEXT("success"), bSaved);
    Json->SetStringField(TEXT("assetPath"), Material->GetPathName());
    Json->SetStringField(TEXT("outputPath"), OutputPath);
    Json->SetObjectField(TEXT("material"), Ir);
    Json->SetArrayField(TEXT("warnings"), Warnings);
    return Json;
}

#undef LOCTEXT_NAMESPACE

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"

// 等待菜单实际启动的分帧导出和隐藏 worker，期间不阻塞编辑器测试循环。
class FWaitProjectKnowledgeMenu : public IAutomationLatentCommand
{
public:
    FWaitProjectKnowledgeMenu(FDSHUnrealBridgeKnowledgeModule* InModule, FAutomationTestBase* InTest, TSharedPtr<FProjectKnowledgeUpdate, ESPMode::ThreadSafe> InUpdate)
        : Module(InModule), Test(InTest), TrackedUpdate(MoveTemp(InUpdate)), Notification(TrackedUpdate->Notification.Pin()), Started(FPlatformTime::Seconds()) {}

    virtual bool Update() override
    {
        if (Module->KnowledgeUpdate.IsValid())
        {
            if (FPlatformTime::Seconds() - Started > 1800.0)
            {
                Module->CancelKnowledgeUpdate();
                Test->AddError(TEXT("Full project snapshot and graph update did not finish within 1800 seconds."));
                return true;
            }
            return false;
        }
        Test->TestTrue(TEXT("Menu update completes successfully: ") + TrackedUpdate->CompletionError, TrackedUpdate->bFinished && TrackedUpdate->bSucceeded);
        if (Notification.IsValid()) Test->TestTrue(TEXT("Visible notification reports complete or explicitly partial coverage"),
            Notification->GetCompletionState() == (TrackedUpdate->ExcludedPackageCount == 0 ? SNotificationItem::CS_Success : SNotificationItem::CS_Fail));
        const FString Cache = FProjectKnowledgeService::GetCacheDirectory();
        Test->TestTrue(TEXT("Worker published plugin-local identity"), IFileManager::Get().FileExists(*FPaths::Combine(Cache, TEXT("identity.json"))));
        FString RegistryText;
        TSharedPtr<FJsonObject> Registry;
        const bool bRegistryRead = FFileHelper::LoadFileToString(RegistryText, *FPaths::Combine(Cache, TEXT("UE/asset_registry/assets.json"))) &&
            FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(RegistryText), Registry);
        Test->TestTrue(TEXT("Menu published readable UE registry"), bRegistryRead);
        if (bRegistryRead)
        {
            Test->TestEqual(TEXT("UE snapshot belongs to the current project"), Registry->GetStringField(TEXT("projectRoot")), FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()));
        }
        // 检查逐资产文件与完整枚举数量一致，不能只验证总索引存在。
        FString IndexText; TSharedPtr<FJsonObject> Index;
        const FString SnapshotDirectory = FPaths::Combine(Cache, TEXT("UE/asset_snapshots"));
        const bool bIndexRead = FFileHelper::LoadFileToString(IndexText, *FPaths::Combine(SnapshotDirectory, TEXT("index.json"))) && FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(IndexText), Index);
        Test->TestTrue(TEXT("Snapshot lookup index exists"), bIndexRead);
        if (bIndexRead)
        {
            Test->TestTrue(TEXT("Requested disk and registry scan finished"), Index->GetBoolField(TEXT("scanComplete")));
            Test->TestTrue(TEXT("Every registered asset captured successfully"), Index->GetBoolField(TEXT("captureComplete")));
            const auto& ExcludedPackages = Index->GetArrayField(TEXT("excludedPackages"));
            Test->TestEqual(TEXT("Coverage only claims complete when no package is excluded"), Index->GetBoolField(TEXT("complete")), ExcludedPackages.IsEmpty());
            const auto Entries = Index->GetObjectField(TEXT("assets"));
            Test->TestEqual(TEXT("Exactly one snapshot entry per enumerated project asset"), Entries->Values.Num(), TrackedUpdate->Assets.Num());
            int32 MissingFiles = 0;
            for (const auto& Pair : Entries->Values)
                if (!IFileManager::Get().FileExists(*FPaths::Combine(SnapshotDirectory, Pair.Value->AsObject()->GetStringField(TEXT("file"))))) ++MissingFiles;
            Test->TestEqual(TEXT("Every indexed asset has its own JSON file"), MissingFiles, 0);
            // 独立枚举真实磁盘包：每个文件必须由登记资产覆盖，或在两个清单中明确报告排除。
            TSet<FString> DiskFiles, RegisteredFiles, ExcludedFiles;
            for (const FString& Directory : TrackedUpdate->ContentDirectories)
                for (const TCHAR* Pattern : {TEXT("*.uasset"), TEXT("*.umap")})
                {
                    TArray<FString> Files; IFileManager::Get().FindFilesRecursive(Files, *Directory, Pattern, true, false);
                    for (const FString& File : Files) DiskFiles.Add(PackageFileIdentity(File));
                }
            if (bRegistryRead)
                for (const auto& Asset : Registry->GetArrayField(TEXT("assets")))
                {
                    FString File; if (Asset->AsObject()->TryGetStringField(TEXT("packageFile"), File)) RegisteredFiles.Add(PackageFileIdentity(File));
                }
            for (const auto& Value : ExcludedPackages)
            {
                const auto Package = Value->AsObject();
                const FString File = PackageFileIdentity(Package->GetStringField(TEXT("filePath")));
                Test->TestFalse(TEXT("Excluded package has no fabricated object identity"), Package->HasField(TEXT("assetPath")) || Package->HasField(TEXT("assetClass")));
                Test->TestFalse(TEXT("Exclusion reports its reason"), Package->GetStringField(TEXT("reason")).IsEmpty());
                Test->TestTrue(TEXT("Excluded package exists inside enumerated disk scope"), DiskFiles.Contains(File));
                Test->TestFalse(TEXT("Excluded package is not also registered"), RegisteredFiles.Contains(File));
                Test->TestFalse(TEXT("Excluded package listed once"), ExcludedFiles.Contains(File));
                ExcludedFiles.Add(File);
            }
            int32 RegisteredDiskPackages = 0, SilentOmissions = 0;
            for (const FString& File : DiskFiles)
            {
                if (RegisteredFiles.Contains(File)) ++RegisteredDiskPackages;
                else if (!ExcludedFiles.Contains(File)) ++SilentOmissions;
            }
            Test->TestEqual(TEXT("No disk package silently omitted"), SilentOmissions, 0);
            Test->TestEqual(TEXT("Disk package count matches actual filenames"), static_cast<int32>(Index->GetNumberField(TEXT("diskPackageCount"))), DiskFiles.Num());
            Test->TestEqual(TEXT("Registered package count is distinct disk packages"), static_cast<int32>(Index->GetNumberField(TEXT("registeredPackageCount"))), RegisteredDiskPackages);
            Test->TestEqual(TEXT("Registered plus excluded packages cover disk scope"), RegisteredDiskPackages + ExcludedFiles.Num(), DiskFiles.Num());
            if (bRegistryRead)
            {
                Test->TestEqual(TEXT("Registry and snapshot manifests agree on complete coverage"), Registry->GetBoolField(TEXT("complete")), Index->GetBoolField(TEXT("complete")));
                Test->TestEqual(TEXT("Registry and snapshot manifests agree on disk count"), Registry->GetNumberField(TEXT("diskPackageCount")), Index->GetNumberField(TEXT("diskPackageCount")));
                TSet<FString> RegistryExcluded;
                for (const auto& Value : Registry->GetArrayField(TEXT("excludedPackages"))) RegistryExcluded.Add(PackageFileIdentity(Value->AsObject()->GetStringField(TEXT("filePath"))));
                Test->TestEqual(TEXT("Both manifests report every excluded package"), RegistryExcluded.Num(), ExcludedFiles.Num());
                for (const FString& File : ExcludedFiles) Test->TestTrue(TEXT("Excluded package is present in registry manifest"), RegistryExcluded.Contains(File));
            }
            if (!TrackedUpdate->Assets.IsEmpty())
            {
                FString ReadError;
                const auto ReadableSnapshot = FProjectKnowledgeService::ReadCachedAssetSnapshot(TrackedUpdate->Assets[0].GetObjectPathString(), ReadError);
                Test->TestTrue(TEXT("Valid snapshots remain readable with package exclusions: ") + ReadError,
                    ReadableSnapshot.IsValid());
            }
        }
        return true;
    }

private:
    FDSHUnrealBridgeKnowledgeModule* Module;
    FAutomationTestBase* Test;
    TSharedPtr<FProjectKnowledgeUpdate, ESPMode::ThreadSafe> TrackedUpdate;
    TSharedPtr<SNotificationItem> Notification;
    double Started;
};

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectKnowledgeMenuTest, "DSHUnrealBridge.Knowledge.ToolsMenuUpdate", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectKnowledgeMenuTest::RunTest(const FString& Parameters)
{
    // 直接检查 Tools 菜单项并执行其绑定动作，先验证取消，再完成一次真实索引更新。
    FDSHUnrealBridgeKnowledgeModule& Module = FModuleManager::LoadModuleChecked<FDSHUnrealBridgeKnowledgeModule>(TEXT("DSHUnrealBridgeKnowledge"));
    if (Module.KnowledgeUpdate.IsValid()) { AddError(TEXT("A knowledge update is already running; do not interrupt it.")); return false; }
    Module.RegisterMenus();
    UToolMenu* Menu = UToolMenus::Get()->FindMenu(TEXT("LevelEditor.MainMenu.Tools"));
    if (!TestNotNull(TEXT("Tools menu exists"), Menu)) return false;
    FToolMenuSection* Section = Menu->FindSection(TEXT("ProjectKnowledge"));
    if (!TestNotNull(TEXT("Knowledge section exists"), Section)) return false;
    FToolMenuEntry* UpdateEntry = Section->FindEntry(TEXT("UpdateProjectKnowledge"));
    FToolMenuEntry* CancelEntry = Section->FindEntry(TEXT("CancelProjectKnowledge"));
    if (!TestNotNull(TEXT("Update button exists"), UpdateEntry) || !TestNotNull(TEXT("Cancel button exists"), CancelEntry)) return false;
    const FToolMenuContext Context;
    TestTrue(TEXT("Update button executes"), UpdateEntry->TryExecuteToolUIAction(Context));
    if (!TestTrue(TEXT("Update job starts"), Module.KnowledgeUpdate.IsValid())) return false;
    TestFalse(TEXT("Duplicate update disabled"), UpdateEntry->TryExecuteToolUIAction(Context));
    TestTrue(TEXT("Cancel button executes"), CancelEntry->TryExecuteToolUIAction(Context));
    TestFalse(TEXT("Cancelled scan released"), Module.KnowledgeUpdate.IsValid());
    TestFalse(TEXT("Cancel disabled without a task"), CancelEntry->TryExecuteToolUIAction(Context));
    TestTrue(TEXT("Update can restart after cancellation"), UpdateEntry->TryExecuteToolUIAction(Context));
    if (!TestTrue(TEXT("Second update starts"), Module.KnowledgeUpdate.IsValid())) return false;
    FAutomationTestFramework::Get().EnqueueLatentCommand(MakeShared<FWaitProjectKnowledgeMenu>(&Module, this, Module.KnowledgeUpdate));
    return true;
}
#endif

IMPLEMENT_MODULE(FDSHUnrealBridgeKnowledgeModule, DSHUnrealBridgeKnowledge)
