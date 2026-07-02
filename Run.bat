@echo off
setlocal
cd /d "%~dp0"

REM Gubbins launcher. The real logic lives in Run.ps1 (single source of truth) so
REM that it can probe the dev port, reuse an already-running server, and pick a
REM free port if 5173 is busy — none of which batch can do reliably.
REM
REM   Run.bat                      start the dev server (fast, hot-reload)
REM   Run.bat preview              production build, then serve the built app
REM   Run.bat -BindHost localhost  bind/open via localhost instead of 127.0.0.1
REM   Run.bat -Port 8080           serve on a specific port instead of 5173
REM   Run.bat -NoOpen              start the server but don't open a browser
REM   Run.bat -Browser firefox     open the app in a specific browser
REM
REM By default the server binds and opens 127.0.0.1 (a concrete loopback address) rather
REM than "localhost", which sidesteps the Windows IPv4/IPv6 resolve race that showed a
REM spurious "unable to connect" on the first open (a page reload used to be needed).
REM
REM Stop the server with Ctrl+C in this window rather than the [X] button, so the
REM whole node/vite process tree is torn down cleanly (the [X] orphans it).

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Run.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

REM Keep the window open on failure so the error is readable (a clean Ctrl+C or a
REM reuse-and-exit returns 0 and closes quietly).
if not "%EXITCODE%"=="0" (
  echo.
  pause
)

endlocal & exit /b %EXITCODE%
