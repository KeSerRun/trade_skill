#!/usr/bin/env node
import { loadAccount, saveAccount } from "../scripts/lib/portfolio.mjs";
import { navHistory } from "../scripts/lib/data.mjs";
import { round, today } from "../scripts/lib/store.mjs";

async function main() {
  const day = today();
  const account = loadAccount();
  const pending = (account.trades ?? []).filter((trade) => trade.settled === false && trade.date < day);
  const settled = [];
  const skipped = [];

  for (const trade of pending) {
    let row = null;
    try {
      const rows = await navHistory(trade.code, { pages: 3, pageSize: 20, noCache: true });
      row = rows.find((item) => item.date === trade.date) ?? null;
      if (!row) {
        row = rows.filter((item) => item.date > trade.date).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
      }
    } catch (error) {
      skipped.push({ code: trade.code, date: trade.date, reason: error.message });
      continue;
    }
    if (!row) {
      skipped.push({ code: trade.code, date: trade.date, reason: "该交易日净值尚未公布" });
      continue;
    }

    const nav = row.nav;
    if (trade.type === "BUY") {
      const holding = account.holdings[trade.code];
      if (!holding) {
        skipped.push({ code: trade.code, date: trade.date, reason: "持仓已不存在，无法回填" });
        continue;
      }
      const newShares = round((trade.amount - (trade.fee ?? 0)) / nav, 2);
      const delta = round(newShares - trade.shares, 2);
      holding.shares = round(holding.shares + delta, 2);
      holding.avgCost = holding.shares > 0 ? round(holding.cost / holding.shares, 4) : 0;
      holding.lastNav = nav;
      holding.lastNavDate = trade.date;
      trade.nav = nav;
      trade.shares = newShares;
    } else {
      const gross = round(trade.shares * nav, 2);
      const fee = round(gross * (trade.feeRate ?? 0), 2);
      const proceeds = round(gross - fee, 2);
      const delta = round(proceeds - trade.amount, 2);
      account.cash = round(account.cash + delta, 2);
      account.realizedPnl = round((account.realizedPnl ?? 0) + delta, 2);
      trade.nav = nav;
      trade.gross = gross;
      trade.fee = fee;
      trade.amount = proceeds;
      trade.realizedPnl = round((trade.realizedPnl ?? 0) + delta, 2);
    }
    trade.settled = true;
    trade.settledAt = new Date().toISOString();
    trade.settledDate = row.date;
    settled.push({ code: trade.code, type: trade.type, date: trade.date, settledDate: row.date, nav });
  }

  if (settled.length > 0) saveAccount(account);
  process.stdout.write(`${JSON.stringify({ ok: true, settled: settled.length, skipped: skipped.length, details: settled, skippedDetails: skipped }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
