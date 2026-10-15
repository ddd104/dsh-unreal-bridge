#include "ProjectKnowledgeService.h"
#include "DSHUnrealBridgeKnowledgeModule.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/DataAsset.h"
#include "Engine/Texture.h"
#include "HAL/FileManager.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionFrac.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialInstance.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonWriter.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

namespace ProjectAssetSnapshots
{
    // 索引只保存定位及有效性，不在内存中长期保留所有蓝图的大型节点数组。
    TSharedPtr<FJsonObject> Index;
    TSet<FString> StalePackages;
    TSet<FString> PendingPackages;
    FString Session = FGuid::NewGuid().ToString();
    bool bScanning = false;
    bool bCapturing = false;
    FDelegateHandle ModifiedHandle, PropertyHandle, TransactionHandle, CompileHandle, AddedHandle, RemovedHandle, RenamedHandle, UpdatedHandle;

    IAssetRegistry& Registry() { return FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get(); }
    FString Directory() { return FPaths::Combine(FProjectKnowledgeService::GetCacheDirectory(), TEXT("UE/asset_snapshots")); }
    FString HashText(const FString& Text)
    {
        // 中文资产路径和文本必须按 UTF-8 哈希，ANSI 替换字符会造成不同资产/状态碰撞。
        const FTCHARToUTF8 Bytes(*Text);
        return FMD5::HashBytes(reinterpret_cast<const uint8*>(Bytes.Get()), Bytes.Length());
    }
    FString FileName(const FString& Path) { return HashText(Path) + TEXT(".json"); }
    FString FilePath(const FString& Path) { return FPaths::Combine(Directory(), FileName(Path)); }

