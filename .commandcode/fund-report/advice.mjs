#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buyRateFor, loadConfig, sellRateForHoldingDays } from "../skills/fund-trading/scripts/lib/config.mjs";
import { computeBuyFill, computeSellFill } from "../skills/fund-trading/scripts/lib/trade.mjs";
import { daysBetween, round } from "../skills/fund-trading/scripts/lib/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  enabled: true,
  maxBuysPerDay: 1,
  maxSellsPerDay: 1,
  buyPct: 0.3,
  minBuyAmount: 500,
  buy: { stances: ["hot"], minD20: 0, maxDistanceFromHigh: 0.08, minConfidence: "medium" },
  sell: { stances: ["risk"], stopLossPct: -0.15, takeProfitPct: 0.3, exitIfD20Below: -0.05 },
};
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = value && typeof value === "object" && !Array.isArray(value) ? merge(base?.[key] ?? {}, value) : value;
  }
  return out;
}

function pct(value, digits = 2) {
  return value === null || value === undefined ? "-" : `${(value * 100).toFixed(digits)}%`;
}

function money(value) {
  return value === null || value === undefined ? "-" : Number(value).toFixed(2);
}

function heldDays(holding) {
  if (!holding.firstBuyDate) return 0;
  const offset = holding.market === "exchange" ? 0 : 1;
  return Math.max(0, daysBetween(holding.firstBuyDate) - offset);
}

function verdictOf(verdicts, code) {
  const entry = verdicts?.[code];
  return entry?.fresh ? entry.verdict : null;
}

function confidenceAtLeast(value, minimum) {
  return (CONFIDENCE_RANK[value] ?? -1) >= (CONFIDENCE_RANK[minimum] ?? 0);
}

