[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PromptFile,
  [Parameter(Mandatory = $true)]
  [string]$OutputFile,
  [int]$MaxTurns = 60,
  [string]$Model = ""
)

$ErrorActionPreference = "Stop"
$prompt = [System.IO.File]::ReadAllText($PromptFile, [System.Text.Encoding]::UTF8)

# Replace this block with the host agent CLI / SDK call.
#
# Contract:
# - read the prompt from $prompt or $PromptFile
# - write the final plain-text answer to $OutputFile as UTF-8
# - exit 0 on success
#
# Example shape:
# $result = & your-agent --prompt $prompt --max-turns $MaxTurns
# [System.IO.File]::WriteAllText($OutputFile, ($result | Out-String), (New-Object System.Text.UTF8Encoding($false)))

throw "Configure agent-adapter.example.ps1 for your host before using it."
