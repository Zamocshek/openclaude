param(
  [ValidateSet("init", "doctor", "import-codex", "up", "down", "verify", "status")]
  [string]$Command = "up",
  [switch]$Full,
  [string]$CodexSource = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required. Install it from https://nodejs.org/ and retry."
}

$arguments = @("scripts/release/portable-control.mjs", $Command)
if ($Command -eq "import-codex" -and $CodexSource) {
  $arguments += $CodexSource
}
if ($Full) {
  $arguments += "--full"
}

& node @arguments
exit $LASTEXITCODE
