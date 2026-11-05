[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$DailyTime = "14:30",
  [string]$CloseTime = "15:30",
  [ValidateSet("otc", "exchange")]
  [string]$Market = "otc",
  [switch]$NoDaily,
  [switch]$NoClose,
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result([object]$Payload, [int]$Code = 0) {
  $Payload | ConvertTo-Json -Depth 6 -Compress
  exit $Code
}

try {
  if ($DailyTime -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw "DailyTime must use HH:mm"
  }
  if ($CloseTime -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw "CloseTime must use HH:mm"
  }

  if (-not $ProjectRoot) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
  } else {
    $ProjectRoot = (Resolve-Path $ProjectRoot).Path
  }

  $reportDir = Join-Path $ProjectRoot ".commandcode\fund-report"
  if (-not (Test-Path $reportDir)) {
    throw "fund-report not found: $reportDir. Install the full project, not only the skill folder."
  }

  $definitions = @()
  if (-not $NoDaily) {
    $definitions += [pscustomobject]@{
      id = "FundDailyReport"
      type = "daily"
      time = $DailyTime
      market = $Market
      script = (Join-Path $reportDir "run-daily.ps1")
      extra = "-Market $Market"
    }
  }
  if (-not $NoClose) {
    $definitions += [pscustomobject]@{
      id = "FundDailyClose"
      type = "close"
      time = $CloseTime
      market = $null
      script = (Join-Path $reportDir "run-close.ps1")
      extra = ""
    }
  }

  if (-not $Uninstall -and $definitions.Count -eq 0) {
    throw "Nothing to register: both daily and close tasks are disabled"
  }

  $tasks = @()
  foreach ($definition in $definitions) {
    if (-not (Test-Path $definition.script)) {
      throw "Task script not found: $($definition.script)"
    }

    $argumentsText = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($definition.script)`""
    if ($definition.extra) {
      $argumentsText = "$argumentsText $($definition.extra)"
    }

    $registered = $false
    $removed = $false

    if ($Uninstall) {
      $existing = Get-ScheduledTask -TaskName $definition.id -ErrorAction SilentlyContinue
      if ($existing) {
        if (-not $DryRun) {
          Unregister-ScheduledTask -TaskName $definition.id -Confirm:$false
        }
        $removed = $true
      }
    } elseif (-not $DryRun) {
      $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argumentsText
      $trigger = New-ScheduledTaskTrigger -Daily -At $definition.time
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName $definition.id -Action $action -Trigger $trigger -Settings $settings -Description "Managed by fund-trading skill" -Force | Out-Null
      Enable-ScheduledTask -TaskName $definition.id | Out-Null
      $registered = $true
    }

    $tasks += [pscustomobject]@{
      id = $definition.id
      type = $definition.type
      time = $definition.time
      market = $definition.market
      script = $definition.script
      action = $argumentsText
      registered = $registered
      removed = $removed
    }
  }

  Write-Result ([pscustomobject]@{
    ok = $true
    platform = "win32"
    projectRoot = $ProjectRoot
    reportDir = $reportDir
    dryRun = [bool]$DryRun
    uninstall = [bool]$Uninstall
    tasks = $tasks
  })
} catch {
  Write-Result ([pscustomobject]@{
    ok = $false
    error = $_.Exception.Message
  }) 1
}
