using UnrealBuildTool;
public class DSHUnrealBridge : ModuleRules
{
    public DSHUnrealBridge(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "UnrealEd", "TypedElementRuntime", "Json", "WebSockets", "ContentBrowser", "AssetRegistry", "Kismet", "KismetCompiler", "BlueprintGraph", "GraphEditor", "SubobjectEditor", "SubobjectDataInterface", "MaterialEditor", "Slate", "SlateCore", "DeveloperSettings", "RenderCore", "RHI", "ImageCore", "ToolsetRegistry", "DSHUnrealBridgeMCP", "DSHUnrealBridgeKnowledge" });
    }
}
