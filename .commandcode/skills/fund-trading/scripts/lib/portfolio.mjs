import { loadConfig, sellRateForHoldingDays } from "./config.mjs";
import { appendEquitySnapshotToDb, loadAccountFromDb, readEquitySnapshots, saveAccountToDb } from "./sqlite.mjs";
import { daysBetween, nowIso, round, today } from "./store.mjs";
import { latestNav, quoteFund } from "./data.mjs";

export function loadAccount() {
  const account = loadAccountFromDb();
  if (!account) throw new Error("未找到账户，请先执行: node paper.mjs init --cash 100000");
  return account;
}

export function saveAccount(account) {
  account.updatedAt = nowIso();
  saveAccountToDb(account);
}

export async function resolveNav(code, options = {}) {
  const { nav, date } = options;
  if (nav) return { nav, date: date ?? today(), name: null, market: "manual" };
  const info = await latestNav(code);
  if (!info.nav) throw new Error(`无法获取 ${code} 的净值，请用 --nav 手动指定`);
  return info;
}

export function positionSummary(account) {
  const holdings = Object.values(account.holdings);
  for (const holding of holdings) {
    holding.marketValue = round(holding.shares * (holding.lastNav ?? holding.avgCost), 2);
    holding.pnl = round(holding.marketValue - holding.cost, 2);
    holding.pnlPct = holding.cost > 0 ? holding.pnl / holding.cost : 0;
  }
  const positionValue = round(holdings.reduce((sum, item) => sum + item.marketValue, 0), 2);
  const cost = round(holdings.reduce((sum, item) => sum + item.cost, 0), 2);
  const equity = round(account.cash + positionValue, 2);
  return {
    cash: round(account.cash, 2),
    positionValue,
    cost,
    equity,
    unrealizedPnl: round(positionValue - cost, 2),
    realizedPnl: round(account.realizedPnl ?? 0, 2),
    totalPnl: round(equity - account.initialCash, 2),
    totalPnlPct: account.initialCash > 0 ? (equity - account.initialCash) / account.initialCash : 0,
    cashPct: equity > 0 ? account.cash / equity : 0,
    investedPct: equity > 0 ? positionValue / equity : 0,
    holdings,
  };
}

export function snapshot(account) {
  const holdings = Object.values(account.holdings);
  const positionValue = round(
    holdings.reduce((sum, h) => sum + h.shares * (h.lastNav ?? h.avgCost), 0),
    2,
  );
  const equity = round(account.cash + positionValue, 2);
  return { holdings, positionValue, equity, cash: round(account.cash, 2) };
}

export async function refreshHoldings(account) {
  for (const holding of Object.values(account.holdings)) {
    try {
      const quote = await quoteFund(holding.code, { noCache: true });
      holding.lastNav = quote.market === "exchange" ? quote.price : quote.nav;
      holding.lastNavDate = quote.date ?? quote.time?.slice(0, 10) ?? today();
      holding.lastChangePct = quote.changePct ?? null;
      if (!holding.name && quote.name) holding.name = quote.name;
    } catch (error) {
      holding.quoteError = error.message;
    }
  }
}

export function holdingDaysForFee(holding) {
  if (!holding?.firstBuyDate) return 0;
  const offset = holding.market === "exchange" ? 0 : 1;
  return Math.max(0, daysBetween(holding.firstBuyDate) - offset);
}

export function sellRateFor(holding, config = loadConfig()) {
  return sellRateForHoldingDays(holdingDaysForFee(holding), config, holding.market);
}

export function appendEquitySnapshot(account) {
  const summary = positionSummary(account);
  const record = {
    date: today(),
    at: nowIso(),
    equity: summary.equity,
    cash: summary.cash,
    positionValue: summary.positionValue,
    totalPnl: summary.totalPnl,
  };
  appendEquitySnapshotToDb(record);
  return { record, snapshots: readEquitySnapshots() };
}
