$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $ProjectRoot ".venv\Scripts\cua-desktop-pool.exe"
$Desktop = "smoke-$PID"
$Screenshot = Join-Path $ProjectRoot "screenshots\smoke.png"

try {
    & $Cli create $Desktop
    if ($LASTEXITCODE -ne 0) { throw "Desktop create failed" }
    & $Cli shell $Desktop "printf 'cua-pool-ok\n' && uname -s"
    if ($LASTEXITCODE -ne 0) { throw "Desktop shell failed" }
    & $Cli screenshot $Desktop --out $Screenshot
    if ($LASTEXITCODE -ne 0) { throw "Desktop screenshot failed" }
}
finally {
    & $Cli destroy $Desktop --yes
}
