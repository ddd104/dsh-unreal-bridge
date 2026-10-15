using UnrealBuildTool;
public class DSHUnrealBridge : ModuleRules
{
    public DSHUnrealBridge(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "UnrealEd", "Json", "WebSockets", "ContentBrowser", "AssetRegistry", "Kismet", "KismetCompiler", "BlueprintGraph", "GraphEditor", "Slate", "SlateCore", "DeveloperSettings", "DSHUnrealBridgeMCP" });
    }
}