    TSharedPtr<FJsonObject> Failure(const FString& Error)
    {
        TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("error"), Error); return Result;
    }

    FString Normalize(const FString& Path)
    {
        FString Result = Path;
        if (!Result.Contains(TEXT("."))) Result += TEXT(".") + FPackageName::GetShortName(Result);
        FString TopLevelPath, Subobject;
        const bool bSubobject = Result.Split(TEXT(":"), &TopLevelPath, &Subobject);
        // ExternalActor 的登记表身份含 :PersistentLevel；只允许真实登记资产，后续保持 opaque。
        const bool bValidObject = FPackageName::IsValidObjectPath(bSubobject ? TopLevelPath : Result) && (!bSubobject || !Subobject.IsEmpty());
        return !Result.Contains(TEXT("..")) && !Result.Contains(TEXT("\\")) &&
            !Result.Contains(TEXT("UEDPIE_")) && !Result.StartsWith(TEXT("/Temp/")) && bValidObject ? Result : FString();
    }

    TSharedPtr<FJsonObject> ReadJson(const FString& Path)
    {
        FString Text; TSharedPtr<FJsonObject> Json;
        if (FFileHelper::LoadFileToString(Text, *Path)) FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Json);
        return Json;
    }

    bool WriteJson(const FString& Path, const TSharedPtr<FJsonObject>& Json)
    {
        // 同目录临时文件原子替换，取消或磁盘写入失败不留下半份 JSON。
        FString Text;
        if (!FJsonSerializer::Serialize(Json.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text))) return false;
        IFileManager::Get().MakeDirectory(*FPaths::GetPath(Path), true);
        const FString Temporary = Path + TEXT(".writing");
        if (!FFileHelper::SaveStringToFile(Text, *Temporary, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM)) return false;
        const bool bSaved = IFileManager::Get().Move(*Path, *Temporary, true, true);
        if (!bSaved) IFileManager::Get().Delete(*Temporary);
        return bSaved;
    }

    TSharedPtr<FJsonObject> Entries()
    {
        if (!Index.IsValid())
        {
            Index = ReadJson(FPaths::Combine(Directory(), TEXT("index.json")));
            const FString Project = FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath());
            FString Recorded;
            if (!Index.IsValid() || !Index->TryGetStringField(TEXT("projectId"), Recorded) || Recorded != Project)
            {
                Index = MakeShared<FJsonObject>(); Index->SetNumberField(TEXT("schemaVersion"), 1);
                Index->SetStringField(TEXT("projectId"), Project); Index->SetBoolField(TEXT("complete"), false);
                Index->SetObjectField(TEXT("assets"), MakeShared<FJsonObject>());
            }
        }
        const TSharedPtr<FJsonObject>* Assets = nullptr;
        if (!Index->TryGetObjectField(TEXT("assets"), Assets)) { Index->SetObjectField(TEXT("assets"), MakeShared<FJsonObject>()); }
        return Index->GetObjectField(TEXT("assets"));
    }

    bool SaveIndex() { Entries(); return WriteJson(FPaths::Combine(Directory(), TEXT("index.json")), Index); }

    TSharedPtr<FJsonValue> Canonical(const TSharedPtr<FJsonValue>& Value)
    {
        // 对象键递归排序；不改变有语义顺序的数组，指纹与 JSON map 的迭代顺序无关。
        if (Value->Type == EJson::Object)
        {
            TSharedPtr<FJsonObject> Sorted = MakeShared<FJsonObject>();
            TArray<FString> Keys; for (const auto& Pair : Value->AsObject()->Values) Keys.Add(FString(*Pair.Key)); Keys.Sort();
            for (const FString& Key : Keys) Sorted->SetField(Key, Canonical(Value->AsObject()->TryGetField(Key)));
            return MakeShared<FJsonValueObject>(Sorted);
        }
        if (Value->Type == EJson::Array)
        {
            TArray<TSharedPtr<FJsonValue>> Values; for (const auto& Item : Value->AsArray()) Values.Add(Canonical(Item));
            return MakeShared<FJsonValueArray>(Values);
        }
        return Value;
    }

    FString Fingerprint(const TSharedPtr<FJsonObject>& Json)
    {
        FString Text; const auto Sorted = Canonical(MakeShared<FJsonValueObject>(Json))->AsObject();
        FJsonSerializer::Serialize(Sorted.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text));
        return HashText(Text);
    }

    TSharedPtr<FJsonValue> PropertyValue(const FProperty* Property, const void* Address, UObject* Owner, int32 Depth, bool& bOpaque)
    {
        // 容器完整落盘；无法结构化的特殊字段保留精确导出文本并明确标为 opaque。
        if (Depth < 32)
        {
            if (const FBoolProperty* Bool = CastField<FBoolProperty>(Property)) return MakeShared<FJsonValueBoolean>(Bool->GetPropertyValue(Address));
            if (const FNumericProperty* Numeric = CastField<FNumericProperty>(Property))
            {
                const FString Decimal = Numeric->GetNumericPropertyValueToString(Address);
                const double Value = FCString::Atod(*Decimal);
                if (FMath::IsFinite(Value) && (!Numeric->IsInteger() || FMath::Abs(Value) <= 9007199254740991.0)) return MakeShared<FJsonValueNumber>(Value);
                return MakeShared<FJsonValueString>(Decimal);
            }
            if (const FStrProperty* String = CastField<FStrProperty>(Property)) return MakeShared<FJsonValueString>(String->GetPropertyValue(Address));
            if (const FNameProperty* Name = CastField<FNameProperty>(Property)) return MakeShared<FJsonValueString>(Name->GetPropertyValue(Address).ToString());
            if (const FTextProperty* Text = CastField<FTextProperty>(Property)) return MakeShared<FJsonValueString>(Text->GetPropertyValue(Address).ToString());
            if (const FSoftObjectProperty* Soft = CastField<FSoftObjectProperty>(Property)) return MakeShared<FJsonValueString>(Soft->GetPropertyValue(Address).ToSoftObjectPath().ToString());
            if (const FObjectPropertyBase* Object = CastField<FObjectPropertyBase>(Property))
            {
                UObject* Reference = Object->GetObjectPropertyValue(Address);
                return Reference ? StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueString>(Reference->GetPathName())) : StaticCastSharedRef<FJsonValue>(MakeShared<FJsonValueNull>());
            }
            if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
            {
                FScriptArrayHelper Helper(Array, Address); TArray<TSharedPtr<FJsonValue>> Values;
                for (int32 I = 0; I < Helper.Num(); ++I) Values.Add(PropertyValue(Array->Inner, Helper.GetRawPtr(I), Owner, Depth + 1, bOpaque));
                return MakeShared<FJsonValueArray>(Values);
            }
            if (const FSetProperty* Set = CastField<FSetProperty>(Property))
            {
                FScriptSetHelper Helper(Set, Address); TArray<TSharedPtr<FJsonValue>> Values;
                for (int32 I = 0; I < Helper.GetMaxIndex(); ++I) if (Helper.IsValidIndex(I)) Values.Add(PropertyValue(Set->ElementProp, Helper.GetElementPtr(I), Owner, Depth + 1, bOpaque));
                return MakeShared<FJsonValueArray>(Values);
            }
            if (const FMapProperty* Map = CastField<FMapProperty>(Property))
            {
                FScriptMapHelper Helper(Map, Address); TArray<TSharedPtr<FJsonValue>> Values;
                for (int32 I = 0; I < Helper.GetMaxIndex(); ++I) if (Helper.IsValidIndex(I))
                {
                    TSharedPtr<FJsonObject> Pair = MakeShared<FJsonObject>();
                    Pair->SetField(TEXT("key"), PropertyValue(Map->KeyProp, Helper.GetKeyPtr(I), Owner, Depth + 1, bOpaque));
                    Pair->SetField(TEXT("value"), PropertyValue(Map->ValueProp, Helper.GetValuePtr(I), Owner, Depth + 1, bOpaque));
                    Values.Add(MakeShared<FJsonValueObject>(Pair));
                }
                return MakeShared<FJsonValueArray>(Values);
            }
            if (const FStructProperty* Struct = CastField<FStructProperty>(Property))
            {
                TSharedPtr<FJsonObject> Value = MakeShared<FJsonObject>();
                for (TFieldIterator<FProperty> It(Struct->Struct); It; ++It) Value->SetField(It->GetName(), PropertyValue(*It, It->ContainerPtrToValuePtr<void>(Address), Owner, Depth + 1, bOpaque));
                return MakeShared<FJsonValueObject>(Value);
            }
        }
        FString Text; Property->ExportTextItem_Direct(Text, Address, nullptr, Owner, PPF_None);
        bOpaque |= !CastField<FEnumProperty>(Property); return MakeShared<FJsonValueString>(Text);
    }

    TArray<TSharedPtr<FJsonValue>> Properties(UObject* Object)
    {
        TArray<TSharedPtr<FJsonValue>> Values;
        if (!Object) return Values;
        for (TFieldIterator<FProperty> It(Object->GetClass()); It; ++It)
        {
            FProperty* Property = *It;
            if (!Property->HasAnyPropertyFlags(CPF_Edit | CPF_BlueprintVisible) || Property->HasAnyPropertyFlags(CPF_Transient | CPF_Deprecated)) continue;
            TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
            Entry->SetStringField(TEXT("name"), Property->GetName()); Entry->SetStringField(TEXT("type"), Property->GetCPPType());
            Entry->SetStringField(TEXT("owner"), Property->GetOwnerStruct()->GetPathName());
            Entry->SetStringField(TEXT("propertyClass"), Property->GetClass()->GetName());
            Entry->SetStringField(TEXT("flags"), LexToString(static_cast<uint64>(Property->GetPropertyFlags())));
            Entry->SetBoolField(TEXT("inherited"), Property->GetOwnerClass() != Object->GetClass());
            Entry->SetBoolField(TEXT("editable"), !Property->HasAnyPropertyFlags(CPF_EditConst | CPF_DisableEditOnTemplate));
            const void* Address = Property->ContainerPtrToValuePtr<void>(Object);
            FString Export; Property->ExportTextItem_Direct(Export, Address, nullptr, Object, PPF_None);
            Entry->SetStringField(TEXT("exportText"), Export);
            bool bOpaque = false; Entry->SetField(TEXT("value"), PropertyValue(Property, Address, Object, 0, bOpaque));
            Entry->SetBoolField(TEXT("opaque"), bOpaque); Entry->SetBoolField(TEXT("truncated"), false);
            TSharedPtr<FJsonObject> Constraints = MakeShared<FJsonObject>();
            for (const TCHAR* Key : {TEXT("ClampMin"), TEXT("ClampMax"), TEXT("EditCondition"), TEXT("AllowedClasses"), TEXT("MustImplement")})
                if (Property->HasMetaData(Key)) Constraints->SetStringField(Key, Property->GetMetaData(Key));
            Entry->SetObjectField(TEXT("constraints"), Constraints);
            Values.Add(MakeShared<FJsonValueObject>(Entry));
        }
        return Values;
    }

    TSharedPtr<FJsonObject> MaterialInstance(UMaterialInstance* Instance)
    {
        // 参数身份包含层/混合关联与索引；有效值和本地 override 分别读取。
        TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
        Json->SetStringField(TEXT("parent"), Instance->Parent ? Instance->Parent->GetPathName() : FString());
        TArray<TSharedPtr<FJsonValue>> Parameters;
        for (int32 Type = 0; Type < 5; ++Type)
        {
            TArray<FMaterialParameterInfo> Infos; TArray<FGuid> Ids;
            if (Type == 0) Instance->GetAllScalarParameterInfo(Infos, Ids);
            if (Type == 1) Instance->GetAllVectorParameterInfo(Infos, Ids);
            if (Type == 2) Instance->GetAllTextureParameterInfo(Infos, Ids);
            if (Type == 3) Instance->GetAllStaticSwitchParameterInfo(Infos, Ids);
            if (Type == 4) Instance->GetAllStaticComponentMaskParameterInfo(Infos, Ids);
            for (int32 I = 0; I < Infos.Num(); ++I)
            {
                const FMaterialParameterInfo& Info = Infos[I];
                TSharedPtr<FJsonObject> Parameter = MakeShared<FJsonObject>();
                Parameter->SetStringField(TEXT("name"), Info.Name.ToString());
                Parameter->SetNumberField(TEXT("association"), static_cast<int32>(Info.Association)); Parameter->SetNumberField(TEXT("index"), Info.Index);
                if (Ids.IsValidIndex(I)) Parameter->SetStringField(TEXT("guid"), Ids[I].ToString());
                bool bOverridden = false, bFound = false;
                if (Type == 0)
                {
                    float Value = 0, Override = 0; bFound = Instance->GetScalarParameterValue(Info, Value); bOverridden = Instance->GetScalarParameterValue(Info, Override, true);
                    Parameter->SetStringField(TEXT("type"), TEXT("scalar")); Parameter->SetNumberField(TEXT("value"), Value);
                }
                if (Type == 1)
                {
                    FLinearColor Value, Override; bFound = Instance->GetVectorParameterValue(Info, Value); bOverridden = Instance->GetVectorParameterValue(Info, Override, true);
                    TSharedPtr<FJsonObject> Color = MakeShared<FJsonObject>(); Color->SetNumberField(TEXT("r"), Value.R); Color->SetNumberField(TEXT("g"), Value.G); Color->SetNumberField(TEXT("b"), Value.B); Color->SetNumberField(TEXT("a"), Value.A);
                    Parameter->SetStringField(TEXT("type"), TEXT("vector")); Parameter->SetObjectField(TEXT("value"), Color);
                }
                if (Type == 2)
                {
                    UTexture* Value = nullptr; UTexture* Override = nullptr; bFound = Instance->GetTextureParameterValue(Info, Value); bOverridden = Instance->GetTextureParameterValue(Info, Override, true);
                    Parameter->SetStringField(TEXT("type"), TEXT("texture")); Parameter->SetStringField(TEXT("value"), Value ? Value->GetPathName() : FString());
                }
                if (Type == 3)
                {
                    bool Value = false, Override = false; FGuid Id; bFound = Instance->GetStaticSwitchParameterValue(Info, Value, Id); bOverridden = Instance->GetStaticSwitchParameterValue(Info, Override, Id, true);
                    Parameter->SetStringField(TEXT("type"), TEXT("staticSwitch")); Parameter->SetBoolField(TEXT("value"), Value);
                }
                if (Type == 4)
                {
                    bool R = false, G = false, B = false, A = false, OR = false, OG = false, OB = false, OA = false; FGuid Id;
                    bFound = Instance->GetStaticComponentMaskParameterValue(Info, R, G, B, A, Id); bOverridden = Instance->GetStaticComponentMaskParameterValue(Info, OR, OG, OB, OA, Id, true);
                    TSharedPtr<FJsonObject> Mask = MakeShared<FJsonObject>(); Mask->SetBoolField(TEXT("r"), R); Mask->SetBoolField(TEXT("g"), G); Mask->SetBoolField(TEXT("b"), B); Mask->SetBoolField(TEXT("a"), A);
                    Parameter->SetStringField(TEXT("type"), TEXT("staticMask")); Parameter->SetObjectField(TEXT("value"), Mask);
                }
                Parameter->SetBoolField(TEXT("resolved"), bFound); Parameter->SetBoolField(TEXT("overridden"), bOverridden);
                Parameters.Add(MakeShared<FJsonValueObject>(Parameter));
            }
        }
        Parameters.Sort([](const auto& A, const auto& B) { return Fingerprint(A->AsObject()) < Fingerprint(B->AsObject()); });
        Json->SetArrayField(TEXT("parameters"), Parameters); return Json;
    }

    void InvalidatePackage(const FString& Package)
    {
        if (bCapturing || Package.IsEmpty() || Package.StartsWith(TEXT("/Temp/"))) return;
        StalePackages.Add(Package);
        // 编辑器启动会批量广播登记表事件；先合并包名，禁止每个事件同步重写整个索引。
        PendingPackages.Add(Package);
    }

    void ApplyInvalidations()
    {
        if (PendingPackages.IsEmpty()) return;
        // 父材质/父蓝图的变更沿包依赖传播，避免孙实例仍返回旧的有效参数。
        TSet<FString> AffectedPackages = MoveTemp(PendingPackages);
        PendingPackages.Reset();
        TSet<FString> AffectedPaths;
        bool bExpanded = true;
        while (bExpanded)
        {
            bExpanded = false;
            for (const auto& Pair : Entries()->Values)
            {
                const FString Path(*Pair.Key);
                if (AffectedPaths.Contains(Path)) continue;
                const TArray<TSharedPtr<FJsonValue>>* Dependencies = nullptr;
                bool bDependent = false;
                if (Pair.Value->AsObject()->TryGetArrayField(TEXT("dependencies"), Dependencies))
                    for (const auto& Dependency : *Dependencies) bDependent |= AffectedPackages.Contains(Dependency->AsString());
                FString OwningPackage; Pair.Value->AsObject()->TryGetStringField(TEXT("packageName"), OwningPackage);
                if (OwningPackage.IsEmpty()) OwningPackage = FPackageName::ObjectPathToPackageName(Path);
                if (AffectedPackages.Contains(OwningPackage) || bDependent)
                {
                    AffectedPaths.Add(Path);
                    if (!AffectedPackages.Contains(OwningPackage)) { AffectedPackages.Add(OwningPackage); bExpanded = true; }
                    bool bAlreadyStale = false; Pair.Value->AsObject()->TryGetBoolField(TEXT("stale"), bAlreadyStale);
                    Pair.Value->AsObject()->SetBoolField(TEXT("stale"), true);
                    if (!bAlreadyStale)
                    {
                        const auto Cached = ReadJson(FilePath(Path));
                        if (Cached.IsValid()) { Cached->SetBoolField(TEXT("stale"), true); WriteJson(FilePath(Path), Cached); }
                    }
                }
            }
        }
        if (!bScanning) SaveIndex();
    }

    void Removed(const FAssetData& Asset)
    {
        InvalidatePackage(Asset.PackageName.ToString());
        const FString Path = Asset.GetObjectPathString();
        Entries()->RemoveField(Path); IFileManager::Get().Delete(*FilePath(Path), false, true);
        if (!bScanning) SaveIndex();
    }
}

