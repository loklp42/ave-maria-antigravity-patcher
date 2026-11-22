@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\antigravity\resources\Apply-Antigravity-Theme.ps1"
if errorlevel 1 pause
