@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Huyou settings
echo  - browser opens automatically
echo  - keep this window open while using it
echo  - close this window to stop the page
echo ============================================
echo.
node src\console.js
echo.
echo console stopped. Press any key to close.
pause >nul
