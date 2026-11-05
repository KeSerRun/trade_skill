import { nowIso, round } from "./store.mjs";

export function computeBuyFill({ amount, nav, feeRate, fee, shares }) {
  const finalFee = fee ?? round(amount * (feeRate ?? 0), 2);
  const finalShares = shares ?? round((amount - finalFee) / nav, 2);
  return {
    amount: round(amount, 2),
    nav,
    fee: round(finalFee, 2),
    feeRate,
    shares: round(finalShares, 2),
    netAmount: round(amount - finalFee, 2),
  };
}

export function computeSellFill({ shares, nav, feeRate, fee }) {
  const gross = round(shares * nav, 2);
  const finalFee = fee ?? round(gross * (feeRate ?? 0), 2);
  return {
    shares: round(shares, 2),
    nav,
    gross,
    fee: round(finalFee, 2),
    feeRate,
    proceeds: round(gross - finalFee, 2),
  };
}

export function applyBuy(account, payload) {
  const { code, name, amount, nav, shares, fee, date, market = null, note = null, orderId = null } = payload;
  if (!(shares > 0)) throw new Error("买入份额必须大于 0");
  if (amount > account.cash + 1e-9) {
    throw new Error(`现金不足：可用 ${account.cash.toFixed(2)} 元，本次需要 ${amount.toFixed(2)} 元`);
  }

  const existing = account.holdings[code];
  if (existing) {
    existing.shares = round(existing.shares + shares, 2);
    existing.cost = round(existing.cost + amount, 2);
    existing.avgCost = round(existing.cost / existing.shares, 4);
    existing.lastNav = nav;
    existing.lastNavDate = date;
    if (market) existing.market = market;
    if (!existing.name && name) existing.name = name;
  } else {
    account.holdings[code] = {
      code,
      name,
      market,
      shares: round(shares, 2),
      cost: round(amount, 2),
      avgCost: round(amount / shares, 4),
      firstBuyDate: date,
      lastNav: nav,
      lastNavDate: date,
      lastChangePct: null,
    };
  }
  account.cash = round(account.cash - amount, 2);

  const trade = {
    id: `t${Date.now().toString(36)}`,
    at: nowIso(),
    date,
    type: "BUY",
    code,
    name,
    shares: round(shares, 2),
    nav,
    amount: round(amount, 2),
    fee: round(fee ?? 0, 2),
    cashAfter: account.cash,
    note,
    orderId,
  };
  account.trades.push(trade);
  return trade;
}

export function applySell(account, payload) {
  const { code, shares, nav, feeRate = 0, fee, date, note = null, orderId = null } = payload;
  const holding = account.holdings[code];
  if (!holding) throw new Error(`未持有基金 ${code}`);
  if (!(shares > 0)) throw new Error("卖出份额必须大于 0");
  if (shares > holding.shares + 1e-6) {
    throw new Error(`持有份额不足：当前 ${holding.shares}，本次 ${shares}`);
  }

  const fill = computeSellFill({ shares, nav, feeRate, fee });
  const costPortion = round(holding.avgCost * shares, 2);
  const realized = round(fill.proceeds - costPortion, 2);
  const closing = shares >= holding.shares - 1e-6;

  account.cash = round(account.cash + fill.proceeds, 2);
  account.realizedPnl = round((account.realizedPnl ?? 0) + realized, 2);

  holding.shares = round(holding.shares - shares, 2);
  holding.cost = round(holding.cost - costPortion, 2);
  if (closing) {
    delete account.holdings[code];
  } else {
    holding.avgCost = round(holding.cost / holding.shares, 4);
    holding.lastNav = nav;
    holding.lastNavDate = date;
  }

  const trade = {
    id: `t${Date.now().toString(36)}`,
    at: nowIso(),
    date,
    type: "SELL",
    code,
    name: holding.name ?? null,
    shares: fill.shares,
    nav,
    gross: fill.gross,
    fee: fill.fee,
    amount: fill.proceeds,
    realizedPnl: realized,
    cashAfter: account.cash,
    note,
    orderId,
  };
  account.trades.push(trade);
  return { trade, fill, costPortion, realized, closing };
}
