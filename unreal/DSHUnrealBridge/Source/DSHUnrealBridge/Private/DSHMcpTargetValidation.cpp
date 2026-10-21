#include "DSHMcpTargetValidation.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Dom/JsonValue.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "IDSHUnrealBridgeMCPModule.h"
#include "Serialization/JsonSerializer.h"
#include "ToolsetRegistry/ToolsetRegistrySubsystem.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UObjectGlobals.h"

namespace
{
struct FTarget
{
    FString Parameter;
    FString Path;
    UClass* Expected = nullptr;
    UClass* Actual = nullptr;
    UObject* Object = nullptr;
    bool bClassReference = false;
};

struct FCheck
{
    TSharedPtr<FJsonObject> Details;
    FString Code, Message;
    TArray<FTarget> Targets;
    int32 Visited = 0;
    bool bResolveOnly = false;

    bool Fail(const FString& Suffix, const FString& Text, const FString& Parameter = FString(),
        const FString& Path = FString(), const FString& Expected = FString(), const FString& Actual = FString())
    {
        Code = TEXT("MCP_TARGET_") + Suffix;
        Message = Text;
        Details = MakeShared<FJsonObject>();
        Details->SetStringField(TEXT("execution"), TEXT("not_started"));
        Details->SetBoolField(TEXT("retryable"), true);
        if (!Parameter.IsEmpty()) Details->SetStringField(TEXT("parameter"), Parameter);
        if (!Path.IsEmpty()) Details->SetStringField(TEXT("path"), Path);
        if (!Expected.IsEmpty()) Details->SetStringField(TEXT("expectedClass"), Expected);
        if (!Actual.IsEmpty()) Details->SetStringField(TEXT("actualClass"), Actual);
        return false;
    }

    bool Ref(const TSharedPtr<FJsonObject>& Value, const TSharedPtr<FJsonObject>& Schema, const FString& Parameter)
    {
        FString Title, Path;
        if (Schema) Schema->TryGetStringField(TEXT("title"), Title);
        if (!Value->TryGetStringField(TEXT("refPath"), Path))
            return Fail(TEXT("REFERENCE_SHAPE"), TEXT("An existing UObject reference must contain a string refPath."), Parameter);
        const bool bClass = Title.RemoveFromStart(TEXT("Class@"));
        UClass* Expected = FindObject<UClass>(nullptr, *Title);
        if (!Expected)
            return Fail(TEXT("SCHEMA_UNSUPPORTED"), TEXT("The native schema does not identify a loaded UObject reference class; the target cannot be verified."), Parameter, Path, Title);
        if (Path.IsEmpty() || Path.Equals(TEXT("None"), ESearchCase::IgnoreCase) || Path.Equals(TEXT("null"), ESearchCase::IgnoreCase))
        {
            const auto Default = Schema->TryGetField(TEXT("default"));
            if (Default.IsValid() && Default->Type == EJson::Null) return true;
            return Fail(TEXT("REFERENCE_REQUIRED"), TEXT("This native parameter requires an existing object reference."), Parameter, Path, Title);
        }
        if (Path.Len() > 2048 || !Path.StartsWith(TEXT("/")) || Path.Contains(TEXT("..")) || Path.Contains(TEXT("\\")))
            return Fail(TEXT("REFERENCE_PATH"), TEXT("Use the exact canonical refPath returned by the editor."), Parameter, Path, Title);
        const FSoftObjectPath SoftPath(Path);
        if (!SoftPath.IsValid() || SoftPath.GetAssetPathString().IsEmpty() || !Path.Contains(TEXT(".")))
            return Fail(TEXT("REFERENCE_PATH"), TEXT("Use an object path, including its Package.Object separator; package paths are not object references."), Parameter, Path, Title);

        // Do not use a property importer, TryLoad, LoadObject, or an editor-open API:
        // reference conversion can instantiate objects, and opening a World switches maps.
        UObject* Object = SoftPath.ResolveObject();
        FString CanonicalPath = Object ? Object->GetPathName() : Path;
        UClass* Actual = Object ? Object->GetClass() : nullptr;
        if (Object && (!IsValid(Object) || Object->HasAnyFlags(RF_BeginDestroyed | RF_FinishDestroyed)))
            return Fail(TEXT("REFERENCE_EXPIRED"), TEXT("The referenced object is being destroyed; discover the live target again."), Parameter, Path, Title);
        if (!Object)
        {
            if (bClass || !SoftPath.GetSubPathString().IsEmpty())
                return Fail(TEXT("REFERENCE_UNRESOLVED"), TEXT("This class or subobject reference is not currently loaded. Discover its live reference before calling the tool."), Parameter, Path, Title);
            const FAssetData Data = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get().GetAssetByObjectPath(SoftPath);
            if (!Data.IsValid())
                return Fail(TEXT("REFERENCE_UNRESOLVED"), TEXT("The object is neither loaded nor present in the asset registry."), Parameter, Path, Title);
            CanonicalPath = Data.GetObjectPathString();
            Actual = FindObject<UClass>(nullptr, *Data.AssetClassPath.ToString());
            if (!Actual)
                return Fail(TEXT("TYPE_UNRESOLVED"), TEXT("The asset registry reports a class whose native type is not loaded; validation did not load the asset."), Parameter, Path, Title, Data.AssetClassPath.ToString());
        }
        if (bClass)
        {
            UClass* ClassObject = Cast<UClass>(Object);
            if (!ClassObject || !ClassObject->IsChildOf(Expected))
                return Fail(TEXT("TYPE_MISMATCH"), TEXT("The referenced class does not derive from the class required by the native tool schema."), Parameter, Path,
                    TEXT("Class@") + Expected->GetPathName(), ClassObject ? TEXT("Class@") + ClassObject->GetPathName() : GetPathNameSafe(Actual));
        }
        else if (!Actual || !Actual->IsChildOf(Expected))
            return Fail(TEXT("TYPE_MISMATCH"), TEXT("The reference resolves to a different UObject type than the native tool requires."), Parameter, Path, Expected->GetPathName(), GetPathNameSafe(Actual));
        Targets.Add({Parameter, CanonicalPath, Expected, Actual, Object, bClass});
        return true;
    }

