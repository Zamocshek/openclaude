param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("all", "generic", "cursor", "claude", "codex", "openclaw", "opencode-v1", "opencode-v2")]
    [string]$Client,
    [switch]$Apply
)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $ProjectRoot ".venv\Scripts\cua-desktop-pool.exe"
$Arguments = @("connect", "--client", $Client)
if ($Apply) { $Arguments += "--apply" }
& $Cli @Arguments
