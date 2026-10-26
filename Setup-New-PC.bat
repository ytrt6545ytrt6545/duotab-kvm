@echo off
rem =========================================================
rem DuoTab-KVM New PC Setup Launcher (Pure 7-Bit ASCII)
rem Trampoline to PowerShell UTF-8 script with Admin support
rem =========================================================
cd /d "%~dp0"
title DuoTab-KVM Host Setup Wizard

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-host-prerequisites.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Setup script exited with error code %ERRORLEVEL%.
    pause
)
