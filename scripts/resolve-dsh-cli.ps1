[CmdletBinding()]
param(
    [string]$DshCli,
    [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'

function Find-DshCli([string]$Location) {
    if ([string]::IsNullOrWhiteSpace($Location)) { return $null }
    $Location = [Environment]::ExpandEnvironmentVariables($Location.Trim().Trim('"'))
    if (Test-Path -LiteralPath $Location -PathType Leaf) {
        if ([IO.Path]::GetFileName($Location) -ieq 'dsh.cmd') {
            return (Resolve-Path -LiteralPath $Location).Path
        }
        $Location = Split-Path -Parent $Location
    }
    foreach ($relative in @(
        'resources\runtime\cli\bin\dsh.cmd',
        'runtime\cli\bin\dsh.cmd',
        'cli\bin\dsh.cmd',
        'bin\dsh.cmd',
        'dsh.cmd'
    )) {
        $candidate = Join-Path $Location $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

if ($DshCli) {
    $resolved = Find-DshCli $DshCli
    if ($resolved) { Write-Output $resolved; return }
    Write-Warning "DSH_CLI does not point to a DSH installation: $DshCli"
}

$locations = [Collections.Generic.List[string]]::new()
foreach ($command in @(Get-Command dsh.cmd -All -CommandType Application -ErrorAction SilentlyContinue)) {
    if ($command.Source) { $locations.Add($command.Source) }
}
foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $locations.Add((Join-Path $root 'Programs\DeepSeek Harness'))
    $locations.Add((Join-Path $root 'DeepSeek Harness'))
}
foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $programs = if ($root -eq $env:LOCALAPPDATA) { Join-Path $root 'Programs' } else { $root }
    if (Test-Path -LiteralPath $programs -PathType Container) {
        foreach ($directory in @(Get-ChildItem -LiteralPath $programs -Directory -ErrorAction SilentlyContinue)) {
            if ($directory.Name -match 'DeepSeek|Harness|DSH') { $locations.Add($directory.FullName) }
        }
    }
}
foreach ($registry in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)) {
    foreach ($app in @(Get-ItemProperty -Path $registry -ErrorAction SilentlyContinue | Where-Object DisplayName -Like '*DeepSeek Harness*')) {
        if ($app.InstallLocation) { $locations.Add($app.InstallLocation) }
        if ($app.DisplayIcon) { $locations.Add(($app.DisplayIcon -replace ',\d+$', '')) }
    }
}
foreach ($process in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
    if ($process.Path) { $locations.Add($process.Path) }
}

foreach ($location in $locations) {
    $resolved = Find-DshCli $location
    if ($resolved) { Write-Output $resolved; return }
}

if (-not $NoPrompt) {
    Write-Host 'DSH CLI was not found automatically.'
    $chosen = Read-Host 'Enter the DSH installation folder or the full path to dsh.cmd'
    $resolved = Find-DshCli $chosen
    if ($resolved) { Write-Output $resolved; return }
}
throw 'DSH CLI was not found. Install DSH or set DSH_CLI to its installation folder or the full path to dsh.cmd.'
