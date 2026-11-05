[CmdletBinding()]
param(
  [string]$Date = "",
  [switch]$NoPush,
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
$env:NODE_NO_WARNINGS = "1"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$root = if ($ProjectRoot) {
  (Resolve-Path $ProjectRoot).Path
} elseif ($env:FUND_TRADE_PROJECT_ROOT) {
  (Resolve-Path $env:FUND_TRADE_PROJECT_ROOT).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}
$env:FUND_TRADE_PROJECT_ROOT = $root
$collectDir = Join-Path $root ".fund-trading\collect"
$reportDir = Join-Path $root ".fund-trading\reports"
$logDir = Join-Path $root ".fund-trading\logs"

New-Item -ItemType Directory -Force -Path $collectDir, $reportDir, $logDir | Out-Null

if (-not $Date) { $Date = Get-Date -Format "yyyy-MM-dd" }
$logFile = Join-Path $logDir "close-$Date.log"

function Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $message
  [System.IO.File]::AppendAllText($logFile, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path "D:\nodejs\node.exe")) { $node = "D:\nodejs\node.exe" }
if (-not $node) {
  Log "node not found"
  exit 1
}

Log "===== close report $Date start ====="

$parsed = [datetime]::ParseExact($Date, "yyyy-MM-dd", $null)
if ($parsed.DayOfWeek -eq "Saturday" -or $parsed.DayOfWeek -eq "Sunday") {
  Log "non-trading day, skip"
  exit 0
}

$settleOutput = & $node (Join-Path $PSScriptRoot "settle.mjs") 2>> $logFile
Log ("settle: " + (($settleOutput | Out-String).Trim()))

$collectScript = Join-Path $PSScriptRoot "collect.mjs"
$collectOutput = & $node $collectScript $Date --close 2>> $logFile
Log ("collect close: " + (($collectOutput | Out-String).Trim()))
$collectFile = Join-Path $collectDir "$Date.json"
if (-not (Test-Path $collectFile)) {
  Log "collect failed, abort"
  exit 1
}

$reportText = (& $node (Join-Path $PSScriptRoot "report-close.mjs") $collectFile) | Out-String
$reportFile = Join-Path $reportDir "close-$Date.md"
[System.IO.File]::WriteAllText($reportFile, $reportText, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $reportDir "latest-close.md"), $reportText, (New-Object System.Text.UTF8Encoding($false)))
Log "close report written: $reportFile"

if ($NoPush) {
  Log "NoPush: skip delivery"
} else {
  $notifyOutput = & $node (Join-Path $PSScriptRoot "notify.mjs") --file $reportFile --date $Date --kind close 2>> $logFile
  $notifyExit = $LASTEXITCODE
  Log ("notify exit=$notifyExit " + (($notifyOutput | Out-String).Trim()))
}

Log "===== done ====="
exit 0
