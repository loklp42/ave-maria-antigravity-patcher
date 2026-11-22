@echo off
setlocal
cd /d "%~dp0"
echo === Running Python Core Tests ===
python tests\run_all_tests.py
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
echo.
echo === Running JS Module Behavior Tests ===
node tests\test_modules_behavior.js
if %ERRORLEVEL% NEQ 0 exit /b %ERRORLEVEL%
echo.
echo [ALL TESTS PASSED]
pause
endlocal
