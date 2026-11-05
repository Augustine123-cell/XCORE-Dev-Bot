@echo off
cd /d "%~dp0"
if not exist node_modules (
  call npm install --omit=dev
)
node src\index.js
pause
