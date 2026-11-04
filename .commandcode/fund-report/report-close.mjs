#!/usr/bin/env node
import fs from "node:fs";

function pct(value) {
  return value === null || value === undefined ? "-" : `${(value * 100).toFixed(2)}%`;
}

function money(value) {
  return value === null || value === undefined ? "-" : Number(value).toFixed(2);
}

function signed(value) {
  if (value === null || value === undefined) return "-";
  return value > 0 ? `+${money(value)}` : money(value);
}

function main() {
  const collect = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const close = collect.close;
  if (!close) throw new Error("缺少 close 数据，请用 collect.mjs --close 生成");

  const tag = close.estimatedAny ? "估算" : close.pendingAny ? "含待确认" : "官方";
  const mode = collect.marketMode ?? "otc";
  const lines = [];
  lines.push(`# 收盘盈亏 ${collect.date}`);
  lines.push("");
  lines.push(`总资产（${tag}）${money(close.equity)} 元｜当日盈亏 ${signed(close.dayPnl)} 元（${pct(close.dayPnlPct)}）`);
  lines.push(`现金 ${money(close.cash)} 元｜持仓（${tag}）${money(close.positionValue)} 元`);
  lines.push("");
  lines.push("## 持仓");
  if (close.holdings.length === 0) {
    lines.push("- 空仓");
  }
  for (const holding of close.holdings) {
    const label = holding.estimated
      ? "估算"
      : holding.source === "官方净值"
        ? "官方"
        : holding.source === "收盘价"
          ? "收盘"
          : "参考";
    lines.push(`- ${holding.name ?? holding.code}（${holding.code}）：${holding.shares} 份`);
    lines.push(`  昨净值 ${holding.prevNav}（${holding.prevNavDate ?? "-"}）→ 今${label} ${holding.nav}（${pct(holding.changePct)}）`);
    lines.push(`  市值 ${money(holding.value)} 元｜当日盈亏 ${signed(holding.dayPnl)} 元｜累计盈亏 ${signed(holding.pnl)} 元（${pct(holding.pnlPct)}）`);
    if (holding.source) lines.push(`  来源：${holding.source}`);
  }
  lines.push("");
  lines.push("## 说明");
  lines.push(
    mode === "exchange"
      ? "场内按当日收盘价计算，T+1 可卖；盈亏随每日收盘价更新。"
      : "场外基金官方净值通常晚间公布；15:30 报告用对应 ETF 收盘涨跌估算，下一交易日 14:30 按官方净值结算并更正。",
  );
  lines.push("模拟盘自动执行，非投资建议。");
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
