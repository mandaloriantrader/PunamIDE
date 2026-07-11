@echo off
title PunamIDE v2.0 - Dev Server
echo.
echo  ========================================
echo   PunamIDE v2.0 - Starting Dev Server
echo  ========================================
echo.
cd /d "%~dp0"

echo Checking Rust backend before starting the app...
cargo check --manifest-path "src-tauri\Cargo.toml"
if errorlevel 1 (
  echo.
  echo Rust backend check failed. Fix the errors above before starting dev mode.
  pause
  exit /b 1
)

echo Rust backend check passed.
echo.
cargo tauri dev
pause
