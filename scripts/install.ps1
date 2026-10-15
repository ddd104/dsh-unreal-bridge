[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Project,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Profile = 'desktop',
    [string]$DshCli = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    [string]$Archive
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
if (-not $Archive) {
    $release = (Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version
    $Archive = Join-Path (Split-Path -Parent $packageRoot) ("dsh-unreal-bridge-$release.tgz")
}
$projectFile = (Resolve-Path -LiteralPath $Project).Path
if ([IO.Path]::GetExtension($projectFile) -ne '.uproject') { throw 'Project must be an existing .uproject file.' }
$projectRoot = Split-Path -Parent $projectFile
$profileRoot = Join-Path $(if ($env:DSH_HOME) {$env:DSH_HOME} else {Join-Path $env:USERPROFILE '.dsh'}) ('profiles\' + $Profile)
foreach ($required in @($DshCli, $Archive, (Join-Path $profileRoot 'package.json'), (Join-Path $packageRoot 'unreal\DSHUnrealBridge\DSHUnrealBridge.uplugin'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required file: $required" }
}
$runningEditor = Get-CimInstance Win32_Process -Filter "Name = 'UnrealEditor.exe' OR Name = 'UnrealEditor-Cmd.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($projectFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
if ($runningEditor) { throw 'Close this project in Unreal Editor before installing. No process has been stopped.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backup = Join-Path $profileRoot ('.plugin-manager\dsh-unreal-bridge-backups\' + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml')) {
    $file = Join-Path $profileRoot $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup $name) }
}
& $DshCli plugin --profile $Profile add ("file:" + (Resolve-Path -LiteralPath $Archive).Path) --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "DSH installation failed. Config backup: $backup" }
$destination = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Plugins\DSHUnrealBridge'))
if (Test-Path -LiteralPath $destination) {
    if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to overwrite a linked plugin directory.' }
    if (-not (Test-Path -LiteralPath (Join-Path $destination 'DSHUnrealBridge.uplugin'))) { throw "Refusing to overwrite an unrelated folder: $destination" }
    $ueBackup = Join-Path $projectRoot ('Saved\DSHUnrealBridgeBackups\' + $stamp)
    New-Item -ItemType Directory -Path $ueBackup -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination $ueBackup -Recurse
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $packageRoot 'unreal\DSHUnrealBridge') | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}
Write-Output "Installed DSH profile: $Profile"
Write-Output "Installed UE plugin: $destination"
Write-Output "DSH config backup: $backup"
Write-Output 'Open Unreal Editor and restart DSH if the Unreal Editor conversation panel has not appeared.'
