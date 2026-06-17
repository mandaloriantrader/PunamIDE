@echo off
title PunamIDE v2.0 - Dev Server
echo.
echo  ========================================
echo   PunamIDE v2.0 - Starting Dev Server
echo  ========================================
echo.
cd /d "%~dp0"
cargo tauri dev
pause
