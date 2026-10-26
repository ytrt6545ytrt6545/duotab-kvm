@echo off
setlocal
cd /d "%~dp0\.."
node scripts\monitor-stream.mjs
endlocal
