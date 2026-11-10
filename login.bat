@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Huyou login / capture
echo  1) log in with phone + SMS code
echo  2) post ONE test comment on any feed
echo  3) it exports automatically after that
echo ============================================
echo.
node src\login.mjs
echo.
echo Done. Press any key to close this window.
pause >nul