    bool Walk(const TSharedPtr<FJsonValue>& Value, const TSharedPtr<FJsonObject>& Schema, const FString& Parameter, int32 Depth = 0)
    {
        if (++Visited > 20000 || Depth > 40)
            return Fail(TEXT("LIMIT"), TEXT("Target references exceed the validation size or nesting limit."), Parameter);
        if (!Value.IsValid()) return true;
        if (Schema)
        {
            for (const TCHAR* Key : {TEXT("anyOf"), TEXT("oneOf")})
            {
                const TArray<TSharedPtr<FJsonValue>>* Branches = nullptr;
                if (Schema->TryGetArrayField(Key, Branches))
                {
                    FCheck Last = *this;
                    for (const auto& Branch : *Branches)
                    {
                        if (!Branch.IsValid() || Branch->Type != EJson::Object) continue;
                        FCheck Candidate = *this;
                        if (Candidate.Walk(Value, Branch->AsObject(), Parameter, Depth + 1)) { *this = MoveTemp(Candidate); return true; }
                        Last = MoveTemp(Candidate);
                    }
                    *this = MoveTemp(Last);
                    if (Code.IsEmpty()) return Fail(TEXT("SCHEMA_UNSUPPORTED"), TEXT("No native union branch can verify this reference."), Parameter);
                    return false;
                }
            }
            FString Type;
            if (Schema->TryGetStringField(TEXT("type"), Type))
            {
                const bool bMatches = Type == TEXT("object") ? Value->Type == EJson::Object
                    : Type == TEXT("array") ? Value->Type == EJson::Array
                    : Type == TEXT("string") ? Value->Type == EJson::String
                    : Type == TEXT("null") ? Value->Type == EJson::Null
                    : Type == TEXT("boolean") ? Value->Type == EJson::Boolean
                    : Type == TEXT("number") || Type == TEXT("integer") ? Value->Type == EJson::Number : true;
                const auto Default = Schema->TryGetField(TEXT("default"));
                if (!bMatches && !(Value->Type == EJson::Null && Default.IsValid() && Default->Type == EJson::Null))
                    return Fail(TEXT("REFERENCE_SHAPE"), TEXT("The target value does not have the shape required by the native schema."), Parameter);
            }
        }
        if (Value->Type == EJson::Null) return true;
        if (Value->Type == EJson::Array)
        {
            const TSharedPtr<FJsonObject>* Items = nullptr;
            if (Schema) Schema->TryGetObjectField(TEXT("items"), Items);
            int32 Index = 0;
            for (const auto& Entry : Value->AsArray())
                if (!Walk(Entry, Items ? *Items : nullptr, Parameter + TEXT("/") + FString::FromInt(Index++), Depth + 1)) return false;
        }
        else if (Value->Type == EJson::Object)
        {
            const auto Object = Value->AsObject();
            if (Object->HasField(TEXT("refPath"))) return Ref(Object, Schema, Parameter);
            const TSharedPtr<FJsonObject>* Properties = nullptr;
            if (Schema) Schema->TryGetObjectField(TEXT("properties"), Properties);
            if (Properties && (*Properties)->HasField(TEXT("refPath")))
                return Fail(TEXT("REFERENCE_SHAPE"), TEXT("A native UObject reference must include refPath."), Parameter);
            const TArray<TSharedPtr<FJsonValue>>* Required = nullptr;
            if (Schema && Schema->TryGetArrayField(TEXT("required"), Required)) for (const auto& Key : *Required)
                if (Key.IsValid() && Key->Type == EJson::String && !Object->HasField(Key->AsString()))
                    return Fail(TEXT("REFERENCE_SHAPE"), TEXT("A required native parameter or target field is missing."), Parameter + TEXT("/") + Key->AsString());
            for (const auto& Entry : Object->Values)
            {
                const TSharedPtr<FJsonObject>* Child = nullptr;
                if (Properties) (*Properties)->TryGetObjectField(Entry.Key, Child);
                if (!Child && Schema)
                {
                    const TSharedPtr<FJsonObject>* Additional = nullptr;
                    if (Schema->TryGetObjectField(TEXT("additionalProperties"), Additional)) Child = Additional;
                }
                if (!Walk(Entry.Value, Child ? *Child : nullptr, Parameter + TEXT("/") + Entry.Key, Depth + 1)) return false;
            }
            FString Title;
            if (Schema) Schema->TryGetStringField(TEXT("title"), Title);
            if (Title == TEXT("PinID") && !bResolveOnly)
            {
                const TSharedPtr<FJsonObject>* NodeRef = nullptr;
                FString NodePath, Direction;
                double Index = -1;
                if (!Object->TryGetObjectField(TEXT("node"), NodeRef) || !(*NodeRef)->TryGetStringField(TEXT("refPath"), NodePath) ||
                    !Object->TryGetStringField(TEXT("direction"), Direction) || !Object->TryGetNumberField(TEXT("index_id"), Index) ||
                    Index < 0 || Index != FMath::FloorToDouble(Index) || Index > MAX_int32 ||
                    (Direction != TEXT("EGPD_Input") && Direction != TEXT("EGPD_Output")))
                    return Fail(TEXT("PIN_INVALID"), TEXT("PinID must identify an existing node, direction, and nonnegative directional index."), Parameter);
                UEdGraphNode* Node = FindObject<UEdGraphNode>(nullptr, *NodePath);
                int32 Count = 0;
                if (Node) for (const UEdGraphPin* Pin : Node->Pins)
                    if (Pin && Pin->Direction == (Direction == TEXT("EGPD_Input") ? EGPD_Input : EGPD_Output)) ++Count;
                if (!Node || Index >= Count)
                    return Fail(TEXT("PIN_INVALID"), TEXT("PinID no longer identifies an existing pin on the node; read current pin metadata."), Parameter, NodePath);
            }
        }
        return true;
    }