void FProjectKnowledgeService::InitializeAssetSnapshots()
{
    using namespace ProjectAssetSnapshots;
    if (ModifiedHandle.IsValid()) return;
    // 属性、结构、重编译、保存、重命名和删除事件使对应缓存失效；执行前仍会 live 复读。
    ModifiedHandle = FCoreUObjectDelegates::OnObjectModified.AddLambda([](UObject* Object) { if (Object) InvalidatePackage(Object->GetOutermost()->GetName()); });
    PropertyHandle = FCoreUObjectDelegates::OnObjectPropertyChanged.AddLambda([](UObject* Object, FPropertyChangedEvent&) { if (Object) InvalidatePackage(Object->GetOutermost()->GetName()); });
    TransactionHandle = FCoreUObjectDelegates::OnObjectTransacted.AddLambda([](UObject* Object, const FTransactionObjectEvent&) { if (Object) InvalidatePackage(Object->GetOutermost()->GetName()); });
    if (GEditor) CompileHandle = GEditor->OnBlueprintPreCompile().AddLambda([](UBlueprint* Blueprint) { if (Blueprint) InvalidatePackage(Blueprint->GetOutermost()->GetName()); });
    AddedHandle = Registry().OnAssetAdded().AddLambda([](const FAssetData& Asset)
    {
        // 初始磁盘发现不是资产修改；已有快照由包时间/大小和实际修改事件检查有效性。
        if (!Registry().IsLoadingAssets()) InvalidatePackage(Asset.PackageName.ToString());
    });
    UpdatedHandle = Registry().OnAssetUpdated().AddLambda([](const FAssetData& Asset) { InvalidatePackage(Asset.PackageName.ToString()); });
    RemovedHandle = Registry().OnAssetRemoved().AddStatic(&Removed);
    RenamedHandle = Registry().OnAssetRenamed().AddLambda([](const FAssetData& Asset, const FString& OldPath)
    {
        InvalidatePackage(FPackageName::ObjectPathToPackageName(OldPath));
        Entries()->RemoveField(OldPath); IFileManager::Get().Delete(*FilePath(OldPath), false, true);
        InvalidatePackage(Asset.PackageName.ToString()); if (!bScanning) SaveIndex();
    });
}

