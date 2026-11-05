import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countDailyTasks,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from "./db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const reportDir = path.join(projectRoot, "skills", "fund-trading", "runner");

const TYPE_META = {
  daily: {
    label: "日报",
    description: "生成买入 / 卖出 / 不动操作，自动记账并推送",
    script: "run-daily.ps1",
  },
  close: {
    label: "收盘",
    description: "用收盘价和最新净值估算当日盈亏并推送",
    script: "run-close.ps1",
  },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function escapePs(value) {
  return String(value).replace(/'/g, "''");
}

function buildListScript(ids) {
  const names = ids.map((id) => `'${escapePs(id)}'`).join(",");
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$names = @(${names})
$result = foreach ($name in $names) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { [pscustomobject]@{ id = $name; exists = $false }; continue }
  $info = Get-ScheduledTaskInfo -TaskName $name
  $trigger = $task.Triggers | Select-Object -First 1
  $next = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 2000) { $info.NextRunTime.ToString('o') } else { $null }
  $last = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('o') } else { $null }
  $start = if ($trigger -and $trigger.StartBoundary) { ([datetime]$trigger.StartBoundary).ToString('o') } else { $null }
  $enabled = if ($trigger) { ([bool]$trigger.Enabled -and [string]$task.State -ne 'Disabled') } else { $false }
  [pscustomobject]@{
    id = $name
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
}

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

function taskPayload(task, row) {
  const meta = TYPE_META[task.type] ?? TYPE_META.daily;
  const exists = Boolean(row?.exists);
  const enabled = exists ? Boolean(row.enabled) : task.enabled === 1;
  return {
    id: task.id,
    name: task.name,
    label: task.name,
    type: task.type,
    typeLabel: meta.label,
    description: meta.description,
    market: task.market ?? null,
    time: row?.startBoundary ? localTime(row.startBoundary) : task.time,
    enabled,
    exists,
    state: row?.state ?? "Missing",
    startBoundary: row?.startBoundary ?? null,
    nextRun: enabled ? row?.nextRun ?? null : null,
    lastRun: row?.lastRun ?? null,
    lastResult: row?.lastResult ?? null,
    lastResultText: resultText(row?.lastResult),
    missed: row?.missed ?? 0,
    action: row?.action ?? null,
  };
}

export async function listTasks(db) {
  const tasks = listScheduledTasks(db);
  if (tasks.length === 0) return [];
  const output = await runPowerShell(buildListScript(tasks.map((task) => task.id)));
  let rows;
  try {
    rows = JSON.parse(output || "[]");
  } catch {
    throw new Error("计划任务状态解析失败");
  }
  if (!Array.isArray(rows)) rows = [rows];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return tasks.map((task) => taskPayload(task, byId.get(task.id)));
}

function normalizeTask(input, current = null) {
  const type = input.type ?? current?.type ?? "daily";
  if (!TYPE_META[type]) throw new Error("任务类型不合法");
  const time = String(input.time ?? current?.time ?? "").trim();
  if (!TIME_RE.test(time)) throw new Error("时间格式必须是 HH:mm");
  let market = type === "daily" ? String(input.market ?? current?.market ?? "otc") : null;
  if (type === "daily" && !["otc", "exchange"].includes(market)) {
    throw new Error("日报任务必须选择场外或场内");
  }
  const name =
    String(input.name ?? current?.name ?? "").trim().slice(0, 40) ||
    `${time} ${type === "daily" ? "操作" : "收盘"}`;
  const enabled =
    input.enabled === undefined ? (current ? current.enabled === 1 : true) : Boolean(input.enabled);
  return { name, type, time, market, enabled };
}

function actionArguments(task) {
  const meta = TYPE_META[task.type];
  const scriptPath = path.join(reportDir, meta.script);
  const marketArg = task.type === "daily" && task.market ? ` -Market ${task.market}` : "";
  const adapter = task.type === "daily" && process.env.FUND_TRADE_AGENT_ADAPTER
    ? path.resolve(process.env.FUND_TRADE_AGENT_ADAPTER)
    : "";
  const adapterArg = adapter ? ` -AgentAdapter "${adapter}"` : "";
  return `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}" -ProjectRoot "${projectRoot}"${marketArg}${adapterArg}`;
}

async function registerWindowsTask(task) {
  const meta = TYPE_META[task.type];
  const argumentsText = actionArguments(task);
  const script = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '${escapePs(argumentsText)}'
$trigger = New-ScheduledTaskTrigger -Daily -At '${escapePs(task.time)}'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${escapePs(task.id)}' -Action $action -Trigger $trigger -Settings $settings -Description 'Managed by fund admin' -Force | Out-Null
${task.enabled ? "Enable-ScheduledTask -TaskName '" + escapePs(task.id) + "' | Out-Null" : "Disable-ScheduledTask -TaskName '" + escapePs(task.id) + "' | Out-Null"}
`;
  await runPowerShell(script);
}

export async function createTask(db, input) {
  const normalized = normalizeTask(input);
  let id = `FundTask_${Date.now().toString(36)}`;
  while (getScheduledTask(db, id)) id = `FundTask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const task = { id, ...normalized };
  createScheduledTask(db, task);
  try {
    await registerWindowsTask(task);
  } catch (error) {
    deleteScheduledTask(db, id);
    throw error;
  }
  return listTasks(db);
}

export async function updateTask(db, id, input) {
  const current = getScheduledTask(db, id);
  if (!current) throw new Error("计划任务不存在");
  const normalized = normalizeTask(input, current);
  await registerWindowsTask({ id, ...normalized });
  updateScheduledTask(db, id, normalized);
  return listTasks(db);
}

export async function deleteTask(db, id) {
  const current = getScheduledTask(db, id);
  if (!current) throw new Error("计划任务不存在");
  if (current.type === "daily" && countDailyTasks(db, id) === 0) {
    throw new Error("至少保留一个日报任务");
  }
  await runPowerShell(
    `$ErrorActionPreference = 'Stop'\n$task = Get-ScheduledTask -TaskName '${escapePs(id)}' -ErrorAction SilentlyContinue\nif ($task) { Unregister-ScheduledTask -TaskName '${escapePs(id)}' -Confirm:$false }`,
  );
  deleteScheduledTask(db, id);
  return listTasks(db);
}

export async function runTask(db, id) {
  if (!getScheduledTask(db, id)) throw new Error("计划任务不存在");
  await runPowerShell(`$ErrorActionPreference = 'Stop'\nStart-ScheduledTask -TaskName '${escapePs(id)}'`);
  return listTasks(db);
}

export async function ensureTaskActions(db) {
  const tasks = listScheduledTasks(db);
  if (tasks.length === 0) return;
  const windows = await listTasks(db);
  for (const task of tasks) {
    const current = windows.find((item) => item.id === task.id);
    const enabled = task.enabled === 1;
    const expected = actionArguments({ ...task, enabled });
    if (!current?.exists) {
      if (!enabled) continue;
      await registerWindowsTask({ ...task, enabled });
      continue;
    }
    const hasAdapterAction = current.action?.includes("-AgentAdapter");
    const expectedHasAdapter = expected.includes("-AgentAdapter");
    if (current.action !== expected && !(hasAdapterAction && !expectedHasAdapter)) {
      await registerWindowsTask({ ...task, enabled });
    }
  }
}
