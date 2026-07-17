@echo off
echo ============================================
echo  PunamIDE v2.0 - Windows Installer Build
echo  Building MSI + NSIS packages...
echo  Output log: build_output.log
echo ============================================
echo.

cd /d "e:\App build-Android-desktop\Projects\Windows\punam-IDe v2.0\PunamIde v2.0"

echo [%date% %time%] Build started > build_output.log

echo [1/3] Building frontend... >> build_output.log
call npx tauri build --bundles msi,nsis >> build_output.log 2>&1

if %ERRORLEVEL% EQU 0 (
    echo [%date% %time%] BUILD SUCCEEDED >> build_output.log
    echo.
    echo ============================================
    echo  BUILD SUCCEEDED!
    echo  Check these folders:
    echo    src-tauri\target\release\bundle\msi\
    echo    src-tauri\target\release\bundle\nsis\
    echo ============================================
) else (
    echo [%date% %time%] BUILD FAILED (exit code: %ERRORLEVEL%) >> build_output.log
    echo.
    echo ============================================
    echo  BUILD FAILED!
    echo  See build_output.log for details
    echo ============================================
)

echo.
echo Full log saved to build_output.log
pause