using UnrealBuildTool;
using System.IO;

public class DSHUnrealBridgeKnowledge : ModuleRules
{
    public DSHUnrealBridgeKnowledge(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "Json" });
        PrivateDependencyModuleNames.AddRange(new[] {
            "AssetRegistry", "BlueprintGraph", "Projects", "Slate", "SlateCore", "ToolMenus", "UnrealEd"
        });
    }
}
