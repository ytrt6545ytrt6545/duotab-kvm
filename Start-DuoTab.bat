@echo off
rem =========================================================
rem DuoTab-KVM Host Server Launcher (Pure 7-Bit ASCII)
rem =========================================================
cd /d "%~dp0"
title DuoTab-KVM Host Server

echo [DuoTab-KVM] Starting Host Server...
echo [DuoTab-KVM] Working Directory: %~dp0
echo [DuoTab-KVM] Press Ctrl+C in this window to stop the server.
echo.

node server/index.mjs
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Server terminated unexpectedly with exit code %ERRORLEVEL%.
    echo Please make sure Node.js is installed and run Setup-New-PC.bat if needed.
    pause
)
