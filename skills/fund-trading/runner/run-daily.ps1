[CmdletBinding()]
param(
  [string]$Date = "",
  [switch]$NoPush,
  [switch]$SkipAgent,
  [switch]$ReuseNews,
  [int]$Limit = 0,
  [string]$Model = "",
  [string]$Market = "",
  [string]$AgentAdapter = "",
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
$env:NODE_NO_WARNINGS = "1"
if ($Market) {
  if ($Market -notin @("otc", "exchange")) {
    Write-Error "Market must be otc or exchange"
    exit 1
  }
  $env:FUND_TRADE_MARKET = $Market
}
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
$agentDir = Join-Path $PSScriptRoot "agent"
$skillDir = Split-Path $PSScriptRoot -Parent

New-Item -ItemType Directory -Force -Path $collectDir, $reportDir, $logDir, $agentDir | Out-Null

if (-not $Date) { $Date = Get-Date -Format "yyyy-MM-dd" }
$logFile = Join-Path $logDir "$Date.log"

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

$adapter = if ($AgentAdapter) {
  $AgentAdapter
} elseif ($env:FUND_TRADE_AGENT_ADAPTER) {
  $env:FUND_TRADE_AGENT_ADAPTER
} elseif ($env:FUND_TRADE_AGENT_CMD) {
  $env:FUND_TRADE_AGENT_CMD
} else {
  $null
}
$adapterPath = $null
if ($adapter) {
  $resolved = Resolve-Path $adapter -ErrorAction SilentlyContinue
  if ($resolved) { $adapterPath = $resolved.Path } else { Log "agent adapter not found: $adapter" }
}

$cli = $env:FUND_TRADE_CLI
if (-not $cli) {
  foreach ($name in @("command-code", "cmdc")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { $cli = $command.Source; break }
  }
}
if (-not $cli) {
  $fallback = "D:\Command Code\resources\app\node_modules\command-code\dist\index.mjs"
  if (Test-Path $fallback) { $cli = $fallback }
}

$settingsOutput = & $node (Join-Path $PSScriptRoot "settings.mjs") --json 2>> $logFile
$settings = ($settingsOutput | Out-String) | ConvertFrom-Json
if (-not $settings) {
  $settings = [pscustomobject]@{ autoExecute = $true; queriesPerFund = 3; maxTurns = 60; reportMaxTurns = 20; model = "" }
}
if (-not $Model) { $Model = $settings.model }

function Run-Agent([string]$prompt, [int]$maxTurns, [string]$tag) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $promptFile = Join-Path $agentDir "prompt-$tag-$stamp.md"
  [System.IO.File]::WriteAllText($promptFile, $prompt, (New-Object System.Text.UTF8Encoding($false)))

  if ($adapterPath) {
    $outputFile = Join-Path $agentDir "result-$tag-$stamp.txt"
    Push-Location $agentDir
    try {
      & $adapterPath -PromptFile $promptFile -OutputFile $outputFile -MaxTurns $maxTurns -Model $Model 2>> $logFile
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if (-not (Test-Path $outputFile)) {
      Log "$tag adapter failed: no output file (exit=$exitCode)"
      return $null
    }
    $text = [System.IO.File]::ReadAllText($outputFile, [System.Text.Encoding]::UTF8).Trim()
    if (-not $text) {
      Log "$tag adapter returned empty output (exit=$exitCode)"
      return $null
    }
    Log "$tag ok via adapter: chars=$($text.Length)"
    return $text
  }
  if (-not $cli) {
    Log "$tag skipped: no --AgentAdapter, FUND_TRADE_AGENT_CMD or supported CLI"
    return $null
  }

  $isScript = $cli -match '\.(mjs|js)$'
  $cliArgs = @(
    "-p", $prompt,
    "--output-format", "json",
    "--yolo",
    "--skip-onboarding",
    "--no-auto-update",
    "--add-dir", $root,
    "--skill", $skillDir,
    "--max-turns", "$maxTurns"
  )
  if ($Model) { $cliArgs += @("-m", $Model) }

  Push-Location $agentDir
  try {
    if ($isScript) {
      $output = & $node $cli @cliArgs 2>> $logFile
    } else {
      $output = & $cli @cliArgs 2>> $logFile
    }
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  $joined = ($output | Out-String)
  $result = $null
  foreach ($line in ($joined -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed.StartsWith("{")) { continue }
    try { $candidate = $trimmed | ConvertFrom-Json } catch { continue }
    if ($candidate.type -eq "result") { $result = $candidate }
  }
  if ($null -eq $result) {
    Log "$tag failed: no result line (exit=$exitCode)"
    return $null
  }
  if ($result.subtype -ne "success") {
    Log "$tag failed: subtype=$($result.subtype) exit=$exitCode"
    return $null
  }
  Log "$tag ok: in=$($result.usage.inputTokens) out=$($result.usage.outputTokens) ms=$([int]$result.durationMs)"
  return [string]$result.finalText
}

Log "===== fund report $Date start ====="

$settleOutput = & $node (Join-Path $PSScriptRoot "settle.mjs") 2>> $logFile
Log ("settle: " + (($settleOutput | Out-String).Trim()))

$collectScript = Join-Path $PSScriptRoot "collect.mjs"
$collectOutput = & $node $collectScript $Date 2>> $logFile
Log ("collect: " + (($collectOutput | Out-String).Trim()))
$collectFile = Join-Path $collectDir "$Date.json"
if (-not (Test-Path $collectFile)) {
  Log "collect failed, abort"
  exit 1
}

$collect = [System.IO.File]::ReadAllText($collectFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$codes = @($collect.watchlist | ForEach-Object { $_.code })
if ($Limit -gt 0) {
  $count = [Math]::Min($Limit, $codes.Count)
  $codes = @($codes[0..($count - 1)])
}
Log ("watchlist: " + ($codes -join ", "))

$verdictFile = Join-Path $collectDir "verdicts-$Date.json"

if (-not $SkipAgent -and -not $ReuseNews) {
  $promptA = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "prompt-a.md"), [System.Text.Encoding]::UTF8)
  $promptA = $promptA.Replace("{{DATE}}", $Date).Replace("{{COLLECT}}", $collectFile).Replace("{{NEWSDIR}}", $collectDir).Replace("{{QUERIES}}", "$($settings.queriesPerFund)")
  if ($Limit -gt 0) {
    $promptA = $promptA + "`r`nOnly process these fund codes: " + ($codes -join ", ")
  }
  Log "PhaseA: web search start"
  $phaseA = Run-Agent $promptA ([int]$settings.maxTurns) "PhaseA"
  Log ("PhaseA output: " + ($phaseA -replace "`r?`n", " | "))
}

if (-not $SkipAgent) {
  if ($ReuseNews) { Log "ReuseNews: skip web search, reuse existing news files" }
  $newsScan = Join-Path $skillDir "scripts\news.mjs"
  $verdicts = [ordered]@{}
  foreach ($code in $codes) {
    $newsFile = Join-Path $collectDir "news-$Date-$code.json"
    if (Test-Path $newsFile) {
      $scanOutput = & $node $newsScan scan $code --input $newsFile --json 2>> $logFile
      $scanExit = $LASTEXITCODE
      $scanText = ($scanOutput | Out-String).Trim()
      if ($scanText.Length -gt 200) { $scanText = $scanText.Substring(0, 200) }
      Log ("scan $code exit=$scanExit " + $scanText)
    } else {
      Log "scan $code skipped: no $newsFile"
    }
    $verdictOutput = (& $node $newsScan verdict $code --json 2>> $logFile) | Out-String
    $verdictOutput = $verdictOutput.Trim()
    if ($verdictOutput.StartsWith("{")) {
      try { $verdicts[$code] = ($verdictOutput | ConvertFrom-Json) } catch { Log "verdict $code parse failed" }
    }
  }
  [System.IO.File]::WriteAllText($verdictFile, ($verdicts | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
}

$adviceFile = Join-Path $collectDir "advice-$Date.json"
$adviceOutput = & $node (Join-Path $PSScriptRoot "advice.mjs") $collectFile $verdictFile $adviceFile 2>> $logFile
Log ("advice: " + (($adviceOutput | Out-String).Trim()))

$executeOutput = & $node (Join-Path $PSScriptRoot "execute.mjs") $collectFile $adviceFile $Date 2>> $logFile
Log ("execute: " + (($executeOutput | Out-String).Trim()))

$collectOutput2 = & $node $collectScript $Date --offline 2>> $logFile
Log ("collect(after execute): " + (($collectOutput2 | Out-String).Trim()))

$advice = [System.IO.File]::ReadAllText($adviceFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$adviceMarkdown = [string]$advice.markdown

if ($SkipAgent) {
  Log "SkipAgent: deterministic render only"
  $reportText = (& $node (Join-Path $PSScriptRoot "render.mjs") $collectFile $verdictFile $adviceFile) | Out-String
} else {
  $promptB = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "prompt-b.md"), [System.Text.Encoding]::UTF8)
  $promptB = $promptB.Replace("{{DATE}}", $Date).Replace("{{COLLECT}}", $collectFile).Replace("{{VERDICTS}}", $verdictFile).Replace("{{ADVICE}}", $adviceMarkdown)
  Log "PhaseB: compose report"
  $reportText = Run-Agent $promptB ([int]$settings.reportMaxTurns) "PhaseB"
  if (-not $reportText) {
    Log "PhaseB failed, fallback to deterministic render"
    $reportText = (& $node (Join-Path $PSScriptRoot "render.mjs") $collectFile $verdictFile $adviceFile) | Out-String
  }
}

$reportFile = Join-Path $reportDir "$Date.md"
[System.IO.File]::WriteAllText($reportFile, $reportText, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $reportDir "latest.md"), $reportText, (New-Object System.Text.UTF8Encoding($false)))
Log "report written: $reportFile"

if ($NoPush) {
  Log "NoPush: skip delivery"
} else {
  $notifyOutput = & $node (Join-Path $PSScriptRoot "notify.mjs") --file $reportFile --date $Date 2>> $logFile
  $notifyExit = $LASTEXITCODE
  Log ("notify exit=$notifyExit " + (($notifyOutput | Out-String).Trim()))
}

Log "===== done ====="
exit 0