    bool Ownership(const FString& Toolset, const FString& Leaf)
    {
        const bool bBlueprintTool = Toolset == TEXT("editor_toolset.toolsets.blueprint.BlueprintTools");
        // This exact tool independently describes each node; a batch may span
        // graphs/Blueprints. It still requires every node's true live inventory.
        const bool bIndependentNodes = bBlueprintTool && Leaf == TEXT("get_node_infos");
        UBlueprint* Anchor = nullptr;
        FString AnchorPath;
        UEdGraph* GraphAnchor = nullptr;
        for (const FTarget& Target : Targets)
        {
            if (Target.bClassReference) continue;
            if (bBlueprintTool && !bIndependentNodes && Target.Actual && Target.Actual->IsChildOf(UBlueprint::StaticClass()))
            {
                if (!AnchorPath.IsEmpty() && AnchorPath != Target.Path)
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("This operation addresses different Blueprint owners."), Target.Parameter, Target.Path, AnchorPath, Target.Path);
                AnchorPath = Target.Path;
            }
            if (UBlueprint* Blueprint = Cast<UBlueprint>(Target.Object))
            {
                if (bBlueprintTool && !bIndependentNodes && Anchor && Anchor != Blueprint)
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("This Blueprint operation addresses different Blueprint owners."), Target.Parameter, Target.Path);
                if (bBlueprintTool && !bIndependentNodes) Anchor = Blueprint;
            }
            UEdGraph* Graph = Cast<UEdGraph>(Target.Object);
            if (UEdGraphNode* Node = Cast<UEdGraphNode>(Target.Object))
            {
                Graph = Node->GetGraph();
                if (!Graph || !Graph->Nodes.Contains(Node))
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("The node is not in the referenced live graph's node inventory."), Target.Parameter, Target.Path);
            }
            if (!Graph) continue;
            if (!IsValid(Graph->GetOuter()))
                return Fail(TEXT("OWNER_MISMATCH"), TEXT("The graph has no live owner."), Target.Parameter, Target.Path);
            if (bBlueprintTool)
            {
                UBlueprint* Blueprint = Graph->GetTypedOuter<UBlueprint>();
                TArray<UEdGraph*> Inventory;
                if (Blueprint) Blueprint->GetAllGraphs(Inventory);
                if (!Blueprint || !Inventory.Contains(Graph))
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("This graph does not belong to a live Blueprint graph inventory."), Target.Parameter, Target.Path);
                if (bIndependentNodes) continue;
                if (!AnchorPath.IsEmpty() && AnchorPath != Blueprint->GetPathName())
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("The graph/node does not belong to the explicit Blueprint reference."), Target.Parameter, Target.Path,
                        AnchorPath, Blueprint->GetPathName());
                if (Anchor && Anchor != Blueprint)
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("The graph/node belongs to a different Blueprint than the operation's target."), Target.Parameter, Target.Path,
                        Anchor->GetPathName(), Blueprint->GetPathName());
                Anchor = Blueprint;
                AnchorPath = Blueprint->GetPathName();
                const bool bSameGraph = Leaf == TEXT("connect_pins") || Leaf == TEXT("break_pins") || Leaf == TEXT("remove_node_pin") || Leaf == TEXT("arrange_nodes");
                if ((bSameGraph || Target.Parameter == TEXT("/graph")) && GraphAnchor && GraphAnchor != Graph)
                    return Fail(TEXT("OWNER_MISMATCH"), TEXT("The pin/node references for this operation must belong to one graph."), Target.Parameter, Target.Path,
                        GraphAnchor->GetPathName(), Graph->GetPathName());
                if (bSameGraph || Target.Parameter == TEXT("/graph")) GraphAnchor = Graph;
            }
        }
        // An explicit graph anchor also constrains context pins and nodes, regardless of argument order.
        if (bBlueprintTool && GraphAnchor) for (const FTarget& Target : Targets)
        {
            UEdGraph* Graph = Cast<UEdGraph>(Target.Object);
            if (const UEdGraphNode* Node = Cast<UEdGraphNode>(Target.Object)) Graph = Node->GetGraph();
            if (Graph && Graph != GraphAnchor)
                return Fail(TEXT("OWNER_MISMATCH"), TEXT("The context node/pin belongs to another graph."), Target.Parameter, Target.Path,
                    GraphAnchor->GetPathName(), Graph->GetPathName());
        }
        return true;
    }
};

