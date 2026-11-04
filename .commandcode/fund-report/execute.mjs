#!/usr/bin/env node
import fs from "node:fs";
import { loadAccount, saveAccount, snapshot } from "../skills/fund-trading/scripts/lib/portfolio.mjs";
import { applyBuy, applySell } from "../skills/fund-trading/scripts/lib/trade.mjs";
import { checkBuy, checkSell } from "../skills/fund-trading/scripts/lib/riskcore.mjs";
import { loadConfig } from "../skills/fund-trading/scripts/lib/config.mjs";
import { round, today } from "../skills/fund-trading/scripts/lib/store.mjs";
import { loadAppSettings } from "../skills/fund-trading/scripts/lib/sqlite.mjs";
import { renderMarkdown } from "./advice.mjs";

function main() {
  const collectPath = process.argv[2];
  const advicePath = process.argv[3];
  const date = process.argv[4] || today();
  const settings = loadAppSettings();

  if (!settings.autoExecute) {
    process.stdout.write(`${JSON.stringify({ ok: true, executed: false, note: "autoExecute=false" }, null, 2)}\n`);
    return;
  }
  if (!advicePath || !fs.existsSync(advicePath)) {
    throw new Error("缺少 advice 文件");
  }

  const advice = JSON.parse(fs.readFileSync(advicePath, "utf8"));
  const collect = collectPath && fs.existsSync(collectPath) ? JSON.parse(fs.readFileSync(collectPath, "utf8")) : { watchlist: [] };
  const markets = new Map((collect.watchlist ?? []).map((fund) => [fund.code, fund.market]));
  const config = loadConfig();
  const account = loadAccount();
  const skipped = [];
  let buys = 0;
  let sells = 0;

  const weekday = new Date(`${date}T00:00:00`).getDay();
  const weekend = weekday === 0 || weekday === 6;
  const now = new Date();
  const afterClose = date === today() && now.getHours() >= 15;
  const tradingDay = !weekend && !afterClose;

  if (tradingDay) {
    for (const sell of advice.sells ?? []) {
      if (sell.executed) continue;
      const check = checkSell(account, config, sell.code, sell.shares);
      if (!check.allowed) {
        skipped.push({ side: "sell", code: sell.code, reason: check.violations.join("; ") });
        continue;
      }
      const sellMarket = sell.market ?? account.holdings[sell.code]?.market ?? markets.get(sell.code) ?? "otc";
      applySell(account, {
        code: sell.code,
        shares: sell.shares,
        nav: sell.nav,
        feeRate: sell.feeRate,
        date,
        note: "auto",
      });
      const trade = account.trades[account.trades.length - 1];
      trade.settled = sellMarket !== "otc";
      trade.auto = true;
      trade.adviceDate = advice.date;
      saveAccount(account);
      sells += 1;
    }

    for (const buy of advice.buys ?? []) {
      if (buy.executed) continue;
      const check = checkBuy(account, config, buy.code, buy.amount, snapshot(account));
      if (!check.allowed) {
        skipped.push({ side: "buy", code: buy.code, reason: check.violations.join("; ") });
        continue;
      }
      const buyMarket = buy.market ?? markets.get(buy.code) ?? "otc";
      applyBuy(account, {
        code: buy.code,
        name: buy.name,
        amount: buy.amount,
        nav: buy.nav,
        shares: buy.shares,
        fee: buy.fee,
        date,
        market: buyMarket,
        note: "auto",
      });
      const trade = account.trades[account.trades.length - 1];
      trade.settled = buyMarket !== "otc";
      trade.auto = true;
      trade.adviceDate = advice.date;
      saveAccount(account);
      buys += 1;
    }
  } else {
    const reason = weekend ? "非交易日，未执行" : "已过15:00，顺延下一交易日";
    for (const item of [...(advice.buys ?? []), ...(advice.sells ?? [])]) {
      skipped.push({ side: item.action === "SELL" ? "sell" : "buy", code: item.code, reason });
    }
  }

  const skippedKeys = new Set(skipped.map((item) => `${item.side}:${item.code}`));
  advice.buys = tradingDay ? (advice.buys ?? []).filter((item) => !skippedKeys.has(`buy:${item.code}`)) : [];
  advice.sells = tradingDay ? (advice.sells ?? []).filter((item) => !skippedKeys.has(`sell:${item.code}`)) : [];
  advice.executed = true;
  advice.executedAt = new Date().toISOString();
  advice.execution = { mode: "auto", buys, sells, skipped, tradingDay, afterClose };
  const state = snapshot(account);
  advice.summary = {
    buys,
    sells,
    cash: round(state.cash, 2),
    equity: round(state.equity, 2),
    positionPct: state.equity > 0 ? state.positionValue / state.equity : 0,
    cashPct: state.equity > 0 ? state.cash / state.equity : 0,
  };
  advice.markdown = renderMarkdown(advice);
  fs.writeFileSync(advicePath, JSON.stringify(advice, null, 2), "utf8");

  process.stdout.write(
    `${JSON.stringify({ ok: true, executed: true, tradingDay, buys, sells, skipped: skipped.length, cash: state.cash, equity: state.equity }, null, 2)}\n`,
  );
}

main();
