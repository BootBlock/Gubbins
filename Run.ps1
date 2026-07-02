<#
  Gubbins launcher (PowerShell).

    .\Run.ps1                      # start the dev server (fast, hot-reload)
    .\Run.ps1 preview              # production build, then serve the built app
    .\Run.ps1 -BindHost localhost  # bind/open via localhost instead of 127.0.0.1
    .\Run.ps1 -Port 8080           # serve on a specific port instead of 5173
    .\Run.ps1 -NoOpen              # start the server but don't open a browser
    .\Run.ps1 -Browser firefox     # open the app in a specific browser

  If Windows blocks the script with an execution-policy error, run it as:
    powershell -ExecutionPolicy Bypass -File .\Run.ps1
  (or right-click Run.ps1 and choose "Run with PowerShell").

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

  Host: by default the server binds — and the browser opens — the concrete IPv4 loopback
  address 127.0.0.1, NOT the name "localhost". On Windows "localhost" resolves to both ::1
  (IPv6) and 127.0.0.1 (IPv4), but Vite only binds ONE of them (typically ::1); if the
  browser then tries the other first it gets a connection-refused "unable to connect" page
  and you have to reload. Pinning both ends to the same literal address removes that race.
  Pass -BindHost localhost (or set $env:GUBBINS_DEV_HOST=localhost) to keep the localhost
  origin instead — Vite is then bound dual-stack so localhost always finds a live socket, at
  the cost of a one-time Windows Firewall prompt and the dev server being visible on the LAN.

  Browser: the URL is handed to your DEFAULT browser via the OS (ShellExecute),
  which cleanly activates an already-running browser instead of spawning a second,
  competing browser process — the latter is fragile and was a source of launch
  crashes. The app only needs a modern, cross-origin-isolation-capable browser
  (current Chrome/Edge/Firefox all qualify). Force a particular browser with
  -Browser <exe|path> (or the legacy $env:BROWSER), or skip the auto-open with
  -NoOpen (equivalently -Browser none / $env:BROWSER='none'). (The Playwright test
  harness drives Edge separately; that is unrelated to which browser this launcher opens.)