TSharedPtr<FJsonObject> SchemaFor(const FString& Toolset, const FString& Leaf, FCheck& Check)
{
    if (!Toolset.IsEmpty())
    {
        const auto Subsystem = UToolsetRegistrySubsystem::Get();
        if (Subsystem.HasError()) { Check.Fail(TEXT("CATALOG_UNAVAILABLE"), Subsystem.GetError()); return nullptr; }
        const auto Handler = Subsystem.GetValue()->ToolsetRegistry.Find(Toolset);
        if (!Handler) { Check.Fail(TEXT("TOOL_UNAVAILABLE"), TEXT("The toolset is absent or disabled in the current native registry.")); return nullptr; }
        TSharedPtr<FJsonObject> Catalog;
        if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Handler->GetJsonSchema()), Catalog) || !Catalog)
        { Check.Fail(TEXT("SCHEMA_UNAVAILABLE"), TEXT("The current native toolset schema is unavailable.")); return nullptr; }
        const TArray<TSharedPtr<FJsonValue>>* Tools = nullptr;
        if (Catalog->TryGetArrayField(TEXT("tools"), Tools)) for (const auto& Entry : *Tools)
        {
            if (!Entry.IsValid() || Entry->Type != EJson::Object) continue;
            const auto Tool = Entry->AsObject();
            FString Name;
            Tool->TryGetStringField(TEXT("name"), Name);
            if (Name != Leaf && Name != Toolset + TEXT(".") + Leaf) continue;
            const TSharedPtr<FJsonObject>* Schema = nullptr;
            if (Tool->TryGetObjectField(TEXT("inputSchema"), Schema)) return *Schema;
        }
    }
    else
    {
        FString Error;
        const auto Catalog = IDSHUnrealBridgeMCPModule::Get().ListTools(Error);
        const TArray<TSharedPtr<FJsonValue>>* Tools = nullptr;
        if (Catalog && Catalog->TryGetArrayField(TEXT("tools"), Tools)) for (const auto& Entry : *Tools)
        {
            if (!Entry.IsValid() || Entry->Type != EJson::Object) continue;
            const auto Tool = Entry->AsObject();
            FString Name;
            Tool->TryGetStringField(TEXT("name"), Name);
            const TSharedPtr<FJsonObject>* Schema = nullptr;
            if (Name == Leaf && Tool->TryGetObjectField(TEXT("inputSchema"), Schema)) return *Schema;
        }
        if (!Error.IsEmpty()) { Check.Fail(TEXT("CATALOG_UNAVAILABLE"), Error); return nullptr; }
    }
    Check.Fail(TEXT("SCHEMA_UNAVAILABLE"), TEXT("The exact enabled tool and input schema could not be found in the current native catalog."));
    return nullptr;
}

