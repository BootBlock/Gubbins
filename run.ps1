<#
  Gubbins launcher (PowerShell).

    .\run.ps1            # start the dev server (fast, hot-reload)
    .\run.ps1 preview    # production build, then serve the built app

  If Windows blocks the script with an execution-policy error, run it as:
    powershell -ExecutionPolicy Bypass -File .\run.ps1
  (or right-click run.ps1 and choose "Run with PowerShell").

  Goal: running this should always leave you *inside the app in your browser*,
  reliably, whether or not a server was already up. It does that with a single,
  unified flow:

    1. Is a Gubbins server already answering on the dev port? If so it is ready —
       just open the browser there and exit (no duplicate server, no port shuffle).
    2. Otherwise start the server, WAIT until it genuinely answers HTTP 200, and
       only THEN open the browser — so it never opens against a not-yet-ready
       (or wrong) port. The server runs in the foreground so Ctrl+C tears the whole
       node/vite tree down cleanly (prefer Ctrl+C over the [X] button, which orphans
       it and leaves it squatting on the port).

  Browser: the URL is handed to your DEFAULT browser via the OS (ShellExecute),
  which cleanly activates an already-running browser instead of spawning a second,
  competing browser process — the latter is fragile and was a source of launch
  crashes. The app only needs a modern, cross-origin-isolation-capable browser
  (current Chrome/Edge/Firefox all qualify). Override with $env:BROWSER before
  launching — set it to a browser executable/path to force that browser, or to
  'none' to suppress the auto-open entirely. (The Playwright test harness drives
  Edge separately; that is unrelated to which browser this launcher opens.)
#>
[CmdletBinding()]
param(
  [ValidateSet('dev', 'preview')]
  [string]$Mode = 'dev'
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$BasePath = '/Gubbins/'
# How long to wait for a freshly started server to answer before giving up on the
# auto-open (the server still keeps running; we just print the URL to open manually).
$ReadyTimeoutSec = 60

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
  }
}

function Test-PortListening([int]$Port) {
  $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# Is a *Gubbins* server already answering on this port and serving the page? Confirmed
# via the distinctive cross-origin-isolation header the app serves (spec §2.2.6) plus
# the app shell, so we never reuse — or "open against" — an unrelated server that
# merely holds the port.
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

# Open a URL once, robustly. Prefer the OS default-browser association
# (Start-Process <url> = ShellExecute), which hands the URL to an already-running
# browser cleanly instead of spawning a competing browser process. An explicit
# $env:BROWSER wins (a browser executable/path; 'none' suppresses); on any failure
# we fall back to the default association rather than swallowing the error silently.
function Open-AppUrl([string]$Url) {
  if ($env:BROWSER -eq 'none') { return }

  if ($env:BROWSER) {
    try {
      Start-Process -FilePath $env:BROWSER -ArgumentList $Url -ErrorAction Stop | Out-Null
      return
    }
    catch {
      Write-Host "[WARN] Could not launch '$env:BROWSER' ($($_.Exception.Message)); using your default browser instead." -ForegroundColor Yellow
    }
  }

  try {
    Start-Process $Url -ErrorAction Stop | Out-Null
  }
  catch {
    Write-Host '[WARN] Could not open a browser automatically. Open this URL manually:' -ForegroundColor Yellow
    Write-Host "       $Url" -ForegroundColor Yellow
  }
}

# Start a tiny background job that waits for the server to answer HTTP 200 (up to
# $ReadyTimeoutSec) and then opens the browser exactly once. This lets the dev/preview
# server run in the foreground (so Ctrl+C cleanly stops it) while the open still
# happens only AFTER the server is genuinely ready. The job inlines its own open
# logic because background jobs run in a separate runspace and cannot see the
# functions above. Returns the job (or $null when auto-open is suppressed).
function Start-BrowserOpener([string]$Url) {
  if ($env:BROWSER -eq 'none') { return $null }

  return Start-Job -ScriptBlock {
    param($Url, $Browser, $TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
      try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) {
          try {
            if ($Browser) { Start-Process -FilePath $Browser -ArgumentList $Url -ErrorAction Stop }
            else { Start-Process $Url -ErrorAction Stop }
          }
          catch {
            Start-Process $Url -ErrorAction SilentlyContinue
          }
          return
        }
      }
      catch { }
      Start-Sleep -Milliseconds 400
    }
  } -ArgumentList $Url, $env:BROWSER, $ReadyTimeoutSec
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

  # Never reuse a preview server — it would serve a stale build. Always take a
  # free port (4173 by default) so the freshly built bundle is what you see.
  $port = if (Test-PortListening -Port 4173) { Find-FreePort -Start 4174 } else { 4173 }
  $url = "http://localhost:$port$BasePath"
  Write-Host "Starting Gubbins (preview) at $url" -ForegroundColor Green
  Write-Host 'Your browser will open automatically once the server is ready.' -ForegroundColor DarkGray
  Write-Host 'Press Ctrl+C in this window to stop the server (avoid the [X] button).' -ForegroundColor DarkGray
  Write-Host ''
  Start-BrowserOpener $url | Out-Null
  npm run preview -- --port $port --strictPort
  exit $LASTEXITCODE
}

# --- Dev mode ---
$defaultPort = 5173
$reuse = $false

if (Test-PortListening -Port $defaultPort) {
  if (Test-GubbinsServer -Port $defaultPort) {
    $reuse = $true
    $port = $defaultPort
  }
  else {
    $port = Find-FreePort -Start ($defaultPort + 1)
    Write-Host "Port $defaultPort is in use by another application; using $port instead." -ForegroundColor Yellow
  }
}
else {
  $port = $defaultPort
}

$url = "http://localhost:$port$BasePath"

# (1) A Gubbins server is already up and ready — just open the browser there.
if ($reuse) {
  Write-Host "Gubbins is already running at $url" -ForegroundColor Green
  Write-Host 'Opening it in your browser...' -ForegroundColor DarkGray
  Open-AppUrl $url
  exit 0
}

# (2) Start the server, then open the browser only once it actually answers.
Write-Host "Starting Gubbins at $url" -ForegroundColor Green
Write-Host 'Your browser will open automatically once the server is ready.' -ForegroundColor DarkGray
Write-Host 'Press Ctrl+C in this window to stop the server (avoid the [X] button).' -ForegroundColor DarkGray
Write-Host ''
# --strictPort: we verified the port is free, so fail loudly rather than silently
# shuffling to another port the opener wouldn't know about.
Start-BrowserOpener $url | Out-Null
npm run dev -- --port $port --strictPort
exit $LASTEXITCODE
