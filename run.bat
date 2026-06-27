@echo off
setlocal
cd /d "%~dp0"

title Gubbins
echo ============================================
echo   Gubbins - local-first inventory tracker
echo ============================================
echo.

REM --- Require Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo Install Node.js 20 or newer from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

REM --- Install dependencies on first run ---
if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies. This only happens on the first run, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed. See the messages above.
    pause
    exit /b 1
  )
  echo.
)

set "MODE=%~1"

if /i "%MODE%"=="preview" (
  echo Building the production bundle...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed. See the messages above.
    pause
    exit /b 1
  )
  echo.
  echo Opening Gubbins at http://localhost:4173/Gubbins/
  echo Press Ctrl+C in this window to stop the server.
  echo.
  call npm run preview -- --open /Gubbins/
) else (
  echo Opening Gubbins at http://localhost:5173/Gubbins/
  echo Press Ctrl+C in this window to stop the server.
  echo.
  call npm run dev -- --open /Gubbins/
)

endlocal
