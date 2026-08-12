$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..\..')
$logDir = Join-Path $repoRoot 'logs'
$logPath = Join-Path $logDir 'full-stack-start.log'
$transcriptPath = Join-Path $logDir 'full-stack-start.transcript.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $repoRoot

function Write-StackLog {
  param([string] $Message)
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $logPath -Value $line -Encoding utf8
  Write-Host $Message
}

function Import-DotEnv {
  param([string] $Path)
  if (-not (Test-Path $Path)) { return }

  foreach ($line in Get-Content -LiteralPath $Path) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
    $index = $line.IndexOf('=')
    if ($index -le 0) { continue }

    $name = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1).Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Wait-Docker {
  for ($i = 0; $i -lt 60; $i++) {
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 5
  }
  throw 'Docker did not become ready in time.'
}

function Test-HttpOk {
  param([string] $Url, [int] $TimeoutSeconds = 5)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSeconds
    return [int] $response.StatusCode -ge 200 -and [int] $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Start-CamofoxIfNeeded {
  $port = if ($env:CAMOFOX_PORT) { $env:CAMOFOX_PORT } else { '9377' }
  if (Test-HttpOk "http://localhost:$port/health") {
    Write-StackLog "Camofox already responds on $port."
    return
  }

  $serverPath = Join-Path $env:USERPROFILE '.openclaude\camofox-browser\node_modules\@askjo\camofox-browser\server.js'
  if (-not (Test-Path $serverPath)) {
    Write-StackLog 'Camofox is not installed; skipping browser service startup.'
    return
  }

  Write-StackLog "Starting Camofox on $port."
  Start-Process -FilePath 'node' `
    -ArgumentList @('scripts\release\camofox-control.mjs', 'start') `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden
}

Start-Transcript -Path $transcriptPath -Append | Out-Null
try {
  Import-DotEnv (Join-Path $repoRoot '.env')
  Wait-Docker

  Write-StackLog 'Starting Hindsight memory stack.'
  & node scripts\release\hindsight-control.mjs docker-up
  if ($LASTEXITCODE -ne 0) { throw "Hindsight startup failed with exit code $LASTEXITCODE." }

  Write-StackLog 'Starting OpenClaude, LightRAG, agent gateway, and Open WebUI.'
  & docker compose -f docker-compose.agent-gateway.yml up -d --build
  if ($LASTEXITCODE -ne 0) { throw "Agent Docker startup failed with exit code $LASTEXITCODE." }

  Start-CamofoxIfNeeded
  Write-StackLog 'Full stack startup complete.'
} finally {
  Stop-Transcript | Out-Null
}