void FProjectKnowledgeService::ShutdownAssetSnapshots()
{
    using namespace ProjectAssetSnapshots;
    FCoreUObjectDelegates::OnObjectModified.Remove(ModifiedHandle); FCoreUObjectDelegates::OnObjectPropertyChanged.Remove(PropertyHandle);
    FCoreUObjectDelegates::OnObjectTransacted.Remove(TransactionHandle);
    if (GEditor) GEditor->OnBlueprintPreCompile().Remove(CompileHandle);
    if (FModuleManager::Get().IsModuleLoaded(TEXT("AssetRegistry")))
    {
        Registry().OnAssetAdded().Remove(AddedHandle); Registry().OnAssetUpdated().Remove(UpdatedHandle);
        Registry().OnAssetRemoved().Remove(RemovedHandle); Registry().OnAssetRenamed().Remove(RenamedHandle);
    }
    ModifiedHandle.Reset(); PropertyHandle.Reset(); AddedHandle.Reset(); UpdatedHandle.Reset(); RemovedHandle.Reset(); RenamedHandle.Reset();
    TransactionHandle.Reset(); CompileHandle.Reset();
    if (Index.IsValid() || !PendingPackages.IsEmpty()) { ApplyInvalidations(); if (Index.IsValid()) SaveIndex(); }
    Index.Reset(); StalePackages.Reset(); PendingPackages.Reset(); bScanning = false;
}

