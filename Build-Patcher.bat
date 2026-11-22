@echo off
setlocal
cd /d "%~dp0patcher"
set CARGO_HTTP_MULTIPLEXING=false
cargo tauri build --no-bundle
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed!
    exit /b %ERRORLEVEL%
)
copy /Y "src-tauri\target\release\ave-maria-patcher.exe" "..\AntigravityPatcher.exe" >nul
echo [OK] Built ..\AntigravityPatcher.exe
endlocal