bool CheckCall(const FString& ToolName, const TSharedPtr<FJsonObject>& ToolArguments, FCheck& Check,
    FString& SemanticToolset, FString& SemanticLeaf, bool bOperationContext = false)
{
    Check.bResolveOnly = bOperationContext;
    FString Toolset, Leaf = ToolName;
    auto Arguments = ToolArguments;
    bool bValid = Arguments.IsValid();
    if (bValid && ToolName == TEXT("call_tool"))
    {
        Arguments->TryGetStringField(TEXT("toolset_name"), Toolset);
        const TSharedPtr<FJsonObject>* Nested = nullptr;
        bValid = Arguments->TryGetStringField(TEXT("tool_name"), Leaf);
        if (Arguments->TryGetObjectField(TEXT("arguments"), Nested)) Arguments = *Nested;
        else Arguments = MakeShared<FJsonObject>();
    }
    if (Leaf == TEXT("call_tool") || Leaf.EndsWith(TEXT(".call_tool")))
        bValid = Check.Fail(TEXT("UNSUPPORTED"), TEXT("Nested MCP dispatch is not permitted; call the exact discovered tool directly."));
    if (!bValid && Check.Code.IsEmpty()) Check.Fail(TEXT("REFERENCE_SHAPE"), TEXT("The MCP dispatch arguments are invalid."));
    if (bValid)
    {
        SemanticToolset = Toolset;
        SemanticLeaf = Leaf;
        int32 LastDot = INDEX_NONE;
        if (SemanticToolset.IsEmpty() && SemanticLeaf.FindLastChar(TEXT('.'), LastDot))
        {
            SemanticToolset = SemanticLeaf.Left(LastDot);
            SemanticLeaf = SemanticLeaf.Mid(LastDot + 1);
        }
        if (bOperationContext && (SemanticLeaf.IsEmpty() || SemanticLeaf.Contains(TEXT(".")) ||
            (SemanticToolset != TEXT("editor_toolset.toolsets.blueprint.BlueprintTools") &&
             SemanticToolset != TEXT("editor_toolset.toolsets.object.ObjectTools"))))
            return Check.Fail(TEXT("UNSUPPORTED"), TEXT("Operation context only supports exact BlueprintTools and ObjectTools leaf tools."));
        auto Schema = SchemaFor(Toolset, Leaf, Check);
        bValid = Schema.IsValid() && Check.Walk(MakeShared<FJsonValueObject>(Arguments), Schema, FString()) && Check.Ownership(SemanticToolset, SemanticLeaf);
    }
    return bValid;
}

