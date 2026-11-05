import { daysBetween, round } from "./store.mjs";

export function checkBuy(account, config, code, amount, state) {
  const violations = [];
  const warnings = [];
  const risk = config.risk;
  const equity = state.equity;
  const holding = account.holdings[code];
  const currentValue = holding ? holding.shares * (holding.lastNav ?? holding.avgCost) : 0;
  const projectedValue = currentValue + amount;

  if (amount > risk.maxOrderAmount) {
    violations.push(`单笔金额 ${amount.toFixed(2)} 超过上限 ${risk.maxOrderAmount.toFixed(2)}`);
  }
  if (amount > state.cash) {
    violations.push(`现金不足：可用 ${state.cash.toFixed(2)}，需要 ${amount.toFixed(2)}`);
  }
  const cashAfter = state.cash - amount;
  if (equity > 0 && cashAfter / equity < risk.minCashReservePct) {
    violations.push(`交易后现金占比 ${(cashAfter / equity * 100).toFixed(2)}% 低于底线 ${(risk.minCashReservePct * 100).toFixed(2)}%`);
  }
  if (equity > 0 && projectedValue / equity > risk.maxSinglePositionPct) {
    violations.push(`单只基金占比将达 ${(projectedValue / equity * 100).toFixed(2)}%，超过上限 ${(risk.maxSinglePositionPct * 100).toFixed(2)}%`);
  }
  const projectedPosition = state.positionValue + amount;
  if (equity > 0 && projectedPosition / equity > risk.maxTotalPositionPct) {
    violations.push(`总仓位将达 ${(projectedPosition / equity * 100).toFixed(2)}%，超过上限 ${(risk.maxTotalPositionPct * 100).toFixed(2)}%`);
  }
  if (holding && holding.shares > 0) {
    warnings.push(`已持有 ${holding.shares} 份（成本价 ${holding.avgCost}），本次为加仓`);
  }

  return {
    allowed: violations.length === 0,
    violations,
    warnings,
    projection: {
      amount: round(amount, 2),
      code,
      name: holding?.name ?? null,
      currentValue: round(currentValue, 2),
      projectedValue: round(projectedValue, 2),
      projectedWeight: equity > 0 ? projectedValue / equity : 0,
      cashAfter: round(cashAfter, 2),
      cashPctAfter: equity > 0 ? cashAfter / equity : 0,
      totalPositionPctAfter: equity > 0 ? projectedPosition / equity : 0,
    },
  };
}

export function checkSell(account, config, code, shares) {
  const violations = [];
  const warnings = [];
  const holding = account.holdings[code];
  if (!holding) {
    violations.push(`未持有基金 ${code}`);
    return { allowed: false, violations, warnings, projection: null };
  }
  if (shares > holding.shares + 1e-6) {
    violations.push(`卖出 ${shares} 份超过持仓 ${holding.shares} 份`);
  }
  const heldDays = daysBetween(holding.firstBuyDate);
  const minDays =
    holding.market === "exchange"
      ? config?.risk?.exchangeMinHoldingDays ?? 1
      : config?.risk?.minHoldingDays ?? 2;
  if (heldDays < minDays) {
    violations.push(
      `持有 ${heldDays} 天，未满足最短持有 ${minDays} 天（${
        holding.market === "exchange" ? "场内 T+1" : "场外申购需确认后赎回"
      }）`,
    );
  }
  const closed = shares >= holding.shares - 1e-6;
  if (closed) warnings.push("清仓：将释放全部该基金仓位");
  return {
    allowed: violations.length === 0,
    violations,
    warnings,
    projection: {
      code,
      name: holding.name,
      shares,
      heldDays,
      remainingShares: round(holding.shares - shares, 2),
      nav: holding.lastNav ?? holding.avgCost,
      estimatedProceeds: round(shares * (holding.lastNav ?? holding.avgCost), 2),
    },
  };
}
