@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  huyou-bridge
echo   - settings console opens in a new window
echo   - scheduler runs here (Ctrl+C to stop)
echo ============================================
echo.
start "huyou-console" cmd /c "node src\console.js"
node src\scheduler.js --loop
echo.
echo scheduler stopped. Press any key to close.
pause >nul