// JSON object member order is not part of the call identity. Preserve every
// value (including caller annotations), sorting only object keys.
FString CanonicalValue(const TSharedPtr<FJsonValue>& Value)
{
    if (Value->Type == EJson::Object)
    {
        TArray<FString> Keys;
        for (const auto& Entry : Value->AsObject()->Values) Keys.Add(FString(*Entry.Key));
        Keys.Sort();
        FString Result = TEXT("{");
        for (const FString& Key : Keys)
            Result += CanonicalValue(MakeShared<FJsonValueString>(Key)) + TEXT(":") + CanonicalValue(Value->AsObject()->TryGetField(Key)) + TEXT(",");
        return Result + TEXT("}");
    }
    if (Value->Type == EJson::Array)
    {
        FString Result = TEXT("[");
        for (const auto& Entry : Value->AsArray()) Result += CanonicalValue(Entry) + TEXT(",");
        return Result + TEXT("]");
    }
    auto Wrapper = MakeShared<FJsonObject>();
    Wrapper->SetField(TEXT("v"), Value);
    FString Result;
    FJsonSerializer::Serialize(Wrapper, TJsonWriterFactory<>::Create(&Result));
    return Result;
}

bool ContextFailure(const TCHAR* Suffix, const TCHAR* Text, TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message)
{
    Code = FString(TEXT("MCP_OPERATION_")) + Suffix;
    Message = Text;
    Details = MakeShared<FJsonObject>();
    Details->SetStringField(TEXT("execution"), TEXT("not_started"));
    Details->SetBoolField(TEXT("retryable"), true);
    return false;
}
}

bool FDSHMcpTargetValidation::Validate(const FString& ToolName, const TSharedPtr<FJsonObject>& ToolArguments,
    TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message)
{
    check(IsInGameThread());
    FCheck Check;
    FString Toolset, Leaf;
    const bool bValid = CheckCall(ToolName, ToolArguments, Check, Toolset, Leaf);
    Details = Check.Details;
    Code = Check.Code;
    Message = Check.Message;
    return bValid;
}

