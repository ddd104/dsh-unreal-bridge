#include "DSHMcpEditAdapter.h"

#include "Dom/JsonValue.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"

namespace
{
FString LowerKey(FString Key)
{
    Key.ToLowerInline();
    Key.ReplaceInline(TEXT("_"), TEXT(""));
    Key.ReplaceInline(TEXT("-"), TEXT(""));
    return Key;
}

bool IsAssetKey(const FString& Key)
{
    static const TSet<FString> Keys = {
        TEXT("asset"), TEXT("assets"), TEXT("assetpath"), TEXT("assetpaths"),
        TEXT("objectpath"), TEXT("blueprint"), TEXT("blueprintpath"),
        TEXT("material"), TEXT("materialpath"), TEXT("animationblueprint"),
        TEXT("animationblueprintpath"), TEXT("targetasset"), TEXT("targetassetpath"),
        TEXT("newassetpath"), TEXT("createdasset"), TEXT("modifiedasset"),
        TEXT("materialorfunction"), TEXT("instance"), TEXT("texture"),
        TEXT("staticmesh"), TEXT("skeletalmesh"), TEXT("datatable"),
        TEXT("dataasset"), TEXT("curvetable"), TEXT("stringtable"),
        TEXT("object"), TEXT("path"), TEXT("newpath")};
    return Keys.Contains(Key);
}

bool IsNodeKey(const FString& Key)
{
    static const TSet<FString> Keys = {
        TEXT("node"), TEXT("nodes"), TEXT("nodeid"), TEXT("nodeids"),
        TEXT("nodeguid"), TEXT("nodeguids"), TEXT("expression"),
        TEXT("expressions"), TEXT("expressionid"), TEXT("expressionids"),
        TEXT("expressionguid"), TEXT("expressionguids"),
        TEXT("fromexpression"), TEXT("toexpression")};
    return Keys.Contains(Key);
}

bool IsMutation(const FString& Name)
{
    const FString Lower = Name.ToLower();
    static const TArray<FString> Verbs = {
        TEXT("create"), TEXT("add"), TEXT("set"), TEXT("update"), TEXT("edit"),
        TEXT("modify"), TEXT("remove"), TEXT("delete"), TEXT("move"),
        TEXT("rename"), TEXT("connect"), TEXT("disconnect"), TEXT("assign"),
        TEXT("duplicate"), TEXT("paste"), TEXT("insert"), TEXT("apply"),
        TEXT("replace"), TEXT("clear"), TEXT("layout"), TEXT("write"),
        TEXT("break"), TEXT("import"), TEXT("reimport"), TEXT("generate")};
    for (const FString& Verb : Verbs)
        if (Lower == Verb || Lower.EndsWith(TEXT(".") + Verb)
            || Lower.StartsWith(Verb + TEXT("_")) || Lower.Contains(TEXT(".") + Verb + TEXT("_"))
            || Lower.Contains(TEXT("_") + Verb + TEXT("_"))) return true;
    return false;
}

FString NormalizeAssetPath(const FString& Path)
{
    FString RootObject = Path;
    int32 SubobjectStart = INDEX_NONE;
    if (RootObject.FindChar(TEXT(':'), SubobjectStart)) RootObject.LeftInline(SubobjectStart);
    const FString Package = FPackageName::ObjectPathToPackageName(RootObject);
    if (!Package.StartsWith(TEXT("/")) || !FPackageName::IsValidLongPackageName(Package)) return {};
    return Package + TEXT(".") + FPackageName::GetShortName(Package);
}

struct FExtracted
{
    TArray<FString> Assets;
    TArray<FString> Nodes;
    FString Graph;
    TOptional<FVector2D> Center;
};

void Extract(const TSharedPtr<FJsonValue>& Value, const FString& ParentKey, FExtracted& Out, int32 Depth = 0)
{
    if (!Value.IsValid() || Depth > 8) return;
    if (Value->Type == EJson::Object)
    {
        const TSharedPtr<FJsonObject> Object = Value->AsObject();
        if (!Object.IsValid()) return;
        if (ParentKey == TEXT("pos") || ParentKey == TEXT("position"))
        {
            double X = 0, Y = 0;
            if (Object->TryGetNumberField(TEXT("x"), X) && Object->TryGetNumberField(TEXT("y"), Y))
                Out.Center = FVector2D(X, Y);
        }
        for (const auto& Pair : Object->Values)
            Extract(Pair.Value, LowerKey(FString(*Pair.Key)), Out, Depth + 1);
    }
    else if (Value->Type == EJson::Array)
    {
        for (const auto& Entry : Value->AsArray()) Extract(Entry, ParentKey, Out, Depth + 1);
    }
    else if (Value->Type == EJson::String)
    {
        const FString Text = Value->AsString();
        if (IsAssetKey(ParentKey))
        {
            const FString Path = NormalizeAssetPath(Text);
            if (!Path.IsEmpty()) Out.Assets.AddUnique(Path);
        }
        else if (IsNodeKey(ParentKey) && !Text.IsEmpty() && Text.Len() <= 256)
        {
            Out.Nodes.AddUnique(Text);
            const FString Path = NormalizeAssetPath(Text);
            if (!Path.IsEmpty())
            {
                Out.Assets.AddUnique(Path);
                int32 LastDot = INDEX_NONE, Colon = INDEX_NONE;
                Text.FindLastChar(TEXT(':'), Colon);
                if (Out.Graph.IsEmpty() && Text.FindLastChar(TEXT('.'), LastDot) && LastDot > Colon)
                    Out.Graph = Text.Left(LastDot);
                const FString Leaf = Text.Mid(FMath::Max(Colon, LastDot) + 1);
                if (!Leaf.IsEmpty()) Out.Nodes.AddUnique(Leaf);
            }
        }
        else if (ParentKey == TEXT("graph") || ParentKey == TEXT("graphname") || ParentKey == TEXT("graphid"))
        {
            if (Out.Graph.IsEmpty()) Out.Graph = Text;
            if (ParentKey == TEXT("graph"))
            {
                const FString Path = NormalizeAssetPath(Text);
                if (!Path.IsEmpty()) Out.Assets.AddUnique(Path);
            }
        }
        else if (ParentKey == TEXT("text") && Text.Len() < 262144 && Text.StartsWith(TEXT("{")))
        {
            TSharedPtr<FJsonObject> Inner;
            if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Inner) && Inner.IsValid())
                Extract(MakeShared<FJsonValueObject>(Inner), FString(), Out, Depth + 1);
        }
        else if ((ParentKey == TEXT("text") || ParentKey == TEXT("result")) && Text.StartsWith(TEXT("/")))
        {
            const FString Path = NormalizeAssetPath(Text);
            if (!Path.IsEmpty())
            {
                Out.Assets.AddUnique(Path);
                if (Text.Contains(TEXT(":"))) Out.Nodes.AddUnique(Text);
            }
        }
    }
}
}

