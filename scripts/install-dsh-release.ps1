[CmdletBinding()]
param(
    [string]$Archive,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Profile = 'desktop',
    [string]$DshCli = $env:DSH_CLI
)
$ErrorActionPreference = 'Stop'
$DshCli = & (Join-Path $PSScriptRoot 'resolve-dsh-cli.ps1') -DshCli $DshCli
if (-not $Archive) {
    $archives = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'dsh-unreal-bridge-*.tgz' -File)
    if ($archives.Count -ne 1) { throw 'Keep exactly one plugin .tgz beside this script, or pass -Archive with its full path.' }
    $Archive = $archives[0].FullName
}
$Archive = (Resolve-Path -LiteralPath $Archive).Path
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf) -or [IO.Path]::GetExtension($Archive) -ne '.tgz') { throw 'Archive must be an existing .tgz file.' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileRoot = Join-Path $dshHome ('profiles\' + $Profile)
if (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'package.json'))) { throw "DSH profile '$Profile' was not found. Open DSH once to initialize it, or select -Profile." }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backup = Join-Path $profileRoot ('.plugin-manager\dsh-unreal-bridge-backups\' + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml')) {
    $file = Join-Path $profileRoot $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup $name) }
}
$archiveHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
$archiveStore = Join-Path $profileRoot '.plugin-manager\dsh-unreal-bridge-archives'
New-Item -ItemType Directory -Path $archiveStore -Force | Out-Null
$stagedArchive = Join-Path $archiveStore ("dsh-unreal-bridge-$archiveHash.tgz")
if (-not (Test-Path -LiteralPath $stagedArchive)) { Copy-Item -LiteralPath $Archive -Destination $stagedArchive }
if ((Get-FileHash -LiteralPath $stagedArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) { throw 'Stored archive checksum mismatch.' }
& $DshCli plugin --profile $Profile add ("file:" + $stagedArchive) --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "DSH installation failed. Config backup: $backup" }
Write-Output "Installed DSH profile: $Profile"
Write-Output "DSH config backup: $backup"
Write-Output 'Fully exit DSH (including the system tray), then reopen it to load the plugin.'
