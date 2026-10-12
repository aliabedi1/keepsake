$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$RequirementsFile = Join-Path $ProjectRoot 'requirements.txt'
$RequirementsStamp = Join-Path $ProjectRoot '.venv\.requirements.sha256'

Set-Location $ProjectRoot

# Keep local services out of environment-configured proxies while allowing
# Instagram traffic to continue through the user's VPN/proxy.
$LocalBypass = 'localhost,127.0.0.1,::1'
$env:NO_PROXY = (@($env:NO_PROXY, $LocalBypass) | Where-Object { $_ }) -join ','

if (Test-Path $PythonExe) {
  try {
    & $PythonExe --version *> $null
    $PythonReady = $LASTEXITCODE -eq 0
  }
  catch {
    $PythonReady = $false
  }
} else {
  $PythonReady = $false
}

if (-not $PythonReady) {
  Write-Host 'Preparing the local downloader Python environment...'
  python -m venv --clear .venv
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not create the Python virtual environment.'
  }
}

$RequirementsHash = (Get-FileHash -Algorithm SHA256 $RequirementsFile).Hash
$InstalledHash = if (Test-Path $RequirementsStamp) {
  (Get-Content -Raw $RequirementsStamp).Trim()
} else {
  ''
}

if ($InstalledHash -ne $RequirementsHash) {
  Write-Host 'Installing downloader dependencies...'
  & $PythonExe -m pip install --disable-pip-version-check -r requirements.txt
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not install the Python dependencies.'
  }
  Set-Content -Path $RequirementsStamp -Value $RequirementsHash -NoNewline
}

$Backend = Start-Process -FilePath $PythonExe `
  -ArgumentList '-m', 'uvicorn', 'local_backend.app:app', '--host', '127.0.0.1', '--port', '8787' `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardError (Join-Path $ProjectRoot '.venv\backend-stderr.log') `
  -PassThru

$env:WRANGLER_LOG_PATH = '.wrangler/wrangler.log'

try {
  $BackendReady = $false
  for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    if ($Backend.HasExited) { break }
    try {
      $Response = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/status' -TimeoutSec 1
      if ($Response.StatusCode -eq 200) {
        $BackendReady = $true
        break
      }
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $BackendReady) {
    $BackendError = Get-Content (Join-Path $ProjectRoot '.venv\backend-stderr.log') -Tail 20 -ErrorAction SilentlyContinue
    if ($BackendError) { Write-Error ($BackendError -join "`n") }
    throw 'The local download service did not start.'
  }

  Write-Host ''
  Write-Host 'Keepsake is starting at http://127.0.0.1:3000' -ForegroundColor Magenta
  Write-Host 'Press Ctrl+C to stop it.'
  npx vinext dev --hostname 127.0.0.1 --port 3000
}
finally {
  Stop-Process -Id $Backend.Id -Force -ErrorAction SilentlyContinue
}