function main() {
  const collectPath = process.argv[2];
  const verdictPath = process.argv[3];
  const outPath = process.argv[4];
  const collect = JSON.parse(fs.readFileSync(collectPath, "utf8"));
  const verdicts = verdictPath && fs.existsSync(verdictPath) ? JSON.parse(fs.readFileSync(verdictPath, "utf8")) : {};
  const reportConfig = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
  const advice = merge(DEFAULTS, reportConfig.advice ?? {});
  const risk = loadConfig();

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    date: collect.date,
    marketMode: collect.marketMode ?? "otc",
    enabled: advice.enabled,
    buys: [],
    sells: [],
    holds: [],
    summary: null,
    markdown: "",
  };

  if (!advice.enabled) {
    result.summary = { buys: 0, sells: 0, note: "advice.enabled=false" };
    result.markdown = "### 助手今日操作\n- 规则引擎已关闭（advice.enabled=false）。";
    finish(result, outPath);
    return;
  }

  if (!collect.account?.ok) {
    result.summary = { buys: 0, sells: 0, note: "账户数据不可用" };
    result.markdown = `### 助手今日操作\n- 跳过：账户数据不可用（${collect.account?.error ?? "未知错误"}）。`;
    finish(result, outPath);
    return;
  }

  const watchlist = collect.watchlist ?? [];
  const byCode = new Map(watchlist.map((fund) => [fund.code, fund]));
  const holdings = collect.account.holdings ?? [];
  let cash = collect.account.cash;
  let positionValue = collect.account.positionValue;
  let equity = collect.account.equity;
  let totalPosition = positionValue;
  const acted = new Set();

  const priceOf = (code) => {
    const fund = byCode.get(code);
    if (fund?.price) return fund.price;
    const holding = holdings.find((item) => item.code === code);
    return holding?.lastNav ?? holding?.avgCost ?? null;
  };

  for (const holding of holdings) {
    if (result.sells.length >= advice.maxSellsPerDay) break;
    const fund = byCode.get(holding.code);
    const verdict = verdictOf(verdicts, holding.code);
    const pnlPct = holding.cost > 0 ? (holding.shares * (holding.lastNav ?? holding.avgCost) - holding.cost) / holding.cost : 0;
    const reasons = [];

    if (verdict && advice.sell.stances.includes(verdict.stance)) {
      reasons.push(`资讯 ${verdict.stance}（风险 ${verdict.riskScore}/热度 ${verdict.hotScore}）`);
    }
    if (pnlPct <= advice.sell.stopLossPct) reasons.push(`浮亏 ${pct(pnlPct)} 触及止损线 ${pct(advice.sell.stopLossPct, 0)}`);
    if (pnlPct >= advice.sell.takeProfitPct) reasons.push(`浮盈 ${pct(pnlPct)} 触及止盈线 ${pct(advice.sell.takeProfitPct, 0)}`);
    if (fund?.d20 !== null && fund?.d20 !== undefined && fund.d20 < advice.sell.exitIfD20Below) {
      reasons.push(`20日 ${pct(fund.d20)} 低于退出阈值 ${pct(advice.sell.exitIfD20Below)}`);
    }
    if (reasons.length === 0) continue;

    const days = heldDays(holding);
    const minDays = holding.market === "exchange" ? risk.risk.exchangeMinHoldingDays : risk.risk.minHoldingDays;
    if (days < minDays) {
      result.holds.push({ code: holding.code, name: holding.name, action: "HOLD", reason: `触发卖出但持有 ${days} 天，未满足最短 ${minDays} 天` });
      acted.add(holding.code);
      continue;
    }

    const nav = priceOf(holding.code) ?? holding.avgCost;
    const feeRate = sellRateForHoldingDays(days, risk, holding.market);
    const fill = computeSellFill({ shares: holding.shares, nav, feeRate });
    const costPortion = round(holding.avgCost * holding.shares, 2);
    const before = {
      shares: holding.shares,
      value: round(holding.shares * nav, 2),
      weight: equity > 0 ? (holding.shares * nav) / equity : 0,
      cash: round(cash, 2),
    };
    cash = round(cash + fill.proceeds, 2);
    positionValue = round(positionValue - before.value, 2);
    totalPosition = round(totalPosition - before.value, 2);
    equity = round(cash + positionValue, 2);
    const after = {
      shares: 0,
      value: 0,
      weight: 0,
      cash,
      cashPct: equity > 0 ? cash / equity : 0,
      positionPct: equity > 0 ? totalPosition / equity : 0,
    };
    result.sells.push({
      code: holding.code,
      name: holding.name,
      market: holding.market ?? null,
      action: "SELL",
      shares: holding.shares,
      nav,
      feeRate,
      fee: fill.fee,
      proceeds: fill.proceeds,
      realizedPnl: round(fill.proceeds - costPortion, 2),
      reasons,
      before,
      after,
    });
    acted.add(holding.code);
  }

  if (result.buys.length < advice.maxBuysPerDay) {
    const candidates = [];
    for (const fund of watchlist) {
      if (holdings.some((holding) => holding.code === fund.code)) continue;
      const verdict = verdictOf(verdicts, fund.code);
      const reasons = [];
      if (!verdict) {
        reasons.push("资讯未扫描或已过期");
      } else {
        if (!advice.buy.stances.includes(verdict.stance)) reasons.push(`资讯 ${verdict.stance}`);
        if (!confidenceAtLeast(verdict.confidence, advice.buy.minConfidence)) reasons.push(`置信度 ${verdict.confidence}`);
        if (fund.d20 === null || fund.d20 === undefined) reasons.push("缺少历史净值");
        else if (fund.d20 < advice.buy.minD20) reasons.push(`20日 ${pct(fund.d20)} 低于 ${pct(advice.buy.minD20, 0)}`);
        if (fund.fromHigh60 === null || fund.fromHigh60 === undefined) reasons.push("缺少60日高点");
        else if (fund.fromHigh60 < -advice.buy.maxDistanceFromHigh) reasons.push(`距60日高 ${pct(fund.fromHigh60)} 超过 ${pct(advice.buy.maxDistanceFromHigh, 0)}`);
      }
      if (reasons.length === 0) {
        candidates.push({ fund, verdict, score: verdict.hotScore + (fund.d20 ?? 0) * 100 + (fund.fromHigh60 ?? 0) * 50 });
      } else {
        result.holds.push({ code: fund.code, name: fund.name, action: "HOLD", reason: reasons.join("；") });
        acted.add(fund.code);
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length > 0) {
      const { fund, verdict } = candidates[0];
      const nav = fund.price;
      const feeRate = buyRateFor(fund.market, risk);
      const cashReserve = equity * risk.risk.minCashReservePct;
      const capacity = Math.min(
        equity * advice.buyPct,
        cash - cashReserve,
        risk.risk.maxOrderAmount,
        equity * risk.risk.maxSinglePositionPct,
        equity * risk.risk.maxTotalPositionPct - totalPosition,
      );
      const amount = Math.floor(Math.max(0, capacity) / 100) * 100;
      if (amount >= advice.minBuyAmount) {
        const fill = computeBuyFill({ amount, nav, feeRate });
        const before = {
          shares: 0,
          value: 0,
          weight: 0,
          cash: round(cash, 2),
        };
        cash = round(cash - amount, 2);
        positionValue = round(positionValue + fill.shares * nav, 2);
        totalPosition = round(totalPosition + fill.shares * nav, 2);
        equity = round(cash + positionValue, 2);
        const after = {
          shares: fill.shares,
          value: round(fill.shares * nav, 2),
          weight: equity > 0 ? (fill.shares * nav) / equity : 0,
          cash,
          cashPct: equity > 0 ? cash / equity : 0,
          positionPct: equity > 0 ? totalPosition / equity : 0,
        };
        result.buys.push({
          code: fund.code,
          name: fund.name,
          market: fund.market ?? null,
          action: "BUY",
          amount,
          nav,
          feeRate,
          fee: fill.fee,
          shares: fill.shares,
          reasons: [
            `资讯 ${verdict.stance}（热度 ${verdict.hotScore}/风险 ${verdict.riskScore}/${verdict.confidence}）`,
            `20日 ${pct(fund.d20)}`,
            `距60日高 ${pct(fund.fromHigh60)}`,
          ],
          before,
          after,
        });
        acted.add(fund.code);
      } else {
        result.holds.push({ code: fund.code, name: fund.name, action: "HOLD", reason: `满足条件但可用额度 ${money(amount)} 元低于最小买入 ${money(advice.minBuyAmount)} 元` });
        acted.add(fund.code);
      }
    }
  }

  for (const fund of watchlist) {
    if (acted.has(fund.code)) continue;
    const holding = holdings.find((item) => item.code === fund.code);
    if (holding) {
      const pnlPct = holding.cost > 0 ? (holding.shares * (holding.lastNav ?? holding.avgCost) - holding.cost) / holding.cost : 0;
      result.holds.push({ code: fund.code, name: fund.name, action: "HOLD", reason: `未触发卖出条件；当前浮盈 ${pct(pnlPct)}` });
    } else {
      result.holds.push({ code: fund.code, name: fund.name, action: "HOLD", reason: "今日未产生买入信号" });
    }
  }

  result.summary = {
    buys: result.buys.length,
    sells: result.sells.length,
    cash: round(cash, 2),
    equity: round(equity, 2),
    positionPct: equity > 0 ? totalPosition / equity : 0,
    cashPct: equity > 0 ? cash / equity : 0,
  };
  result.markdown = renderMarkdown(result);
  finish(result, outPath);
}

