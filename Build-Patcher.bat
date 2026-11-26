@echo off
setlocal
cd /d "%~dp0patcher"
if not exist "node_modules\" (
    echo [INFO] Installing frontend dependencies...
    call npm ci --no-fund --no-audit
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] npm ci failed!
        exit /b %ERRORLEVEL%
    )
)
set CARGO_HTTP_MULTIPLEXING=false
cargo tauri build --no-bundle
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed!
    exit /b %ERRORLEVEL%
)
if not exist "src-tauri\target\release\ave-maria-patcher.exe" (
    echo [ERROR] Built binary not found at src-tauri\target\release\ave-maria-patcher.exe
    exit /b 1
)
copy /Y "src-tauri\target\release\ave-maria-patcher.exe" "..\AntigravityPatcher.exe" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to copy executable to repository root!
    exit /b %ERRORLEVEL%
)
echo [OK] Built ..\AntigravityPatcher.exe
endlocal
