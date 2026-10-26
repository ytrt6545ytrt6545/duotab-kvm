@echo off
rem ===================================================
rem DuoTab-KVM Host Server Launcher (ASCII Trampoline)
rem ===================================================
cd /d "%~dp0"
echo [DuoTab-KVM] Starting Host Server...
node server/index.mjs
pause
