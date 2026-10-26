@echo off
rem ===================================================
rem DuoTab-KVM Virtual Client Simulator
rem ===================================================
cd /d "%~dp0"
echo [DuoTab-KVM] Running Virtual Tablet Simulation...
node scripts/demo-simulate.mjs
pause