TSharedPtr<FJsonObject> FProjectKnowledgeService::CaptureAssetSnapshot(const FString& AssetPath, FString& Error)
{
    using namespace ProjectAssetSnapshots;
    check(IsInGameThread()); InitializeAssetSnapshots(); Error.Reset();
    if (!bScanning) ApplyInvalidations();
    const FString Path = Normalize(AssetPath);
    if (Path.IsEmpty()) { Error = TEXT("Expected a canonical saved asset path."); return nullptr; }
    const FAssetData Data = Registry().GetAssetByObjectPath(FSoftObjectPath(Path));
    if (!Data.IsValid()) { Error = TEXT("Asset was not found in AssetRegistry: ") + Path; return nullptr; }
    TGuardValue<bool> CaptureGuard(bCapturing, true);
    TSharedPtr<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetNumberField(TEXT("schemaVersion"), 1); Json->SetStringField(TEXT("capabilityRevision"), TEXT("ue58-asset-snapshot-v1"));
    Json->SetStringField(TEXT("projectId"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
    Json->SetStringField(TEXT("assetPath"), Path); Json->SetStringField(TEXT("assetClass"), Data.AssetClassPath.ToString());
    Json->SetStringField(TEXT("packageName"), Data.PackageName.ToString());
    TArray<FName> DependencyNames; Registry().GetDependencies(Data.PackageName, DependencyNames);
    TArray<FString> Dependencies; for (const FName& Name : DependencyNames) Dependencies.Add(Name.ToString()); Dependencies.Sort();
    TArray<TSharedPtr<FJsonValue>> DependencyJson; for (const FString& Dependency : Dependencies) DependencyJson.Add(MakeShared<FJsonValueString>(Dependency));
    Json->SetArrayField(TEXT("dependencies"), DependencyJson);
    // 保留项目原有断引用诊断；脚本包没有磁盘资产文件，不能当成丢失内容。
    TArray<TSharedPtr<FJsonValue>> UnresolvedDependencies;
    for (const FString& Dependency : Dependencies)
        if (!Dependency.StartsWith(TEXT("/Script/")) && !Dependency.StartsWith(TEXT("/Memory/")) &&
            !Dependency.StartsWith(TEXT("/Temp/")) && FPackageName::IsValidLongPackageName(Dependency) && !FPackageName::DoesPackageExist(Dependency))
            UnresolvedDependencies.Add(MakeShared<FJsonValueString>(Dependency));
    Json->SetArrayField(TEXT("unresolvedDependencies"), UnresolvedDependencies);
    TSharedPtr<FJsonObject> Tags = MakeShared<FJsonObject>();
    for (const auto Tag : Data.TagsAndValues) Tags->SetStringField(Tag.Key.ToString(), Tag.Value.AsString());
    Json->SetObjectField(TEXT("tags"), Tags);
    TSharedPtr<FJsonObject> Coverage = MakeShared<FJsonObject>(); Coverage->SetBoolField(TEXT("truncated"), false);
    Coverage->SetStringField(TEXT("status"), TEXT("opaque")); Coverage->SetStringField(TEXT("scope"), TEXT("AssetRegistry metadata and package dependencies only; no editing adapter."));
    UClass* Class = Data.GetClass(EResolveClass::Yes); UObject* Asset = nullptr;
    if (Class && (Class->IsChildOf(UBlueprint::StaticClass()) || Class->IsChildOf(UMaterialInterface::StaticClass()) || Class->IsChildOf(UDataAsset::StaticClass())))
    {
        Asset = Data.GetAsset();
        if (!Asset) { Error = TEXT("Failed to load supported asset: ") + Path; return nullptr; }
        if (UBlueprint* Blueprint = Cast<UBlueprint>(Asset))
        {
            Json->SetObjectField(TEXT("blueprint"), FDSHUnrealBridgeKnowledgeModule::DescribeBlueprintSnapshot(Blueprint));
            Json->SetArrayField(TEXT("properties"), Properties(Blueprint->GeneratedClass ? Blueprint->GeneratedClass->GetDefaultObject() : nullptr));
            Coverage->SetStringField(TEXT("status"), TEXT("partial")); Coverage->SetStringField(TEXT("scope"), TEXT("All graphs, GUIDs, nodes, pins, links, variables, component defaults and reflected class defaults. Node-specific opaque fields are not a lossless reconstruction format."));
            Coverage->SetBoolField(TEXT("defaultsAvailable"), Blueprint->GeneratedClass != nullptr);
        }
        else if (UMaterialInstance* Instance = Cast<UMaterialInstance>(Asset))
        {
            Json->SetObjectField(TEXT("materialInstance"), MaterialInstance(Instance));
            Json->SetArrayField(TEXT("properties"), Properties(Instance));
            Coverage->SetStringField(TEXT("status"), TEXT("partial")); Coverage->SetStringField(TEXT("scope"), TEXT("Scalar, vector, texture, static switch/mask parameters with effective values, overrides and layer identity. Other parameter kinds remain opaque."));
        }
        else if (UMaterial* Material = Cast<UMaterial>(Asset))
        {
            Json->SetObjectField(TEXT("material"), FDSHUnrealBridgeKnowledgeModule::DescribeMaterialSnapshot(Material));
            Json->SetArrayField(TEXT("properties"), Properties(Material));
            Coverage->SetStringField(TEXT("status"), TEXT("partial")); Coverage->SetStringField(TEXT("scope"), TEXT("Material settings, expressions, inputs and reflected defaults; unsupported expression internals remain opaque."));
        }
        else if (Cast<UDataAsset>(Asset))
        {
            Json->SetArrayField(TEXT("properties"), Properties(Asset));
            Coverage->SetStringField(TEXT("status"), TEXT("partial")); Coverage->SetStringField(TEXT("scope"), TEXT("All reflected editable properties and constraints; opaque fields are read-only until an explicit adapter supports them."));
        }
    }
    if (!UnresolvedDependencies.IsEmpty())
    {
        TArray<TSharedPtr<FJsonValue>> Warnings;
        Warnings.Add(MakeShared<FJsonValueString>(TEXT("One or more referenced content packages are missing on disk. Snapshot captures available live state; missing values are not proof that the original asset intentionally omitted them.")));
        Coverage->SetArrayField(TEXT("warnings"), Warnings);
    }
    Json->SetObjectField(TEXT("coverage"), Coverage); Json->SetBoolField(TEXT("truncated"), false);
    // 编辑状态指纹不包含采集时间、包脏标记、会话或磁盘时间戳。
    const auto State = MakeShared<FJsonObject>(); State->Values = Json->Values;
    State->RemoveField(TEXT("tags")); // 登记表标签会延迟刷新，不属于资产 live 编辑状态。
    Json->SetStringField(TEXT("fingerprint"), Fingerprint(State));
    Json->SetStringField(TEXT("capturedAt"), FDateTime::UtcNow().ToIso8601()); Json->SetStringField(TEXT("session"), Session);
    Json->SetBoolField(TEXT("packageDirty"), Asset && Asset->GetOutermost()->IsDirty()); Json->SetBoolField(TEXT("stale"), false);
    FString PackageFile;
    if (FPackageName::DoesPackageExist(Data.PackageName.ToString(), &PackageFile))
    {
        Json->SetStringField(TEXT("packageTimestamp"), IFileManager::Get().GetTimeStamp(*PackageFile).ToIso8601());
        Json->SetNumberField(TEXT("packageSize"), IFileManager::Get().FileSize(*PackageFile));
    }
    if (!WriteJson(FilePath(Path), Json)) { Error = TEXT("Could not persist asset snapshot: ") + Path; return nullptr; }
    TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetStringField(TEXT("assetPath"), Path); Entry->SetStringField(TEXT("assetClass"), Data.AssetClassPath.ToString());
    Entry->SetStringField(TEXT("packageName"), Data.PackageName.ToString());
    Entry->SetStringField(TEXT("file"), FileName(Path)); Entry->SetStringField(TEXT("fingerprint"), Json->GetStringField(TEXT("fingerprint")));
    Entry->SetStringField(TEXT("coverage"), Coverage->GetStringField(TEXT("status"))); Entry->SetBoolField(TEXT("stale"), false);
    Entry->SetArrayField(TEXT("dependencies"), DependencyJson);
    Entry->SetNumberField(TEXT("unresolvedDependencyCount"), UnresolvedDependencies.Num());
    Entries()->SetObjectField(Path, Entry); StalePackages.Remove(Data.PackageName.ToString());
    if (!bScanning && !SaveIndex()) { Error = TEXT("Asset snapshot was written, but its lookup index could not be saved."); return nullptr; }
    return Json;
}

TSharedPtr<FJsonObject> FProjectKnowledgeService::ReadCachedAssetSnapshot(const FString& AssetPath, FString& Error)
{
    using namespace ProjectAssetSnapshots;
    check(IsInGameThread()); ApplyInvalidations(); Error.Reset(); const FString Path = Normalize(AssetPath);
    if (Path.IsEmpty()) { Error = TEXT("Invalid asset path."); return nullptr; }
    const auto Json = ReadJson(FilePath(Path));
    if (!Json.IsValid()) { Error = TEXT("Snapshot missing; refresh this asset or update the project graph."); return nullptr; }
    bool bStale = false, bDirty = false; FString StoredPath, Project, StoredSession;
    const TSharedPtr<FJsonObject>* Indexed = nullptr;
    if (Entries()->TryGetObjectField(Path, Indexed)) (*Indexed)->TryGetBoolField(TEXT("stale"), bStale);
    if (bStale) { Error = TEXT("Snapshot index marks this asset stale; refresh the live asset."); return nullptr; }
    Json->TryGetBoolField(TEXT("stale"), bStale); Json->TryGetBoolField(TEXT("packageDirty"), bDirty);
    Json->TryGetStringField(TEXT("assetPath"), StoredPath); Json->TryGetStringField(TEXT("projectId"), Project); Json->TryGetStringField(TEXT("session"), StoredSession);
    if (StoredPath != Path || Project != FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()) ||
        bStale || StalePackages.Contains(FPackageName::ObjectPathToPackageName(Path)) || (bDirty && StoredSession != Session))
    { Error = TEXT("Snapshot is stale or belongs to another project/session; refresh the live asset."); return nullptr; }
    const FAssetData Data = Registry().GetAssetByObjectPath(FSoftObjectPath(Path)); FString PackageFile, Timestamp;
    Json->TryGetStringField(TEXT("packageTimestamp"), Timestamp);
    double PackageSize = -1; Json->TryGetNumberField(TEXT("packageSize"), PackageSize);
    const bool bPackageExists = Data.IsValid() && FPackageName::DoesPackageExist(Data.PackageName.ToString(), &PackageFile);
    if (!Data.IsValid() || (!Timestamp.IsEmpty() && !bPackageExists) ||
        (bPackageExists && (Timestamp != IFileManager::Get().GetTimeStamp(*PackageFile).ToIso8601() || PackageSize != IFileManager::Get().FileSize(*PackageFile))))
    { Error = TEXT("Asset was deleted, renamed or changed on disk; refresh the live asset."); return nullptr; }
    return Json;
}

void FProjectKnowledgeService::BeginAssetSnapshotScan()
{
    check(IsInGameThread()); InitializeAssetSnapshots(); ProjectAssetSnapshots::Entries(); ProjectAssetSnapshots::bScanning = true;
    ProjectAssetSnapshots::ApplyInvalidations();
    ProjectAssetSnapshots::Index->SetBoolField(TEXT("complete"), false);
    // 新扫描开始即撤销上轮完成标记，查询不能把进行中的任务误认为已完成。
    ProjectAssetSnapshots::Index->SetBoolField(TEXT("scanComplete"), false);
    ProjectAssetSnapshots::Index->SetBoolField(TEXT("captureComplete"), false);
    // 保留经包时间戳、大小、项目身份及编辑器失效事件验证的快照。
    // 扫描完成时按本轮资产路径清理已删除条目，变化中的资产会被事件标记为 stale。
    ProjectAssetSnapshots::SaveIndex();
}

TArray<FString> FProjectKnowledgeService::GetStaleAssetSnapshotPaths()
{
    check(IsInGameThread()); ProjectAssetSnapshots::ApplyInvalidations(); TArray<FString> Paths;
    for (const auto& Pair : ProjectAssetSnapshots::Entries()->Values)
    {
        bool bStale = false; Pair.Value->AsObject()->TryGetBoolField(TEXT("stale"), bStale);
        if (bStale) Paths.Add(FString(*Pair.Key));
    }
    Paths.Sort(); return Paths;
}

bool FProjectKnowledgeService::EndAssetSnapshotScan(const TArray<FString>& AssetPaths, const TArray<FString>& Errors, bool bComplete, FString& Error,
    const TSharedPtr<FJsonObject>& DiskCoverage)
{
    using namespace ProjectAssetSnapshots;
    check(IsInGameThread()); ApplyInvalidations(); bScanning = false; const auto Assets = Entries();
    // 仅在完整扫描后清理确实消失的资产；取消时保留已生成和上次可用的快照。
    if (bComplete)
    {
        TSet<FString> Current(AssetPaths); TArray<FString> Previous; for (const auto& Pair : Assets->Values) Previous.Add(FString(*Pair.Key));
        for (const FString& Path : Previous) if (!Current.Contains(Path)) { Assets->RemoveField(Path); IFileManager::Get().Delete(*FilePath(Path), false, true); }
        // 清理由旧编码文件名或已删除路径留下的插件快照，严格限定自有哈希 JSON 文件。
        TSet<FString> CurrentFiles;
        for (const auto& Pair : Assets->Values) CurrentFiles.Add(Pair.Value->AsObject()->GetStringField(TEXT("file")));
        TArray<FString> Files; IFileManager::Get().FindFiles(Files, *FPaths::Combine(Directory(), TEXT("*.json")), true, false);
        for (const FString& File : Files)
        {
            bool bOwned = File.Len() == 37 && File.EndsWith(TEXT(".json"));
            for (int32 I = 0; bOwned && I < 32; ++I) bOwned = FChar::IsHexDigit(File[I]);
            if (bOwned && !CurrentFiles.Contains(File)) IFileManager::Get().Delete(*FPaths::Combine(Directory(), File), false, true);
        }
    }
    TArray<TSharedPtr<FJsonValue>> Failures; for (const FString& Failure : Errors) Failures.Add(MakeShared<FJsonValueString>(Failure));
    if (bComplete)
        for (const auto& Pair : Assets->Values)
        {
            bool bStale = false; Pair.Value->AsObject()->TryGetBoolField(TEXT("stale"), bStale);
            if (bStale) Failures.Add(MakeShared<FJsonValueString>(TEXT("Asset changed or failed during scan: ") + FString(*Pair.Key)));
        }
    Index->SetArrayField(TEXT("errors"), Failures); Index->SetNumberField(TEXT("expectedAssetCount"), AssetPaths.Num());
    // 完成登记资产采集不代表磁盘包无遗漏；未能登记的包仅保留文件/包身份，不伪造资产对象。
    if (DiskCoverage.IsValid())
        for (const TCHAR* Key : {TEXT("diskPackageCount"), TEXT("registeredPackageCount"), TEXT("excludedPackages")})
            if (DiskCoverage->HasField(Key)) Index->SetField(Key, DiskCoverage->TryGetField(Key));
    const TArray<TSharedPtr<FJsonValue>>* Excluded = nullptr;
    const bool bNoExcludedPackages = Index->TryGetArrayField(TEXT("excludedPackages"), Excluded) && Excluded->IsEmpty();
    Index->SetNumberField(TEXT("assetCount"), Assets->Values.Num());
    Index->SetBoolField(TEXT("scanComplete"), bComplete);
    Index->SetBoolField(TEXT("captureComplete"), bComplete && Failures.IsEmpty());
    Index->SetBoolField(TEXT("complete"), bComplete && Failures.IsEmpty() && bNoExcludedPackages);
    int32 AssetsWithMissingReferences = 0;
    for (const auto& Pair : Assets->Values)
    {
        double Count = 0; Pair.Value->AsObject()->TryGetNumberField(TEXT("unresolvedDependencyCount"), Count);
        if (Count > 0) ++AssetsWithMissingReferences;
    }
    Index->SetNumberField(TEXT("assetsWithUnresolvedDependencies"), AssetsWithMissingReferences);
    Index->SetStringField(TEXT("updatedAt"), FDateTime::UtcNow().ToIso8601());
    if (!SaveIndex()) { Error = TEXT("Failed to save asset snapshot index."); return false; }
    if (bComplete && Failures.Num() > Errors.Num()) { Error = TEXT("One or more assets changed during the scan; refresh before treating the index as complete."); return false; }
    return true;
}

TSharedPtr<FJsonObject> FProjectKnowledgeService::ExecuteSnapshotTool(const FString& Tool, const TSharedPtr<FJsonObject>& Args)
{
    using namespace ProjectAssetSnapshots;
    double Offset = 0, Limit = 64;
    if ((Args->HasField(TEXT("offset")) && !Args->TryGetNumberField(TEXT("offset"), Offset)) ||
        (Args->HasField(TEXT("limit")) && !Args->TryGetNumberField(TEXT("limit"), Limit)) || Offset < 0 || Offset > MAX_int32 || Limit < 1 || Limit > 200 || Offset != FMath::FloorToDouble(Offset) || Limit != FMath::FloorToDouble(Limit))
        return Failure(TEXT("offset must be a non-negative integer; limit must be in 1..200."));
    if (Tool == TEXT("search_asset_snapshots"))
    {
        ApplyInvalidations();
        FString Query; Args->TryGetStringField(TEXT("query"), Query); TArray<FString> Paths; for (const auto& Pair : Entries()->Values) Paths.Add(FString(*Pair.Key)); Paths.Sort();
        TArray<TSharedPtr<FJsonValue>> Results; int32 Total = 0;
        for (const FString& Path : Paths) if (Path.Contains(Query)) { if (Total >= Offset && Results.Num() < Limit) Results.Add(Entries()->TryGetField(Path)); ++Total; }
        const auto Result = MakeShared<FJsonObject>(); Result->SetArrayField(TEXT("assets"), Results); Result->SetNumberField(TEXT("total"), Total);
        Result->SetNumberField(TEXT("nextOffset"), Offset + Results.Num()); Result->SetBoolField(TEXT("truncated"), Offset + Results.Num() < Total); return Result;
    }
    FString Path, Error, Section, Graph;
    if (!Args->TryGetStringField(TEXT("assetPath"), Path)) Args->TryGetStringField(TEXT("path"), Path);
    const auto Snapshot = Tool == TEXT("asset_snapshot") ? CaptureAssetSnapshot(Path, Error) : ReadCachedAssetSnapshot(Path, Error);
    if (!Snapshot.IsValid()) return Failure(Error);
    Args->TryGetStringField(TEXT("section"), Section); Args->TryGetStringField(TEXT("graph"), Graph);
    // 默认只给目录与元数据；图表/参数/属性按需分页，不把整个项目或大蓝图塞进模型。
    TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
    for (const TCHAR* Key : {TEXT("schemaVersion"), TEXT("assetPath"), TEXT("assetClass"), TEXT("fingerprint"), TEXT("coverage"), TEXT("dependencies"), TEXT("unresolvedDependencies")})
        if (Snapshot->HasField(Key)) Result->SetField(Key, Snapshot->TryGetField(Key));
    TArray<TSharedPtr<FJsonValue>> Items;
    if (Section.IsEmpty())
    {
        TArray<TSharedPtr<FJsonValue>> Sections;
        for (const TCHAR* Key : {TEXT("properties"), TEXT("blueprint"), TEXT("materialInstance"), TEXT("material")}) if (Snapshot->HasField(Key)) Sections.Add(MakeShared<FJsonValueString>(Key));
        Result->SetArrayField(TEXT("sections"), Sections);
        // 材质目录返回全部节点的轻量位置索引；模型可直接定位 Frac 等节点，再分页读取完整连线与属性。
        const TSharedPtr<FJsonObject>* Material = nullptr;
        if (Snapshot->TryGetObjectField(TEXT("material"), Material) && Material && Material->IsValid())
        {
            const TArray<TSharedPtr<FJsonValue>>* Expressions = nullptr;
            if ((*Material)->TryGetArrayField(TEXT("expressions"), Expressions) && Expressions)
            {
                TArray<TSharedPtr<FJsonValue>> MaterialIndex;
                for (int32 I = 0; I < Expressions->Num(); ++I)
                {
                    const auto Expression = (*Expressions)[I]->AsObject();
                    const auto Entry = MakeShared<FJsonObject>();
                    Entry->SetNumberField(TEXT("offset"), I);
                    Entry->SetStringField(TEXT("name"), Expression->GetStringField(TEXT("name")));
                    MaterialIndex.Add(MakeShared<FJsonValueObject>(Entry));
                }
                Result->SetArrayField(TEXT("materialIndex"), MaterialIndex);
                Result->SetNumberField(TEXT("materialExpressionCount"), Expressions->Num());
                Result->SetBoolField(TEXT("materialIndexComplete"), !Snapshot->GetBoolField(TEXT("truncated")));
            }
        }
        return Result;
    }
    if (Section == TEXT("properties")) { const TArray<TSharedPtr<FJsonValue>>* Values; if (Snapshot->TryGetArrayField(Section, Values)) Items = *Values; }
    else if (Section == TEXT("materialInstance"))
    {
        const TSharedPtr<FJsonObject>* MI; if (Snapshot->TryGetObjectField(Section, MI)) { Result->SetStringField(TEXT("parent"), (*MI)->GetStringField(TEXT("parent"))); Items = (*MI)->GetArrayField(TEXT("parameters")); }
    }
    else if (Section == TEXT("blueprint"))
    {
        const TSharedPtr<FJsonObject>* BP;
        if (Snapshot->TryGetObjectField(Section, BP))
            for (const TCHAR* Key : {TEXT("functions"), TEXT("eventGraphs"), TEXT("macros"), TEXT("otherGraphs")})
                for (const auto& Value : (*BP)->GetArrayField(Key))
                {
                    const auto Json = Value->AsObject();
                    if (!Graph.IsEmpty()) { if (Json->GetStringField(TEXT("name")) == Graph || Json->GetStringField(TEXT("path")) == Graph) Items.Append(Json->GetArrayField(TEXT("nodes"))); }
                    else { const auto Summary = MakeShared<FJsonObject>(); for (const TCHAR* Field : {TEXT("name"), TEXT("path"), TEXT("graphGuid"), TEXT("graphKind"), TEXT("nodeCount")}) if (Json->HasField(Field)) Summary->SetField(Field, Json->TryGetField(Field)); Items.Add(MakeShared<FJsonValueObject>(Summary)); }
                }
    }
    else if (Section == TEXT("variables") || Section == TEXT("components"))
    {
        const TSharedPtr<FJsonObject>* BP; if (Snapshot->TryGetObjectField(TEXT("blueprint"), BP)) Items = (*BP)->GetArrayField(Section);
    }
    else if (Section == TEXT("material"))
    {
        const TSharedPtr<FJsonObject>* Material; if (Snapshot->TryGetObjectField(Section, Material)) Items = (*Material)->GetArrayField(TEXT("expressions"));
    }
    else return Failure(TEXT("Unsupported snapshot section."));
    TArray<TSharedPtr<FJsonValue>> Page;
    for (int32 I = static_cast<int32>(Offset); I < Items.Num() && Page.Num() < Limit; ++I) Page.Add(Items[I]);
    Result->SetArrayField(TEXT("items"), Page); Result->SetNumberField(TEXT("total"), Items.Num()); Result->SetNumberField(TEXT("nextOffset"), Offset + Page.Num());
    Result->SetBoolField(TEXT("truncated"), Offset + Page.Num() < Items.Num()); return Result;
}

#if WITH_DEV_AUTOMATION_TESTS
#include "Misc/AutomationTest.h"
#include "Misc/ScopeExit.h"
#include "Engine/PrimaryAssetLabel.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectAssetSnapshotTest, "DSHUnrealBridge.Knowledge.AssetSnapshots", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectAssetSnapshotTest::RunTest(const FString& Parameters)
{
    using namespace ProjectAssetSnapshots;
    // 独立未保存的 DataAsset 验证状态、完整容器、失效与分页，并记录同目标的可复现计时。
    TestNotEqual(TEXT("Unicode paths produce distinct snapshot filenames"), FileName(TEXT("/Game/车门.车门")), FileName(TEXT("/Game/车窗.车窗")));
    TestNotEqual(TEXT("Unicode values produce distinct state hashes"), HashText(TEXT("红色")), HashText(TEXT("绿色")));
    const FString PackageName = TEXT("/Game/__AgentSnapshotTests/T_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    UPackage* Package = CreatePackage(*PackageName);
    UPrimaryAssetLabel* Asset = NewObject<UPrimaryAssetLabel>(Package, TEXT("Snapshot"), RF_Public | RF_Standalone | RF_Transactional);
    for (int32 I = 0; I < 150; ++I) Asset->ExplicitAssets.Add(TSoftObjectPtr<UObject>(FSoftObjectPath(FString::Printf(TEXT("/Game/SnapshotFixture/Item_%d.Item_%d"), I, I))));
    FAssetRegistryModule::AssetCreated(Asset);
    const FString Path = Asset->GetPathName();
    ON_SCOPE_EXIT
    {
        FAssetRegistryModule::AssetDeleted(Asset); Asset->ClearFlags(RF_Public | RF_Standalone); Asset->MarkAsGarbage();
        Package->SetDirtyFlag(false);
    };
    FString Error;
    const double LiveStarted = FPlatformTime::Seconds();
    const auto First = FProjectKnowledgeService::CaptureAssetSnapshot(Path, Error);
    const double LiveMs = (FPlatformTime::Seconds() - LiveStarted) * 1000;
    if (!TestTrue(TEXT("Live snapshot persists: ") + Error, First.IsValid())) return false;
    const FString FirstFingerprint = First->GetStringField(TEXT("fingerprint"));
    const auto Second = FProjectKnowledgeService::CaptureAssetSnapshot(Path, Error);
    if (!TestTrue(TEXT("Repeated live read succeeds"), Second.IsValid())) return false;
    TestEqual(TEXT("Capture time and dirty state do not change fingerprint"), Second->GetStringField(TEXT("fingerprint")), FirstFingerprint);
    bool bArrayComplete = false;
    for (const auto& Property : First->GetArrayField(TEXT("properties")))
        if (Property->AsObject()->GetStringField(TEXT("name")) == TEXT("ExplicitAssets")) bArrayComplete = Property->AsObject()->GetArrayField(TEXT("value")).Num() == 150;
    TestTrue(TEXT("All 150 container elements are stored, not just a default page"), bArrayComplete);
    const double CachedStarted = FPlatformTime::Seconds();
    const auto Cached = FProjectKnowledgeService::ReadCachedAssetSnapshot(Path, Error);
    const double CachedMs = (FPlatformTime::Seconds() - CachedStarted) * 1000;
    TestTrue(TEXT("Disk cache lookup succeeds"), Cached.IsValid());
    if (Cached.IsValid()) TestEqual(TEXT("Cached and live state fingerprints match"), Cached->GetStringField(TEXT("fingerprint")), FirstFingerprint);
    TSharedPtr<FJsonObject> Args = MakeShared<FJsonObject>(); Args->SetStringField(TEXT("assetPath"), Path); Args->SetStringField(TEXT("section"), TEXT("properties")); Args->SetNumberField(TEXT("limit"), 1);
    const double QueryStarted = FPlatformTime::Seconds();
    const auto Page = FProjectKnowledgeService::ExecuteSnapshotTool(TEXT("read_asset_snapshot"), Args);
    const double QueryMs = (FPlatformTime::Seconds() - QueryStarted) * 1000;
    TestEqual(TEXT("Property pagination emits requested item count"), Page->GetArrayField(TEXT("items")).Num(), 1);
    TestTrue(TEXT("Property pagination reports remaining entries"), Page->GetBoolField(TEXT("truncated")));
    Args->SetNumberField(TEXT("offset"), Page->GetNumberField(TEXT("nextOffset")));
    const auto Next = FProjectKnowledgeService::ExecuteSnapshotTool(TEXT("read_asset_snapshot"), Args);
    TestNotEqual(TEXT("Next page advances"), Page->GetArrayField(TEXT("items"))[0]->AsObject()->GetStringField(TEXT("name")), Next->GetArrayField(TEXT("items"))[0]->AsObject()->GetStringField(TEXT("name")));
    Asset->Modify(); Asset->bIsRuntimeLabel = !Asset->bIsRuntimeLabel;
    TestFalse(TEXT("Object modification invalidates cache"), FProjectKnowledgeService::ReadCachedAssetSnapshot(Path, Error).IsValid());
    const auto Changed = FProjectKnowledgeService::CaptureAssetSnapshot(Path, Error);
    if (!TestTrue(TEXT("Changed state recaptures"), Changed.IsValid())) return false;
    TestNotEqual(TEXT("Actual property change changes fingerprint"), Changed->GetStringField(TEXT("fingerprint")), FirstFingerprint);
    Asset->bIsRuntimeLabel = !Asset->bIsRuntimeLabel;
    const auto Restored = FProjectKnowledgeService::CaptureAssetSnapshot(Path, Error);
    if (TestTrue(TEXT("Restored state recaptures"), Restored.IsValid())) TestEqual(TEXT("Restored logical state restores fingerprint"), Restored->GetStringField(TEXT("fingerprint")), FirstFingerprint);
    FString FullText, PageText;
    FJsonSerializer::Serialize(First.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&FullText));
    FJsonSerializer::Serialize(Page.ToSharedRef(), TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&PageText));
    const auto Report = MakeShared<FJsonObject>(); Report->SetStringField(TEXT("test"), TEXT("DSHUnrealBridge.Knowledge.AssetSnapshots"));
    Report->SetStringField(TEXT("assetClass"), Asset->GetClass()->GetPathName()); Report->SetStringField(TEXT("fingerprint"), FirstFingerprint);
    Report->SetNumberField(TEXT("liveCaptureMs"), LiveMs); Report->SetNumberField(TEXT("cachedReadMs"), CachedMs); Report->SetNumberField(TEXT("pagedQueryMs"), QueryMs);
    Report->SetNumberField(TEXT("fullSnapshotUtf8Bytes"), FTCHARToUTF8(*FullText).Length()); Report->SetNumberField(TEXT("pagedResultUtf8Bytes"), FTCHARToUTF8(*PageText).Length());
    Report->SetNumberField(TEXT("containerElements"), 150); Report->SetBoolField(TEXT("sameTargetAndValidation"), true);
    Report->SetStringField(TEXT("scope"), TEXT("Synthetic unsaved DataAsset. Measures actual local capture/cache/query time and bytes; not cloud model latency or token savings."));
    TestTrue(TEXT("Benchmark report saved"), WriteJson(FPaths::Combine(FProjectKnowledgeService::GetCacheDirectory(), TEXT("Tests/asset_snapshot_benchmark.json")), Report));
    return true;
}

