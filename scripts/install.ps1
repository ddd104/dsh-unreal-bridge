[CmdletBinding()]
param(
    [string]$Project,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Profile = 'desktop',
    [string]$DshCli = $env:DSH_CLI,
    [string]$Archive
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$DshCli = & (Join-Path $PSScriptRoot 'resolve-dsh-cli.ps1') -DshCli $DshCli
if (-not $Archive) {
    $release = (Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version
    $Archive = Join-Path (Split-Path -Parent $packageRoot) ("dsh-unreal-bridge-$release.tgz")
}
if ($Project) {
    $projectFile = (Resolve-Path -LiteralPath $Project).Path
    if ([IO.Path]::GetExtension($projectFile) -ne '.uproject') { throw 'Project must be an existing .uproject file.' }
    $projectRoot = Split-Path -Parent $projectFile
}
$profileRoot = Join-Path $(if ($env:DSH_HOME) {$env:DSH_HOME} else {Join-Path $env:USERPROFILE '.dsh'}) ('profiles\' + $Profile)
$requiredFiles = @($DshCli, $Archive, (Join-Path $profileRoot 'package.json'))
if ($Project) { $requiredFiles += (Join-Path $packageRoot 'unreal\DSHUnrealBridge\DSHUnrealBridge.uplugin') }
foreach ($required in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required file: $required" }
}
if ($Project) {
    $runningEditor = Get-CimInstance Win32_Process -Filter "Name = 'UnrealEditor.exe' OR Name = 'UnrealEditor-Cmd.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($projectFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    if ($runningEditor) { throw 'Close this project in Unreal Editor before installing. No process has been stopped.' }
    & (Join-Path $PSScriptRoot 'prepare-knowledge.ps1')
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backup = Join-Path $profileRoot ('.plugin-manager\dsh-unreal-bridge-backups\' + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml')) {
    $file = Join-Path $profileRoot $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup $name) }
}
& $DshCli plugin --profile $Profile add ("file:" + (Resolve-Path -LiteralPath $Archive).Path) --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "DSH installation failed. Config backup: $backup" }
Write-Output "Installed DSH profile: $Profile"
Write-Output "DSH config backup: $backup"
if (-not $Project) {
    Write-Output 'Restart DSH to load the plugin.'
    return
}
$destination = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Plugins\DSHUnrealBridge'))
$knowledgeConfig = Join-Path $destination 'Config\Knowledge\ProjectMemory.project.json'
$preservedKnowledgeConfig = if (Test-Path -LiteralPath $knowledgeConfig) { [IO.File]::ReadAllBytes($knowledgeConfig) } else { $null }
if (Test-Path -LiteralPath $destination) {
    if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to overwrite a linked plugin directory.' }
    if (-not (Test-Path -LiteralPath (Join-Path $destination 'DSHUnrealBridge.uplugin'))) { throw "Refusing to overwrite an unrelated folder: $destination" }
    $ueBackup = Join-Path $projectRoot ('Saved\DSHUnrealBridgeBackups\' + $stamp)
    New-Item -ItemType Directory -Path $ueBackup -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination $ueBackup -Recurse
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$sourcePlugin = Join-Path $packageRoot 'unreal\DSHUnrealBridge'
Get-ChildItem -LiteralPath $sourcePlugin | Where-Object { $_.Name -notin @('Tools','Cache','Binaries','Intermediate') } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}
$destinationTools = Join-Path $destination 'Tools'
New-Item -ItemType Directory -Path $destinationTools -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $sourcePlugin 'Tools') | Where-Object Name -ne 'node_modules' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destinationTools -Recurse -Force
}
if ($null -ne $preservedKnowledgeConfig) { [IO.File]::WriteAllBytes($knowledgeConfig, $preservedKnowledgeConfig) }
$legacyCache = Join-Path $projectRoot 'Plugins\AgentProjectGraph\Cache'
if ((Test-Path -LiteralPath $legacyCache) -and -not (Test-Path -LiteralPath (Join-Path $destination 'Cache\identity.json'))) {
    foreach ($folder in @('UE','Evidence','Experiences')) {
        $legacyFolder = Join-Path $legacyCache $folder
        $newFolder = Join-Path $destination ('Cache\' + $folder)
        if ((Test-Path -LiteralPath $legacyFolder) -and -not (Test-Path -LiteralPath $newFolder)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $newFolder) -Force | Out-Null
            Copy-Item -LiteralPath $legacyFolder -Destination $newFolder -Recurse
        }
    }
    Write-Output 'Copied existing UE snapshots and evidence; rebuild graph and memory from the editor menu.'
}
$legacyPlugin = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Plugins\AgentProjectGraph'))
if (Test-Path -LiteralPath (Join-Path $legacyPlugin 'AgentProjectGraph.uplugin')) {
    $pluginsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Plugins')).TrimEnd('\') + '\'
    $savedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Saved\DSHUnrealBridgeBackups')).TrimEnd('\') + '\'
    $legacyBackup = [IO.Path]::GetFullPath((Join-Path $savedRoot ($stamp + '\AgentProjectGraph')))
    if (-not $legacyPlugin.StartsWith($pluginsRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not $legacyBackup.StartsWith($savedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Legacy plugin migration path escaped the project directories.'
    }
    if ((Get-Item -LiteralPath $legacyPlugin).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing to move a linked legacy plugin directory.'
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $legacyBackup) -Force | Out-Null
    Move-Item -LiteralPath $legacyPlugin -Destination $legacyBackup
    Write-Output "Disabled legacy AgentProjectGraph plugin; backup: $legacyBackup"
}
Write-Output "Installed UE plugin: $destination"
Write-Output 'Open Unreal Editor and restart DSH if the Unreal Editor conversation panel has not appeared.'