#>
[CmdletBinding()]
param(
  [ValidateSet('dev', 'preview')]
  [string]$Mode = 'dev',

  # Which host Vite binds and the browser opens against. Defaults to 127.0.0.1 (a concrete
  # loopback address) so the browser connects to exactly the socket Vite bound, avoiding the
  # Windows localhost IPv4/IPv6 resolve-mismatch that shows a spurious "unable to connect" on
  # the first open. Use 'localhost' to keep the localhost origin (bound dual-stack for
  # reliability; see the header comment). $env:GUBBINS_DEV_HOST overrides the default.
  [string]$BindHost = $(if ($env:GUBBINS_DEV_HOST) { $env:GUBBINS_DEV_HOST } else { '127.0.0.1' }),

  # Port to serve on. 0 (the default) means auto: 5173 for dev / 4173 for preview, falling
  # back to the next free port if that one is already taken. A non-zero value pins the port.
  [ValidateRange(0, 65535)]
  [int]$Port = 0,

  # Force a specific browser to open the app: a browser executable name or full path (e.g.
  # 'firefox', or a full path to chrome.exe), or 'none' to suppress the auto-open. Overrides
  # $env:BROWSER. Ignored when -NoOpen is given.
  [string]$Browser = '',

  # Start the server but don't open a browser at all — just print the URL. Handy for headless
  # boxes, driving the app from an already-open tab, or scripting.
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$BasePath = '/Gubbins/'
# How long to wait for a freshly started server to answer before giving up on the
# auto-open (the server still keeps running; we just print the URL to open manually).
$ReadyTimeoutSec = 60

# The host as it appears in a URL (an IPv6 literal must be bracketed: ::1 -> [::1]).
$UrlHost = if ($BindHost -match ':') { "[$BindHost]" } else { $BindHost }

# The `--host` argument handed to Vite. A concrete address binds exactly that socket, so the
# browser (opening the same literal address) can never land on an unbound stack. The sole
# exception is the name 'localhost': binding it directly is single-stack and reintroduces the
# resolve-mismatch race, so we bind Vite dual-stack (bare `--host`) instead — leaving BOTH
# loopback sockets live so however the browser resolves localhost it reaches a listening server.
$ViteHostArgs = if ($BindHost -ieq 'localhost') { @('--host') } else { @('--host', $BindHost) }

# Which browser (if any) to open the app with. -NoOpen wins, then the -Browser parameter,
# then the legacy $env:BROWSER, else '' meaning "use the OS default-browser association".
# 'none' anywhere suppresses the auto-open. Threaded into the open helpers so they don't read
# ambient state directly (and so the ready-poller background job gets it as an argument).
$BrowserChoice = if ($NoOpen) { 'none' } elseif ($Browser) { $Browser } elseif ($env:BROWSER) { $env:BROWSER } else { '' }
$AutoOpen = $BrowserChoice -ne 'none'

# The "what happens next" line under the start banner, phrased for whether we'll auto-open.
$ReadyHint = if ($AutoOpen) {
  'Your browser will open automatically once the server is ready.'
} else {
  'Auto-open is off (-NoOpen); open the URL above in your browser once it is ready.'
}

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
function Test-GubbinsServer([int]$Port, [string]$UrlHost) {
  try {
    $resp = Invoke-WebRequest -Uri "http://${UrlHost}:$Port$BasePath" -UseBasicParsing -TimeoutSec 4
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
# $Browser wins (a browser executable/path; 'none' suppresses); on any failure
# we fall back to the default association rather than swallowing the error silently.
function Open-AppUrl([string]$Url, [string]$Browser) {
  if ($Browser -eq 'none') { return }

  if ($Browser) {
    try {
      Start-Process -FilePath $Browser -ArgumentList $Url -ErrorAction Stop | Out-Null
      return
    }
    catch {
      Write-Host "[WARN] Could not launch '$Browser' ($($_.Exception.Message)); using your default browser instead." -ForegroundColor Yellow
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
function Start-BrowserOpener([string]$Url, [string]$Browser) {
  if ($Browser -eq 'none') { return $null }

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
  } -ArgumentList $Url, $Browser, $ReadyTimeoutSec
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
  # free port (4173 by default, or the requested -Port) so the freshly built bundle is
  # what you see; fall back to the next free port only when auto-picking.
  $previewPort = if ($Port -gt 0) { $Port } else { 4173 }
  $port = if (Test-PortListening -Port $previewPort) { Find-FreePort -Start ($previewPort + 1) } else { $previewPort }
  $url = "http://${UrlHost}:$port$BasePath"
  Write-Host "Starting Gubbins (preview) at $url" -ForegroundColor Green
  Write-Host $ReadyHint -ForegroundColor DarkGray
  Write-Host 'Press Ctrl+C in this window to stop the server (avoid the [X] button).' -ForegroundColor DarkGray
  Write-Host ''
  Start-BrowserOpener $url $BrowserChoice | Out-Null
  npm run preview -- --port $port --strictPort $ViteHostArgs
  exit $LASTEXITCODE
}

# --- Dev mode ---
$defaultPort = if ($Port -gt 0) { $Port } else { 5173 }
$reuse = $false

if (Test-PortListening -Port $defaultPort) {
  if (Test-GubbinsServer -Port $defaultPort -UrlHost $UrlHost) {
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

$url = "http://${UrlHost}:$port$BasePath"

# (1) A Gubbins server is already up and ready — just open the browser there.
if ($reuse) {
  Write-Host "Gubbins is already running at $url" -ForegroundColor Green
  if ($AutoOpen) {
    Write-Host 'Opening it in your browser...' -ForegroundColor DarkGray
  } else {
    Write-Host 'Auto-open is off (-NoOpen); open the URL above in your browser.' -ForegroundColor DarkGray
  }
  Open-AppUrl $url $BrowserChoice
  exit 0
}

# (2) Start the server, then open the browser only once it actually answers.
Write-Host "Starting Gubbins at $url" -ForegroundColor Green
Write-Host $ReadyHint -ForegroundColor DarkGray
Write-Host 'Press Ctrl+C in this window to stop the server (avoid the [X] button).' -ForegroundColor DarkGray
Write-Host ''
# --strictPort: we verified the port is free, so fail loudly rather than silently
# shuffling to another port the opener wouldn't know about.
Start-BrowserOpener $url $BrowserChoice | Out-Null
npm run dev -- --port $port --strictPort $ViteHostArgs
exit $LASTEXITCODE
