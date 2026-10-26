@echo off
rem =========================================================
rem DuoTab-KVM Host Server Launcher (Desktop Trampoline)
rem =========================================================
title DuoTab-KVM Host Server
cd /d "d:\AI-made\projects\duotab-kvm"
echo [DuoTab-KVM] Starting Host Server on port 5858...
echo [DuoTab-KVM] Please keep this window open while connected.
node server/index.mjs
pause
