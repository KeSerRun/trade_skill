import { CACHE_DIR, DB_FILE, PROJECT_ROOT, STATE_DIR } from "./paths.mjs";
import { loadRulesFromDb } from "./sqlite.mjs";

export { CACHE_DIR, DB_FILE, PROJECT_ROOT, STATE_DIR };

export const DEFAULT_CONFIG = {
  risk: {
    maxSinglePositionPct: 0.3,
    maxTotalPositionPct: 0.95,
    minCashReservePct: 0.05,
    maxOrderAmount: 50000,
    minHoldingDays: 2,
    exchangeMinHoldingDays: 1,
    stopLossPct: 0.15,
    takeProfitPct: 0.3,
    maxDrawdownAlertPct: 0.2,
  },
  fees: {
    buyRate: 0.0015,
    sellRateTiers: [
      { maxHoldingDays: 7, rate: 0.015 },
      { maxHoldingDays: 30, rate: 0.005 },
      { maxHoldingDays: 365, rate: 0.001 },
      { maxHoldingDays: null, rate: 0 },
    ],
  },
  data: {
    quoteCacheSeconds: 30,
    historyCacheSeconds: 3600,
    fundListCacheSeconds: 86400,
  },
  news: {
    maxAgeHours: 24,
    requireForBuy: true,
    blockOnRisk: true,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function loadConfig() {
  let userConfig = {};
  try {
    userConfig = loadRulesFromDb();
  } catch {
    userConfig = {};
  }
  return deepMerge(DEFAULT_CONFIG, userConfig);
}

export function marketFees(config, market) {
  const fallback = {
    buyRate: config.fees.buyRate,
    sellRateTiers: config.fees.sellRateTiers,
  };
  const override = market ? config.fees.markets?.[market] : null;
  return override ? { ...fallback, ...override } : fallback;
}

export function buyRateFor(market, config) {
  return marketFees(config, market).buyRate ?? 0;
}

export function sellRateForHoldingDays(holdingDays, config, market = null) {
  const tiers = marketFees(config, market).sellRateTiers;
  for (const tier of tiers) {
    if (tier.maxHoldingDays === null || tier.maxHoldingDays === undefined) return tier.rate;
    if (holdingDays < tier.maxHoldingDays) return tier.rate;
  }
  return 0;
}
