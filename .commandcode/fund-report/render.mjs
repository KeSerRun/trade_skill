#!/usr/bin/env node
import fs from "node:fs";

function pct(value) {
  return value === null || value === undefined ? "-" : `${(value * 100).toFixed(2)}%`;
}

function money(value) {
  return value === null || value === undefined ? "-" : Number(value).toFixed(2);
}

function stanceLabel(stance) {
  return { risk: "雷点占优", hot: "热点占优", mixed: "多空交织", neutral: "中性" }[stance] ?? "未扫描";
}

function main() {
  const collectPath = process.argv[2];
  const verdictPath = process.argv[3];
  const advicePath = process.argv[4];
  const collect = JSON.parse(fs.readFileSync(collectPath, "utf8"));
  let verdicts = {};
  if (verdictPath && fs.existsSync(verdictPath)) {
    verdicts = JSON.parse(fs.readFileSync(verdictPath, "utf8"));
  }
  let advice = null;
  if (advicePath && fs.existsSync(advicePath)) {
    advice = JSON.parse(fs.readFileSync(advicePath, "utf8"));
  }

  const lines = [];
  lines.push(`# 基金日报 ${collect.date}`);
  lines.push("");
  if (collect.account?.ok) {
    lines.push(`总资产 ${money(collect.account.equity)} 元｜现金 ${money(collect.account.cash)} 元｜持仓 ${money(collect.account.positionValue)} 元`);
    lines.push(`浮动盈亏 ${money(collect.account.unrealizedPnl)} 元｜总收益 ${money(collect.account.totalPnl)} 元（${pct(collect.account.totalPnlPct)}）`);
  } else {
    lines.push(`账户数据不可用：${collect.account?.error ?? "未知错误"}`);
  }
  lines.push("");
  lines.push("## 持仓");
  const holdings = collect.account?.holdings ?? [];
  if (holdings.length === 0) {
    lines.push("- 空仓");
  } else {
    for (const h of holdings) {
      lines.push(`- ${h.name ?? h.code}（${h.code}）：${h.shares} 份，市值 ${money(h.marketValue)}，浮盈 ${money(h.pnl)}（${pct(h.pnlPct)}）`);
    }
  }
  lines.push("");
  if (advice?.markdown) {
    lines.push(advice.markdown);
    lines.push("");
  }
  lines.push("## 风控与指令");
  if (collect.alerts?.ok && collect.alerts.alerts?.length) {
    for (const a of collect.alerts.alerts) {
      lines.push(`- ${a.type === "STOP_LOSS" ? "止损" : "止盈"}：${a.name ?? a.code} ${pct(a.pnlPct)}`);
    }
  } else {
    lines.push("- 无止损/止盈触发");
  }
  const pending = collect.pendingOrders?.orders ?? [];
  lines.push(pending.length ? `- 待执行指令 ${pending.length} 条` : "- 无待执行指令");
  if (collect.drawdown?.ok) {
    lines.push(`- 最大回撤 ${pct(collect.drawdown.maxDrawdown)}，当前回撤 ${pct(collect.drawdown.currentDrawdown)}`);
  }
  lines.push("");
  lines.push("## 关注板块");
  for (const f of collect.watchlist ?? []) {
    const v = verdicts[f.code]?.verdict;
    lines.push(
      `- ${f.sector ? `${f.sector}｜` : ""}${f.name ?? f.code}（${f.code}） 5日 ${pct(f.d5)}｜20日 ${pct(f.d20)}｜60日 ${pct(f.d60)}｜回撤 ${pct(f.maxDrawdown60)}｜${stanceLabel(v?.stance)}`,
    );
    const evidence = (v?.evidence ?? []).slice(0, 3);
    for (const item of evidence) {
      lines.push(`  - ${item.date ? `${item.date} ` : ""}${item.title}${item.url ? ` ${item.url}` : ""}`);
    }
  }
  lines.push("");
  lines.push("模拟盘自动执行，非投资建议；场外基金按当日 15:00 净值确认，T+2 可赎回，7 日内赎回费 1.5%。");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
