import { execFile } from "node:child_process";

export const TASKS = {
  FundDailyReport: {
    label: "14:30 操作",
    description: "生成买入/卖出/不动操作，自动记账并推送",
    script: "run-daily.ps1",
  },
  FundDailyClose: {
    label: "15:30 收盘",
    description: "用 ETF 收盘价估算当日盈亏并推送",
    script: "run-close.ps1",
  },
};

const LIST_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$names = @('FundDailyReport','FundDailyClose')
$result = foreach ($name in $names) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { [pscustomobject]@{ name = $name; exists = $false }; continue }
  $info = Get-ScheduledTaskInfo -TaskName $name
  $trigger = $task.Triggers | Select-Object -First 1
  $next = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) { $info.NextRunTime.ToString('o') } else { $null }
  $last = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('o') } else { $null }
  $start = if ($trigger -and $trigger.StartBoundary) { ([datetime]$trigger.StartBoundary).ToString('o') } else { $null }
  $enabled = if ($trigger) { ([bool]$trigger.Enabled -and [string]$task.State -ne 'Disabled') } else { $false }
  [pscustomobject]@{
    name = $name
    exists = $true
    state = [string]$task.State
    enabled = $enabled
    startBoundary = $start
    nextRun = $next
    lastRun = $last
    lastResult = $info.LastTaskResult
    missed = $info.NumberOfMissedRuns
    action = [string]$task.Actions[0].Arguments
  }
}
$result | ConvertTo-Json -Depth 4
`;

function runPowerShell(script, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function resultText(code) {
  const map = {
    0: "成功",
    267004: "已运行",
    267009: "正在运行",
    267011: "尚未运行",
    267014: "已终止",
  };
  if (code === null || code === undefined) return "-";
  return map[code] ?? `代码 ${code}`;
}

function localTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export async function listTasks() {
  const output = await runPowerShell(LIST_SCRIPT);
  let rows;
  try {
    rows = JSON.parse(output || "[]");
  } catch {
    throw new Error("计划任务状态解析失败");
  }
  if (!Array.isArray(rows)) rows = [rows];
  return rows.map((row) => {
    const def = TASKS[row.name] ?? { label: row.name, description: "", script: null };
    return {
      ...row,
      ...def,
      time: localTime(row.startBoundary),
      nextRun: row.enabled ? row.nextRun : null,
      lastResultText: resultText(row.lastResult),
    };
  });
}

export async function updateTask(name, { time, enabled } = {}) {
  if (!TASKS[name]) throw new Error("未知任务");
  const parts = ["$ErrorActionPreference = 'Stop'"];
  if (time !== undefined && time !== null && time !== "") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error("时间格式必须是 HH:mm");
    parts.push(
      `Set-ScheduledTask -TaskName '${name}' -Trigger (New-ScheduledTaskTrigger -Daily -At '${time}') | Out-Null`,
    );
  }
  if (enabled === true) parts.push(`Enable-ScheduledTask -TaskName '${name}' | Out-Null`);
  if (enabled === false) parts.push(`Disable-ScheduledTask -TaskName '${name}' | Out-Null`);
  await runPowerShell(parts.join("\n"));
  return listTasks();
}

export async function runTask(name) {
  if (!TASKS[name]) throw new Error("未知任务");
  await runPowerShell(`$ErrorActionPreference = 'Stop'\nStart-ScheduledTask -TaskName '${name}'`);
  return listTasks();
}
