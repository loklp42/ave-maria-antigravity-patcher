@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0AntigravityPatcher.exe" (
    echo [ERROR] AntigravityPatcher.exe not found. Run Build-Patcher.bat first.
    exit /b 1
)
start "" "%~dp0AntigravityPatcher.exe"
endlocal
