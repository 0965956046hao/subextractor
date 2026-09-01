# Start capcut-tts-api service + backend (uvicorn) + frontend (Next.js dev) together
# Usage: .\dev.ps1   (Windows PowerShell - equivalent of ./dev.sh on macOS/Linux)
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads non-BOM files as ANSI).

$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$BACKEND = Join-Path $ROOT "backend"
$FRONTEND = Join-Path $ROOT "frontend"
$CAPCUT = Join-Path $ROOT "capcut-tts-api"
$DS2API = Join-Path $ROOT "ds2api"
$DS2API_PORT = if ($env:DS2API_PORT) { $env:DS2API_PORT } else { "5001" }

$PYTHON = Join-Path $BACKEND ".venv\Scripts\python.exe"
$UVICORN = Join-Path $BACKEND ".venv\Scripts\uvicorn.exe"
$LOG = Join-Path $env:TEMP "subextractor-dev"
New-Item -ItemType Directory -Force -Path $LOG | Out-Null

$procs = @()

# ── Kill ALL leftover project processes before starting ─────────────────────
function Kill-ProjectOrphans {
    Write-Host "==> Cleaning up leftover processes from this project..."
    $patterns = @(
        "uvicorn.*app\.main",
        "service\.main",
        "next.*dev",
        "ds2api"
    )
    foreach ($pattern in $patterns) {
        $procs = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$pattern%'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -match [regex]::Escape($ROOT)) {
                Write-Host "    Killing orphan: PID $($p.ProcessId) - $($p.Name)"
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    # Also kill any python/node using our backend/frontend dirs
    $allProcs = Get-Process -Name "python", "node" -ErrorAction SilentlyContinue
    foreach ($p in $allProcs) {
        try {
            $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CommandLine
            if ($cmd -match [regex]::Escape($ROOT)) {
                Write-Host "    Killing orphan: PID $($p.Id) - $($p.ProcessName)"
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    Start-Sleep -Milliseconds 500
}

Kill-ProjectOrphans

function Start-BgProcess($name, $file, [string[]]$argsList, $workdir, $logName) {
  $p = Start-Process -FilePath $file -ArgumentList $argsList -WorkingDirectory $workdir `
    -RedirectStandardOutput (Join-Path $LOG "$logName.log") `
    -RedirectStandardError (Join-Path $LOG "$logName.err.log") -PassThru
  Write-Host "==> $name started (PID $($p.Id))  logs: $LOG"
  return $p
}

function Start-FgProcess($name, $file, [string[]]$argsList, $workdir) {
  Write-Host "==> Starting $name (foreground)  http://localhost:8001"
  Push-Location $workdir
  try {
    & $file @argsList
  } finally {
    Pop-Location
  }
}

function Start-NewWindow($name, $file, [string[]]$argsList, $workdir) {
  Write-Host "==> Starting $name in NEW WINDOW  http://localhost:8002"
  $argStr = $argsList -join ' '
  $scriptBlock = "cd '$workdir'; & '$file' $argStr; Read-Host 'Press Enter to close...'"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $scriptBlock -WorkingDirectory $workdir
}

# Pre-flight: free the port before starting. Kills orphan processes of THIS
# project (next dev / uvicorn / service.main with our ROOT in the command
# line); otherwise warns and skips so we never kill foreign services.
function Test-EnsurePortFree($port, $desc) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $c) { return $true }
  $ownPid = $c[0].OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownPid" -ErrorAction SilentlyContinue
  $cmd = if ($proc) { $proc.CommandLine } else { "" }
  if ($cmd -match [regex]::Escape($ROOT)) {
    Write-Host "==> Port $port busy by orphan PID $ownPid (this project) - killing it"
    Stop-Process -Id $ownPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    return $true
  }
  Write-Warning "Port $port in use by PID $ownPid (not this project) - skipping $desc"
  return $false
}

try {
  if (-not (Test-Path $PYTHON)) { throw "venv not found at $PYTHON - create it with: python -m venv backend\.venv" }

  if (Test-EnsurePortFree 8002 "backend") {
    Write-Host "==> Starting backend  http://localhost:8002"
    Write-Host "    (backend runs in SEPARATE WINDOW - logs visible there)"
    # Start capcut-tts-api in background first
    if (Test-Path $CAPCUT) {
      if (Test-EnsurePortFree 8100 "capcut-tts-api") {
        Write-Host "==> Starting capcut-tts-api service  http://localhost:8100"
        $procs += Start-BgProcess "capcut-tts-api" $PYTHON @("-m", "service.main") $CAPCUT "capcut"
      }
    }
    # Run backend in NEW window (logs visible in its own terminal)
    Start-NewWindow "backend" $UVICORN @("app.main:app", "--reload", "--port", "8002") $BACKEND
    # Wait a moment for backend to start
    Start-Sleep -Seconds 3
  }

  if (Test-Path $DS2API) {
    $ds2bin = Join-Path $DS2API "ds2api.exe"
    if (-not (Test-Path $ds2bin)) {
      $goExe = Get-Command go -ErrorAction SilentlyContinue
      if (-not $goExe) {
        Write-Warning "go not found - skipping ds2api (install Go or build ds2api.exe manually)"
      } else {
        Write-Host "==> Building ds2api (go build)..."
        try {
          $gb = Start-Process -FilePath $goExe.Source -ArgumentList @("build", "-o", "ds2api.exe", ".\cmd\ds2api") -WorkingDirectory $DS2API -Wait -PassThru -NoNewWindow
          if ($gb.ExitCode -ne 0) { Write-Warning "ds2api build failed - skipping ds2api" }
        } catch {
          Write-Warning "ds2api build failed ($($_.Exception.Message)) - skipping ds2api"
        }
      }
    }
    if (Test-Path $ds2bin) {
      if (Test-EnsurePortFree ([int]$DS2API_PORT) "ds2api") {
        Write-Host "==> Starting ds2api  http://localhost:$DS2API_PORT"
        $oldKey = $env:DS2API_ADMIN_KEY; $oldPort = $env:PORT
        $env:DS2API_ADMIN_KEY = if ($env:DS2API_ADMIN_KEY) { $env:DS2API_ADMIN_KEY } else { "test-admin" }
        $env:PORT = $DS2API_PORT
        try {
          $procs += Start-BgProcess "ds2api" $ds2bin @() $DS2API "ds2api"
        } finally {
          $env:DS2API_ADMIN_KEY = $oldKey; $env:PORT = $oldPort
        }
      }
    }
  } else {
    Write-Host "==> Skipping ds2api (no $DS2API directory)"
  }

  if (Test-EnsurePortFree 3000 "frontend") {
    Write-Host "==> Starting frontend http://localhost:3000"
    Write-Host "    (frontend runs in foreground - press Ctrl+C to stop everything)"
    Push-Location $FRONTEND
    try {
      npm run dev
    } finally {
      Pop-Location
    }
  }
} finally {
  Write-Host ""
  Write-Host "Stopping services..."
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "All stopped."
}