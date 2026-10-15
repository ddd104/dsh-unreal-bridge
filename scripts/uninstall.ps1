[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Project,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Profile = 'desktop',
    [string]$DshCli = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
)
$ErrorActionPreference = 'Stop'
$projectFile = (Resolve-Path -LiteralPath $Project).Path
if ([IO.Path]::GetExtension($projectFile) -ne '.uproject') { throw 'Project must be an existing .uproject file.' }
$projectRoot = Split-Path -Parent $projectFile
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Plugins'))
$target = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'DSHUnrealBridge'))
if ((Split-Path -Parent $target) -ne $pluginRoot -or (Split-Path -Leaf $target) -ne 'DSHUnrealBridge') { throw 'Unexpected plugin path.' }
$runningEditor = Get-CimInstance Win32_Process -Filter "Name = 'UnrealEditor.exe' OR Name = 'UnrealEditor-Cmd.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($projectFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
if ($runningEditor) { throw 'Close this project in Unreal Editor before uninstalling. No process has been stopped.' }
if (Test-Path -LiteralPath $target) {
    if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to move a linked plugin directory.' }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'DSHUnrealBridge.uplugin'))) { throw 'Refusing to move an unrelated folder.' }
}
& $DshCli plugin --profile $Profile remove dsh-unreal-bridge
if ($LASTEXITCODE -ne 0) { throw 'DSH package removal failed; UE plugin was left in place.' }
if (Test-Path -LiteralPath $target) {
    $backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'Saved\DSHUnrealBridgeBackups'))
    $backup = [IO.Path]::GetFullPath((Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-removed')))
    if (-not $backup.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected backup path.' }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Move-Item -LiteralPath $target -Destination (Join-Path $backup 'DSHUnrealBridge')
    Write-Output "UE plugin archived: $backup"
}
Write-Output 'Uninstalled. Restart DSH and Unreal Editor. Blueprint assets have not been changed.'
