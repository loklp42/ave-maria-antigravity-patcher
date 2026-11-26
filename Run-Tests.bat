@echo off
setlocal
cd /d "%~dp0"
echo === Gate 1: Running Python Core Tests ===
python tests\run_all_tests.py
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
echo.
echo === Gate 2: Running JS Module Behavior Tests ===
node tests\test_modules_behavior.js
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
echo.
echo === Gate 3: Running Rust Unit Tests ===
where cargo >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] cargo not installed; skipping Rust Gate 3.
    exit /b 0
)
cargo test --lib --manifest-path "patcher\src-tauri\Cargo.toml"
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
echo.
echo [ALL TESTS PASSED]
if /I "%~1"=="--pause" pause
endlocal
