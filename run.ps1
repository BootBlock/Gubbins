<#
  Gubbins launcher (PowerShell).

    .\run.ps1            # start the dev server (fast, hot-reload)
    .\run.ps1 preview    # production build, then serve the built app

  If Windows blocks the script with an execution-policy error, run it as:
    powershell -ExecutionPolicy Bypass -File .\run.ps1
  (or right-click run.ps1 and choose "Run with PowerShell").
#>
[CmdletBinding()]
param(
  [ValidateSet('dev', 'preview')]
  [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
  }
}

Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Gubbins - local-first inventory tracker' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

# --- Require Node.js ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[ERROR] Node.js was not found on your PATH.' -ForegroundColor Red
  Write-Host 'Install Node.js 20 or newer from https://nodejs.org then run this again.' -ForegroundColor Red
  exit 1
}

# --- Install dependencies on first run ---
if (-not (Test-Path 'node_modules\.bin\vite.cmd')) {
  Write-Host 'Installing dependencies. This only happens on the first run, please wait...' -ForegroundColor Yellow
  npm install
  Assert-LastExitCode 'Dependency installation failed. See the messages above.'
  Write-Host ''
}

if ($Mode -eq 'preview') {
  Write-Host 'Building the production bundle...' -ForegroundColor Yellow
  npm run build
  Assert-LastExitCode 'Build failed. See the messages above.'
  Write-Host ''
  Write-Host 'Opening Gubbins at http://localhost:4173/Gubbins/' -ForegroundColor Green
  Write-Host 'Press Ctrl+C in this window to stop the server.' -ForegroundColor DarkGray
  Write-Host ''
  npm run preview -- --open /Gubbins/
}
else {
  Write-Host 'Opening Gubbins at http://localhost:5173/Gubbins/' -ForegroundColor Green
  Write-Host 'Press Ctrl+C in this window to stop the server.' -ForegroundColor DarkGray
  Write-Host ''
  npm run dev -- --open /Gubbins/
}