export function renderMarkdown(result) {
  const done = result.executed ? "（已自动记账）" : "";
  const lines = [result.executed ? "### 助手今日操作（模拟盘已自动执行）" : "### 助手今日操作（规则触发，非预测）"];
  if (result.buys.length === 0) {
    lines.push("- 买入：无（没有同时满足『资讯 hot + 20日为正 + 距60日高不超过设定阈值』的板块）");
  }
  for (const buy of result.buys) {
    const buyNote =
      buy.market === "otc"
        ? `（按最近净值 ${buy.nav} 估算约 ${buy.shares} 份；实际以今日 15:00 净值确认）`
        : `（约 ${buy.shares} 份 @ ${buy.nav}）`;
    lines.push(`- 买入 ${buy.code} ${buy.name ?? ""}：${money(buy.amount)} 元${buyNote}${done}`);
    lines.push(`  触发：${buy.reasons.join("；")}`);
    lines.push(
      `  持仓变化${buy.market === "otc" ? "（估算）" : ""}：${buy.before.shares} → ${buy.shares} 份；市值 ${money(buy.before.value)} → ${money(buy.after.value)} 元；占比 ${pct(buy.before.weight, 1)} → ${pct(buy.after.weight, 1)}；现金 ${money(buy.before.cash)} → ${money(buy.after.cash)} 元`,
    );
  }
  if (result.sells.length === 0) {
    lines.push("- 卖出：无");
  }
  for (const sell of result.sells) {
    const sellNote =
      sell.market === "otc"
        ? `（按最近净值估算到账 ${money(sell.proceeds)} 元，费 ${money(sell.fee)}；实际以今日 15:00 净值确认）`
        : `（预计到账 ${money(sell.proceeds)} 元，费 ${money(sell.fee)}）`;
    lines.push(`- 卖出 ${sell.code} ${sell.name ?? ""}：${sell.shares} 份${sellNote}${done}`);
    lines.push(`  触发：${sell.reasons.join("；")}`);
    lines.push(
      `  持仓变化：${sell.before.shares} → 0 份；市值 ${money(sell.before.value)} → 0.00 元；占比 ${pct(sell.before.weight, 1)} → 0.0%；现金 ${money(sell.before.cash)} → ${money(sell.after.cash)} 元`,
    );
  }
  const holds = result.holds.slice(0, 6);
  if (holds.length > 0) {
    lines.push(`- 不动：${holds.map((hold) => `${hold.code} ${hold.name ?? ""}（${hold.reason}）`).join("；")}`);
  }
  if (result.execution?.skipped?.length) {
    lines.push(`- 未执行：${result.execution.skipped.map((item) => `${item.code} ${item.reason}`).join("；")}`);
  }
  lines.push(
    `汇总：买入 ${result.summary.buys} 笔，卖出 ${result.summary.sells} 笔；操作后总仓位 ${pct(result.summary.positionPct, 1)}，现金 ${money(result.summary.cash)} 元（${pct(result.summary.cashPct, 1)}）。`,
  );
  lines.push(
    result.marketMode === "exchange"
      ? "场内规则：交易时段按实时价成交；T+1 可卖；默认无赎回费。"
      : "场外规则：15:00 前提交按当日 15:00 净值确认；T+2 才可赎回；持有不满 7 日赎回费 1.5%。",
  );
  lines.push(
    result.executed
      ? result.marketMode === "exchange"
        ? "说明：以上为模拟盘自动执行，不构成投资建议；场内按成交参考价记账，盈亏随每日收盘价更新。"
        : "说明：以上为模拟盘自动执行，不构成投资建议；成交价将在下一交易日按收盘净值结算，盈亏随每日收盘数据更新。"
      : "说明：以上为规则触发的建议，不是已成交；持仓变化是按建议成交后的推演，未执行前账户不变。是否执行由你决定，成交后回报我记账。",
  );
  return lines.join("\n");
}

function finish(result, outPath) {
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: result.ok, buys: result.buys.length, sells: result.sells.length, holds: result.holds.length, file: outPath ?? null }, null, 2)}\n`,
  );
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) main();
