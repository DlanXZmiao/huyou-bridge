@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  capture one PUBLISH request (with image)
echo  1) pick a circle
echo  2) write something, add an image
echo  3) click publish
echo  4) come back here and press Enter
echo ============================================
echo.
node scripts\capture-publish.mjs
echo.
echo done. press any key to close.
pause >nul
