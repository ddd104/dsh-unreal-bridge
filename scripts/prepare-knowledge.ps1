[CmdletBinding()]
param([string]$NodeSource)
$ErrorActionPreference = 'Stop'
$pluginRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'unreal\DSHUnrealBridge'
$runtimeRoot = Join-Path $pluginRoot 'Runtime\Win64'
$nodePath = Join-Path $runtimeRoot 'node.exe'
$expectedHash = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
if ($NodeSource) {
    $resolvedSource = (Resolve-Path -LiteralPath $NodeSource).Path
    if ((Get-FileHash -LiteralPath $resolvedSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'The supplied Node runtime does not match the pinned Node.js 24.15.0 release.'
    }
    if ($resolvedSource -ne $nodePath) { Copy-Item -LiteralPath $resolvedSource -Destination $nodePath -Force }
}
if (-not (Test-Path -LiteralPath $nodePath)) {
    $download = Join-Path $runtimeRoot 'node.exe.download'
    try {
        Invoke-WebRequest -Uri 'https://nodejs.org/dist/v24.15.0/win-x64/node.exe' -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
            throw 'Downloaded Node runtime failed SHA256 verification.'
        }
        Move-Item -LiteralPath $download -Destination $nodePath -Force
    } finally {
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
    }
}
if ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Bundled Node runtime failed SHA256 verification.'
}
$toolsRoot = Join-Path $pluginRoot 'Tools'
Push-Location $toolsRoot
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge dependency installation failed.' }
    & $nodePath (Join-Path $toolsRoot 'build.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge TypeScript build failed.' }
    $modulesDir = [IO.Path]::GetFullPath((Join-Path $toolsRoot 'node_modules'))
    $toolsBoundary = [IO.Path]::GetFullPath($toolsRoot).TrimEnd('\') + '\'
    if (-not $modulesDir.StartsWith($toolsBoundary, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Dependency cleanup path escaped the knowledge tools directory.'
    }
    if (Test-Path -LiteralPath $modulesDir) {
        if ((Get-Item -LiteralPath $modulesDir).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Refusing to remove a linked dependency directory.'
        }
        Remove-Item -LiteralPath $modulesDir -Recurse -Force
    }
} finally { Pop-Location }
Write-Output "Prepared project knowledge tools: $pluginRoot"