bool FDSHMcpOperationContexts::Inspect(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments, FRecord& Record,
    TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message)
{
    check(IsInGameThread());
    FCheck Check;
    FString Toolset, Leaf;
    if (!CheckCall(ToolName, Arguments, Check, Toolset, Leaf, true))
    {
        Details = Check.Details; Code = Check.Code; Message = Check.Message;
        return false;
    }
    Record.CallName = ToolName;
    Record.CanonicalToolName = Toolset + TEXT(".") + Leaf;
    Record.Arguments = CanonicalValue(MakeShared<FJsonValueObject>(Arguments));
    Record.Bytes = Record.Arguments.GetAllocatedSize();
    auto Remember = [&Record](UObject* Object)
    {
        if (!Record.Identities.ContainsByPredicate([Object](const FIdentity& Entry) { return Entry.Object.Get() == Object; }))
        {
            const FString Path = Object->GetPathName();
            Record.Identities.Add({Path, Object});
            Record.Bytes += Path.GetAllocatedSize() + sizeof(FIdentity);
        }
    };
    for (const FTarget& Target : Check.Targets)
    {
        // Registry metadata cannot bind the identity of an unloaded object.
        if (!IsValid(Target.Object))
            return ContextFailure(TEXT("TARGET_UNLOADED"), TEXT("Operation context requires already-loaded target references; it does not load assets."), Details, Code, Message);
        Remember(Target.Object);
        if (Target.bClassReference) continue;
        // Values assigned to properties are references, not objects being edited.
        if (Toolset == TEXT("editor_toolset.toolsets.object.ObjectTools") && Target.Parameter != TEXT("/instance")) continue;
        UBlueprint* Owner = Cast<UBlueprint>(Target.Object);
        if (Owner && Toolset == TEXT("editor_toolset.toolsets.object.ObjectTools") &&
            (Leaf == TEXT("get_properties") || Leaf == TEXT("set_properties") || Leaf == TEXT("reset_properties")))
        {
            UClass* GeneratedClass = Owner->GeneratedClass;
            UObject* DefaultObject = GeneratedClass ? GeneratedClass->GetDefaultObject(false) : nullptr;
            if (!IsValid(GeneratedClass) || !IsValid(DefaultObject) || GeneratedClass->ClassGeneratedBy != Owner)
                return ContextFailure(TEXT("TARGET_UNLOADED"), TEXT("This ObjectTools operation targets a Blueprint's existing default object; preflight does not create one."), Details, Code, Message);
            Remember(GeneratedClass);
            Remember(DefaultObject);
        }
        UEdGraph* Graph = Cast<UEdGraph>(Target.Object);
        if (UEdGraphNode* Node = Cast<UEdGraphNode>(Target.Object)) Graph = Node->GetGraph();
        if (Graph)
        {
            Remember(Graph);
            Owner = Graph->GetTypedOuter<UBlueprint>();
            if (Owner)
            {
                if (!IsValid(Owner))
                    return ContextFailure(TEXT("OWNER_INVALID"), TEXT("The graph's Blueprint owner is no longer live."), Details, Code, Message);
                TArray<UEdGraph*> Inventory;
                Owner->GetAllGraphs(Inventory);
                if (!Inventory.Contains(Graph))
                    return ContextFailure(TEXT("OWNER_INVALID"), TEXT("The graph is absent from its actual Blueprint's live graph inventory."), Details, Code, Message);
            }
        }
        if (!Owner && Toolset == TEXT("editor_toolset.toolsets.object.ObjectTools"))
        {
            UClass* GeneratedClass = Cast<UClass>(Target.Object);
            if (!GeneratedClass && Target.Object->HasAnyFlags(RF_ClassDefaultObject) &&
                Target.Object->GetClass()->GetDefaultObject(false) == Target.Object)
                GeneratedClass = Target.Object->GetClass();
            if (GeneratedClass)
            {
                UBlueprint* ClassOwner = Cast<UBlueprint>(GeneratedClass->ClassGeneratedBy);
                if (ClassOwner)
                {
                    if (!IsValid(ClassOwner) || (ClassOwner->GeneratedClass != GeneratedClass && ClassOwner->SkeletonGeneratedClass != GeneratedClass))
                        return ContextFailure(TEXT("OWNER_INVALID"), TEXT("The class is absent from its actual Blueprint's generated class inventory."), Details, Code, Message);
                    Owner = ClassOwner;
                    Remember(GeneratedClass);
                }
            }
        }
        if (Owner)
        {
            if (!IsValid(Owner)) return ContextFailure(TEXT("OWNER_INVALID"), TEXT("The Blueprint owner is no longer live."), Details, Code, Message);
            Remember(Owner);
            if (!Record.Owners.ContainsByPredicate([Owner](const FIdentity& Entry) { return Entry.Object.Get() == Owner; }))
            {
                const FString Path = Owner->GetPathName();
                Record.Owners.Add({Path, Owner});
                Record.Bytes += Path.GetAllocatedSize() + sizeof(FIdentity);
            }
        }
    }
    if (Record.Identities.Num() > 4096 || Record.Bytes > 8 * 1024 * 1024)
        return ContextFailure(TEXT("LIMIT"), TEXT("Operation context exceeds its bounded identity or argument capacity."), Details, Code, Message);
    Details.Reset(); Code.Reset(); Message.Reset();
    return true;
}

