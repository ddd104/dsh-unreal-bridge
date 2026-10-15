@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 (
    echo Cannot open the plugin directory.
    exit /b 1
)

if not "%~2"=="" goto :usage
where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js 22 or newer is required.
    goto :fail
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 22 ? 1 : 0)"
if errorlevel 1 (
    echo Node.js 22 or newer is required.
    goto :fail
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo npm was not found.
    goto :fail
)

echo Building the DSH plugin...
call npm ci
if errorlevel 1 goto :fail
call npm run build
if errorlevel 1 goto :fail
call npm pack --pack-destination ..
if errorlevel 1 goto :fail

if "%~1"=="" goto :dsh_only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -Project "%~f1"
if errorlevel 1 goto :fail
goto :success

:dsh_only
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 goto :fail

:success
echo Installation complete. Restart DSH to load the plugin.
popd
if not defined DSH_BRIDGE_NO_PAUSE pause
exit /b 0

:usage
echo Usage: install-dsh.bat [path-to-project.uproject]

:fail
echo Installation failed. See the message above.
popd
if not defined DSH_BRIDGE_NO_PAUSE pause
exit /b 1
