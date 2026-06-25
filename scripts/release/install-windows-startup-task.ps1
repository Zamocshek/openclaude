$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..\..')
$startupScript = Join-Path $scriptDir 'start-full-stack.ps1'
$taskName = if ($env:OPENCLAUDE_STARTUP_TASK_NAME) { $env:OPENCLAUDE_STARTUP_TASK_NAME } else { 'OpenClaude Agent Stack' }
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startupScript`""

function Install-StartupShortcut {
  $startupFolder = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startupFolder "$taskName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = 'powershell.exe'
  $shortcut.Arguments = $argument
  $shortcut.WorkingDirectory = [string] $repoRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Starts the OpenClaude agent stack after Windows logon.'
  $shortcut.Save()
  Write-Host "Registered startup shortcut: $shortcutPath"
}

try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Starts the OpenClaude agent gateway, Open WebUI, OpenRAG, Hindsight, and Camofox after Windows logon.' `
    -Force | Out-Null

  Write-Host "Registered scheduled task: $taskName"
} catch {
  Write-Warning "Scheduled task registration failed: $($_.Exception.Message)"
  Install-StartupShortcut
}
