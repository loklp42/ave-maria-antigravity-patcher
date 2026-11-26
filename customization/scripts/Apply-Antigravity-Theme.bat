@echo off
setlocal
set "PS_SCRIPT=%~dp0Apply-Antigravity-Theme.ps1"
if not exist "%PS_SCRIPT%" (
    set "PS_SCRIPT=%LOCALAPPDATA%\Programs\antigravity\resources\Apply-Antigravity-Theme.ps1"
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
if errorlevel 1 exit /b %ERRORLEVEL%
endlocal
