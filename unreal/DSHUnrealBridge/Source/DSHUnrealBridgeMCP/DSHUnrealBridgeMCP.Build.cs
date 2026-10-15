using UnrealBuildTool;

public class DSHUnrealBridgeMCP : ModuleRules
{
    public DSHUnrealBridgeMCP(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "Json" });
        PrivateDependencyModuleNames.AddRange(new[] { "ModelContextProtocol" });
    }
}
