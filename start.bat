@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm are required to run X-Engine.
  exit /b 1
)

if not exist "node_modules" (
  call npm install
)

start "" /min cmd /c "npm start"
timeout /t 8
start "" http://localhost:3000
endlocal