TArray<FDSHAssetViewHint> FDSHMcpEditAdapter::FromCall(const FString& ToolName,
    const TSharedPtr<FJsonObject>& Arguments, const TSharedPtr<FJsonObject>& Result)
{
    TArray<FDSHAssetViewHint> Hints;
    if (!Arguments.IsValid() || !Result.IsValid()) return Hints;
    bool bError = false, bSuccess = true;
    Result->TryGetBoolField(TEXT("isError"), bError);
    Result->TryGetBoolField(TEXT("success"), bSuccess);
    if (bError || !bSuccess) return Hints;
    FString ActualName = ToolName;
    TSharedPtr<FJsonObject> ToolArguments = Arguments;
    if (ToolName == TEXT("call_tool"))
    {
        Arguments->TryGetStringField(TEXT("tool_name"), ActualName);
        const TSharedPtr<FJsonObject>* Nested = nullptr;
        if (Arguments->TryGetObjectField(TEXT("arguments"), Nested) && Nested && Nested->IsValid()) ToolArguments = *Nested;
    }
    if (!IsMutation(ActualName)) return Hints;
    FExtracted Input, Output;
    Extract(MakeShared<FJsonValueObject>(ToolArguments), FString(), Input);
    Extract(MakeShared<FJsonValueObject>(Result), FString(), Output);
    double X = 0, Y = 0;
    if (ToolArguments->TryGetNumberField(TEXT("x"), X) && ToolArguments->TryGetNumberField(TEXT("y"), Y))
        Input.Center = FVector2D(X, Y);
    FString Folder, AssetName;
    if (ToolArguments->TryGetStringField(TEXT("folder_path"), Folder)
        && ToolArguments->TryGetStringField(TEXT("asset_name"), AssetName)
        && !AssetName.IsEmpty())
    {
        const FString CreatedPath = NormalizeAssetPath(FPaths::Combine(Folder, AssetName));
        if (!CreatedPath.IsEmpty()) Input.Assets.AddUnique(CreatedPath);
    }
    const bool bPreferOutput = ActualName == TEXT("create") || ActualName.StartsWith(TEXT("create_"))
        || ActualName == TEXT("duplicate") || ActualName.StartsWith(TEXT("duplicate_"))
        || ActualName == TEXT("rename") || ActualName.StartsWith(TEXT("rename_"))
        || ActualName == TEXT("move") || ActualName.StartsWith(TEXT("move_"));
    const TArray<FString>& Assets = (bPreferOutput && !Output.Assets.IsEmpty()) || Input.Assets.IsEmpty() ? Output.Assets : Input.Assets;
    for (const FString& Path : Assets)
    {
        FDSHAssetViewHint& Hint = Hints.AddDefaulted_GetRef();
        Hint.AssetPath = Path;
        Hint.Graph = !Output.Graph.IsEmpty() ? Output.Graph : Input.Graph;
        Hint.NodeIds = Output.Nodes.IsEmpty() ? Input.Nodes : Output.Nodes;
        Hint.Center = Input.Center.IsSet() ? Input.Center : Output.Center;
    }
    return Hints;
}
