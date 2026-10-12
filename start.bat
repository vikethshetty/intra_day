@echo off
setlocal
title Live Intraday Analyzer launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "backend\.env" (
  echo Creating backend\.env from backend\.env.example ...
  copy "backend\.env.example" "backend\.env" >nul
)

if not exist "backend\node_modules" (
  echo Installing backend dependencies ...
  pushd backend
  call npm install
  popd
)
if not exist "frontend\node_modules" (
  echo Installing frontend dependencies ...
  pushd frontend
  call npm install
  popd
)

echo Starting backend  on http://localhost:5000
start "Analyzer Backend - http://localhost:5000" cmd /k "cd /d %~dp0backend && npm run dev"

echo Starting frontend on http://localhost:5173
start "Analyzer Frontend - http://localhost:5173" cmd /k "cd /d %~dp0frontend && npm run dev"

timeout /t 6 /nobreak >nul
start "" http://localhost:5173
echo.
echo Two windows were opened (backend and frontend). Close them to stop the app.
endlocal
