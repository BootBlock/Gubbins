<#
  Gubbins launcher (PowerShell).

    .\run.ps1            # start the dev server (fast, hot-reload)
    .\run.ps1 preview    # production build, then serve the built app

  If Windows blocks the script with an execution-policy error, run it as:
    powershell -ExecutionPolicy Bypass -File .\run.ps1
  (or right-click run.ps1 and choose "Run with PowerShell").

  Robust against the classic Windows footgun: closing this console with the [X]
  button orphans the child node/vite process, which keeps squatting on the dev
  port. On the next launch a naive `vite` silently shuffles to 5174, and the
  browser — opened a moment too early against the wrong/late port — shows
  "unable to connect".

  This script avoids that by:
    1. PROBING the target port. If a Gubbins server already answers there (an
       orphan from a previous run, or a second launch), it just opens the browser
       at that exact URL and exits — no duplicate server, no port shuffle.
    2. If the port is held by some *other* application, picking the next free port.
    3. Pinning Vite with --strictPort on a port we verified is free, and letting
       Vite's own --open open the actual bound port (no URL mismatch, no race).

  Tip: stop the server with Ctrl+C in this window rather than the [X], so the
  whole node/vite process tree is torn down cleanly.

  Browser: the auto-open prefers system Edge (the browser this project is
  validated against — Playwright drives msedge), falling back to your default
  browser when Edge isn't installed. Override by setting $env:BROWSER before
  launching: a browser executable name/path to use, or 'none' to suppress the
  auto-open entirely (handy if your default browser is misbehaving).
#>
[CmdletBinding()]
param(
  [ValidateSet('dev', 'preview')]
  [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$BasePath = '/Gubbins/'

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
  }
}

function Test-PortListening([int]$Port) {
  $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# Is a *Gubbins* dev/preview server already answering on this port? Confirmed via
# the distinctive cross-origin-isolation header the app serves (spec §2.2.6) plus
# the app shell, so we never reuse an unrelated server that merely holds the port.
function Test-GubbinsServer([int]$Port) {
  try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$Port$BasePath" -UseBasicParsing -TimeoutSec 4
    $coop = [string]$resp.Headers['Cross-Origin-Opener-Policy']
    return ($resp.StatusCode -eq 200 -and $coop -eq 'same-origin' -and $resp.Content -match 'Gubbins')
  }
  catch {
    return $false
  }
}

function Find-FreePort([int]$Start) {
  for ($p = $Start; $p -lt ($Start + 50); $p++) {
    if (-not (Test-PortListening -Port $p)) { return $p }
  }
  throw "No free port found in range $Start-$($Start + 49)."
}

# Resolve the system Edge executable (App Paths registry first, then the standard
# install locations). Returns $null when Edge is not installed.
function Get-EdgePath {
  foreach ($root in @('HKLM:', 'HKCU:')) {
    $key = "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
    try {
      $val = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
      if ($val -and (Test-Path -LiteralPath $val)) { return $val }
    }
    catch { }
  }
  foreach ($candidate in @(
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

# Open a URL in the preferred browser: an explicit $env:BROWSER override wins
# ('none' suppresses), else system Edge, else the OS default browser.
function Open-AppUrl([string]$Url) {
  if ($env:BROWSER -eq 'none') { return }
  if ($env:BROWSER) {
    Start-Process -FilePath $env:BROWSER -ArgumentList $Url -ErrorAction SilentlyContinue | Out-Null
    return
  }
  $edge = Get-EdgePath
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList $Url -ErrorAction SilentlyContinue | Out-Null
  }
  else {
    Start-Process $Url | Out-Null
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

# Prefer system Edge for Vite's own --open (dev/preview). Vite honours $env:BROWSER
# (a browser executable/path, or 'none' to suppress), so pointing it at Edge means a
# broken or misbehaving default browser never blocks development. A pre-set value is
# left untouched as the user's explicit override.
if (-not $env:BROWSER) {
  $edgePath = Get-EdgePath
  if ($edgePath) { $env:BROWSER = $edgePath }
}

if ($Mode -eq 'preview') {
  Write-Host 'Building the production bundle...' -ForegroundColor Yellow
  npm run build
  Assert-LastExitCode 'Build failed. See the messages above.'
  Write-Host ''

  # Never reuse a preview server — it would serve a stale build. Always take a
  # free port (4173 by default) so the freshly built bundle is what you see.
  $port = if (Test-PortListening -Port 4173) { Find-FreePort -Start 4174 } else { 4173 }
  Write-Host "Opening Gubbins (preview) at http://localhost:$port$BasePath" -ForegroundColor Green
  Write-Host 'Press Ctrl+C in this window to stop the server (avoid the [X] button).' -ForegroundColor DarkGray
  Write-Host ''
  npm run preview -- --port $port --strictPort --open $BasePath
  exit $LASTEXITCODE
}

# --- Dev mode ---
$defaultPort = 5173

if (Test-PortListening -Port $defaultPort) {
  if (Test-GubbinsServer -Port $defaultPort) {
    Write-Host "Gubbins is already running at http://localhost:$defaultPort$BasePath" -ForegroundColor Green
    Write-Host 'Reusing the existing dev server and opening your browser there.' -ForegroundColor DarkGray
    Open-AppUrl "http://localhost:$defaultPort$BasePath"
    exit 0
  }

  $port = Find-FreePort -Start ($defaultPort + 1)
  Write-Host "Port $defaultPort is in use by another application; using $port instead." -ForegroundColor Yellow
}
else {
  $port = $defaultPort
}

Write-Host "Opening Gubbins at http://localhost:$port$BasePath" -ForegroundColor Green
Write-Host 'Press Ctrl+C in this window to stop the server (avoid the [X] button).' -ForegroundColor DarkGray
Write-Host ''
# --strictPort: we verified the port is free, so fail loudly rather than silently
# shuffling. Vite's own --open opens the actual bound port (no URL mismatch/race).
npm run dev -- --port $port --strictPort --open $BasePath
exit $LASTEXITCODE
