$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv is required: https://docs.astral.sh/uv/getting-started/installation/"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI is not available. Start Docker Desktop first."
}

uv sync --python 3.11
if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

& ".\.venv\Scripts\cua-desktop-pool.exe" build-image
if ($LASTEXITCODE -ne 0) { throw "Docker image build failed" }

& ".\.venv\Scripts\cua-desktop-pool.exe" connect --client all
if ($LASTEXITCODE -ne 0) { throw "MCP config generation failed" }

& ".\.venv\Scripts\cua-desktop-pool.exe" doctor