// 合成 135 节点材质验证目录索引涵盖远端页，详情仍须按节点偏移读取。
IMPLEMENT_SIMPLE_AUTOMATION_TEST(FProjectMaterialSnapshotIndexTest, "DSHUnrealBridge.Knowledge.MaterialSnapshotIndex", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FProjectMaterialSnapshotIndexTest::RunTest(const FString& Parameters)
{
    const FString PackageName = TEXT("/Game/__AgentSnapshotTests/M_") + FGuid::NewGuid().ToString(EGuidFormats::Digits);
    UPackage* Package = CreatePackage(*PackageName);
    UMaterial* Material = NewObject<UMaterial>(Package, TEXT("M_IndexFixture"), RF_Public | RF_Standalone | RF_Transactional);
    for (int32 I = 0; I < 135; ++I)
    {
        UMaterialExpression* Expression = I == 37 ? static_cast<UMaterialExpression*>(NewObject<UMaterialExpressionFrac>(Material))
            : I == 76 ? static_cast<UMaterialExpression*>(NewObject<UMaterialExpressionMultiply>(Material))
            : static_cast<UMaterialExpression*>(NewObject<UMaterialExpressionConstant>(Material));
        Material->GetExpressionCollection().AddExpression(Expression);
    }
    FAssetRegistryModule::AssetCreated(Material);
    ON_SCOPE_EXIT
    {
        FAssetRegistryModule::AssetDeleted(Material);
        Material->ClearFlags(RF_Public | RF_Standalone);
        Material->MarkAsGarbage();
        Package->SetDirtyFlag(false);
    };
    FString Error;
    const auto Snapshot = FProjectKnowledgeService::CaptureAssetSnapshot(Material->GetPathName(), Error);
    if (!TestTrue(TEXT("Live material snapshot captured: ") + Error, Snapshot.IsValid())) return false;
    TestEqual(TEXT("Complete material retains 135 expressions"), Snapshot->GetObjectField(TEXT("material"))->GetArrayField(TEXT("expressions")).Num(), 135);
    const auto Args = MakeShared<FJsonObject>();
    Args->SetStringField(TEXT("assetPath"), Material->GetPathName());
    const auto Directory = FProjectKnowledgeService::ExecuteSnapshotTool(TEXT("read_asset_snapshot"), Args);
    if (!TestTrue(TEXT("Material directory returned"), Directory.IsValid())) return false;
    const auto Index = Directory->GetArrayField(TEXT("materialIndex"));
    TestEqual(TEXT("First metadata response indexes the full graph"), Index.Num(), 135);
    TestTrue(TEXT("Index is explicitly complete"), Directory->GetBoolField(TEXT("materialIndexComplete")));
    TestTrue(TEXT("Frac beyond first page is discoverable"), Index[37]->AsObject()->GetStringField(TEXT("name")).Contains(TEXT("Frac")));
    TestTrue(TEXT("Upstream Multiply is discoverable"), Index[76]->AsObject()->GetStringField(TEXT("name")).Contains(TEXT("Multiply")));
    Args->SetStringField(TEXT("section"), TEXT("material"));
    Args->SetNumberField(TEXT("offset"), 37);
    Args->SetNumberField(TEXT("limit"), 1);
    const auto Detail = FProjectKnowledgeService::ExecuteSnapshotTool(TEXT("read_asset_snapshot"), Args);
    if (!TestTrue(TEXT("Indexed node details remain pageable"), Detail.IsValid())) return false;
    TestEqual(TEXT("Details match indexed Frac"), Detail->GetArrayField(TEXT("items"))[0]->AsObject()->GetStringField(TEXT("name")), Index[37]->AsObject()->GetStringField(TEXT("name")));
    TestEqual(TEXT("Next offset advances by visible nodes"), Detail->GetNumberField(TEXT("nextOffset")), 38.0);
    return true;
}
#endif
