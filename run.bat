@echo off
setlocal
cd /d "%~dp0"

REM Gubbins launcher. The real logic lives in run.ps1 (single source of truth) so
REM that it can probe the dev port, reuse an already-running server, and pick a
REM free port if 5173 is busy — none of which batch can do reliably.
REM
REM   run.bat            start the dev server (fast, hot-reload)
REM   run.bat preview    production build, then serve the built app
REM
REM Stop the server with Ctrl+C in this window rather than the [X] button, so the
REM whole node/vite process tree is torn down cleanly (the [X] orphans it).

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

REM Keep the window open on failure so the error is readable (a clean Ctrl+C or a
REM reuse-and-exit returns 0 and closes quietly).
if not "%EXITCODE%"=="0" (
  echo.
  pause
)

endlocal & exit /b %EXITCODE%