TSharedPtr<FJsonObject> FDSHMcpOperationContexts::Prepare(const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments,
    TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message)
{
    FRecord Record;
    if (!Inspect(ToolName, Arguments, Record, Details, Code, Message)) return nullptr;
    const double Now = FPlatformTime::Seconds();
    for (auto It = Records.CreateIterator(); It; ++It)
        if (Now - It.Value().Created >= 120.0) It.RemoveCurrent();
    int64 TotalBytes = Record.Bytes;
    for (const auto& Entry : Records) TotalBytes += Entry.Value.Bytes;
    while (!Records.IsEmpty() && (Records.Num() >= 64 || TotalBytes > 16 * 1024 * 1024))
    {
        FString Oldest;
        double OldestTime = TNumericLimits<double>::Max();
        for (const auto& Entry : Records)
            if (Entry.Value.Created < OldestTime) { Oldest = Entry.Key; OldestTime = Entry.Value.Created; }
        TotalBytes -= Records.FindChecked(Oldest).Bytes;
        Records.Remove(Oldest);
    }
    const FString Token = FGuid::NewGuid().ToString(EGuidFormats::DigitsWithHyphens);
    auto Result = MakeShared<FJsonObject>();
    Result->SetBoolField(TEXT("verified"), true);
    Result->SetStringField(TEXT("toolName"), Record.CanonicalToolName);
    Result->SetStringField(TEXT("token"), Token);
    TArray<TSharedPtr<FJsonValue>> Owners;
    for (const FIdentity& Owner : Record.Owners)
    {
        auto Value = MakeShared<FJsonObject>();
        Value->SetStringField(TEXT("path"), Owner.Path);
        Value->SetStringField(TEXT("classPath"), Owner.Object->GetClass()->GetPathName());
        Owners.Add(MakeShared<FJsonValueObject>(Value));
    }
    Result->SetArrayField(TEXT("blueprintOwners"), Owners);
    Record.Created = Now;
    Records.Add(Token, MoveTemp(Record));
    return Result;
}

bool FDSHMcpOperationContexts::Verify(const FString& Token, const FString& ToolName, const TSharedPtr<FJsonObject>& Arguments,
    bool bMutation, TSharedPtr<FJsonObject>& Details, FString& Code, FString& Message)
{
    check(IsInGameThread());
    const FRecord* Previous = Records.Find(Token);
    if (!Previous) return ContextFailure(TEXT("TOKEN_INVALID"), TEXT("The operation token is unknown, consumed, or belongs to another connection; repeat preflight."), Details, Code, Message);
    if (FPlatformTime::Seconds() - Previous->Created >= 120.0)
    {
        Records.Remove(Token);
        return ContextFailure(TEXT("TOKEN_EXPIRED"), TEXT("The operation token expired; repeat preflight."), Details, Code, Message);
    }
    FRecord Current;
    if (!Inspect(ToolName, Arguments, Current, Details, Code, Message)) return false;
    if (Previous->CallName != Current.CallName || Previous->CanonicalToolName != Current.CanonicalToolName || Previous->Arguments != Current.Arguments)
        return ContextFailure(TEXT("CALL_MISMATCH"), TEXT("The call name or arguments changed after operation preflight."), Details, Code, Message);
    auto SameIdentities = [](const TArray<FIdentity>& Before, const TArray<FIdentity>& After)
    {
        if (Before.Num() != After.Num()) return false;
        for (const FIdentity& Entry : Before)
        {
            UObject* Object = Entry.Object.Get();
            if (!IsValid(Object) || Object->GetPathName() != Entry.Path ||
                !After.ContainsByPredicate([&Entry, Object](const FIdentity& Other) { return Other.Path == Entry.Path && Other.Object.Get() == Object; })) return false;
        }
        return true;
    };
    if (!SameIdentities(Previous->Identities, Current.Identities) || !SameIdentities(Previous->Owners, Current.Owners))
        return ContextFailure(TEXT("TARGET_CHANGED"), TEXT("A resolved target, graph, or Blueprint owner moved, expired, or was replaced since preflight."), Details, Code, Message);
    if (bMutation && Current.Owners.Num() > 1)
        return ContextFailure(TEXT("MULTIPLE_OWNERS"), TEXT("A write cannot span multiple Blueprint owners; split it into separately verified operations."), Details, Code, Message);
    // The ownership preflight intentionally allows a stale pin index/direction
    // so the host can attribute a failed repair to its real owner. Execution
    // still requires the original strict schema/pin validation.
    return FDSHMcpTargetValidation::Validate(ToolName, Arguments, Details, Code, Message);
}
