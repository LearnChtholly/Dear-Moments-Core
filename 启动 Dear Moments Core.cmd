@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0server.mjs" (
  echo [ERROR] Please extract the whole ZIP first. Do not run this file inside the ZIP preview.
  echo After extraction, double-click this launcher again.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

echo Starting Dear Moments Core...
node "%~dp0server.mjs"
pause
