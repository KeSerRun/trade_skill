import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_RULES = {
  otc: {
    minHoldingDays: 2,
    buyFeeRate: 0.0015,
    sellTiers: [
      { maxHoldingDays: 7, rate: 0.015 },
      { maxHoldingDays: 30, rate: 0.005 },
      { maxHoldingDays: 365, rate: 0.001 },
      { maxHoldingDays: null, rate: 0 },
    ],
  },
  exchange: {
    minHoldingDays: 1,
    buyFeeRate: 0.0003,
    sellTiers: [{ maxHoldingDays: null, rate: 0 }],
  },
  portfolio: {
    maxSinglePositionPct: 0.3,
    maxTotalPositionPct: 0.95,
    minCashReservePct: 0.05,
    maxOrderAmount: 50000,
  },
};

const now = () => new Date().toISOString();

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      initial_cash REAL NOT NULL,
      cash REAL NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      code TEXT PRIMARY KEY,
      name TEXT,
      market TEXT NOT NULL,
      shares REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      first_buy_date TEXT,
      last_nav REAL,
      last_nav_date TEXT,
      raw TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT,
      type TEXT NOT NULL,
      shares REAL,
      nav REAL,
      amount REAL,
      fee REAL,
      fee_rate REAL,
      date TEXT,
      realized_pnl REAL,
      note TEXT,
      source TEXT,
      settled INTEGER,
      raw TEXT
    );
    CREATE TABLE IF NOT EXISTS trade_rules (
      market TEXT PRIMARY KEY,
      min_holding_days INTEGER NOT NULL,
      buy_fee_rate REAL NOT NULL,
      sell_tiers TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portfolio_rules (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_single_position_pct REAL NOT NULL,
      max_total_position_pct REAL NOT NULL,
      min_cash_reserve_pct REAL NOT NULL,
      max_order_amount REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      at TEXT NOT NULL,
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      position_value REAL NOT NULL,
      total_pnl REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS news_verdicts (
      code TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      scanned_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      code TEXT NOT NULL,
      market TEXT NOT NULL,
      name TEXT,
      benchmark TEXT,
      sector TEXT,
      queries TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (market, code)
    );
  `);
}

function seed(db) {
  const account = db.prepare("SELECT COUNT(*) AS n FROM account").get();
  if (!account.n) {
    db.prepare("INSERT INTO account (id, initial_cash, cash, realized_pnl, updated_at) VALUES (1, ?, ?, 0, ?)")
      .run(10000, 10000, now());
  }

  const rules = db.prepare("SELECT COUNT(*) AS n FROM trade_rules").get();
  if (!rules.n) {
    const insert = db.prepare("INSERT INTO trade_rules (market, min_holding_days, buy_fee_rate, sell_tiers, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const market of ["otc", "exchange"]) {
      const item = DEFAULT_RULES[market];
      insert.run(market, item.minHoldingDays, item.buyFeeRate, JSON.stringify(item.sellTiers), now());
    }
  }

  const portfolio = db.prepare("SELECT COUNT(*) AS n FROM portfolio_rules").get();
  if (!portfolio.n) {
    const item = DEFAULT_RULES.portfolio;
    db.prepare(
      "INSERT INTO portfolio_rules (id, max_single_position_pct, max_total_position_pct, min_cash_reserve_pct, max_order_amount, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
    ).run(item.maxSinglePositionPct, item.maxTotalPositionPct, item.minCashReservePct, item.maxOrderAmount, now());
  }
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seed(db);
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMarketMode(db) {
  return getMeta(db, "market_mode") === "exchange" ? "exchange" : "otc";
}

export function setMarketMode(db, mode) {
  if (mode !== "otc" && mode !== "exchange") throw new Error("mode 只能是 otc 或 exchange");
  setMeta(db, "market_mode", mode);
}

export function listWatchlist(db, market = null) {
  const rows = market
    ? db.prepare("SELECT * FROM watchlist WHERE market = ? ORDER BY sort_order, code").all(market)
    : db.prepare("SELECT * FROM watchlist ORDER BY market, sort_order, code").all();
  return rows.map((row) => ({
    code: row.code,
    market: row.market,
    name: row.name,
    benchmark: row.benchmark,
    sector: row.sector,
    queries: JSON.parse(row.queries || "[]"),
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  }));
}

export function upsertWatchlist(db, item) {
  const market = String(item.market ?? "");
  if (market !== "otc" && market !== "exchange") throw new Error("market 只能是 otc 或 exchange");
  const code = String(item.code ?? "").trim();
  if (!code) throw new Error("缺少基金代码");
  const queries = Array.isArray(item.queries) ? item.queries.map(String) : [];
  db.prepare(
    `INSERT INTO watchlist (code, market, name, benchmark, sector, queries, enabled, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(market, code) DO UPDATE SET
       name = excluded.name, benchmark = excluded.benchmark, sector = excluded.sector,
       queries = excluded.queries, enabled = excluded.enabled, sort_order = excluded.sort_order,
       updated_at = excluded.updated_at`,
  ).run(
    code,
    market,
    item.name ?? null,
    item.benchmark ?? null,
    item.sector ?? null,
    JSON.stringify(queries),
    item.enabled === false ? 0 : 1,
    Number(item.sortOrder ?? 0),
    now(),
  );
  return listWatchlist(db, market);
}

export function deleteWatchlist(db, market, code) {
  return db.prepare("DELETE FROM watchlist WHERE market = ? AND code = ?").run(market, code).changes;
}

export function getAccount(db) {
  return { ...db.prepare("SELECT * FROM account WHERE id = 1").get() };
}

export function setAccount(db, payload) {
  db.prepare("UPDATE account SET initial_cash = ?, cash = ?, realized_pnl = ?, updated_at = ? WHERE id = 1")
    .run(payload.initialCash, payload.cash, payload.realizedPnl ?? 0, now());
}

export function listPositions(db) {
  return db.prepare("SELECT * FROM positions ORDER BY market, code").all().map((row) => ({ ...row }));
}

export function getPosition(db, code) {
  const row = db.prepare("SELECT * FROM positions WHERE code = ?").get(code);
  return row ? { ...row } : null;
}

export function upsertPosition(db, payload) {
  const shares = Number(payload.shares ?? 0);
  const cost = Number(payload.cost ?? 0);
  const avgCost = Number(payload.avgCost ?? (shares > 0 ? cost / shares : 0));
  db.prepare(
    `INSERT INTO positions (code, name, market, shares, cost, avg_cost, first_buy_date, last_nav, last_nav_date, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, market = excluded.market, shares = excluded.shares, cost = excluded.cost,
       avg_cost = excluded.avg_cost, first_buy_date = excluded.first_buy_date, last_nav = excluded.last_nav,
       last_nav_date = excluded.last_nav_date, raw = excluded.raw, updated_at = excluded.updated_at`,
  ).run(
    String(payload.code),
    payload.name ?? null,
    payload.market,
    shares,
    cost,
    avgCost,
    payload.firstBuyDate ?? null,
    payload.lastNav ?? null,
    payload.lastNavDate ?? null,
    payload.raw ? JSON.stringify(payload.raw) : null,
    now(),
  );
}

export function deletePosition(db, code) {
  return db.prepare("DELETE FROM positions WHERE code = ?").run(code).changes;
}

export function listTrades(db, { limit = 200, code = null, type = null } = {}) {
  const conditions = [];
  const params = [];
  if (code) {
    conditions.push("code = ?");
    params.push(code);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(Number(limit) || 200);
  return db.prepare(`SELECT * FROM trades ${where} ORDER BY date DESC, id DESC LIMIT ?`).all(...params).map((row) => ({ ...row }));
}

export function replaceTrades(db, trades) {
  db.exec("DELETE FROM trades");
  const insert = db.prepare(
    `INSERT INTO trades (id, code, name, type, shares, nav, amount, fee, fee_rate, date, realized_pnl, note, source, settled, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const trade of trades) {
    insert.run(
      String(trade.id),
      String(trade.code),
      trade.name ?? null,
      trade.type,
      trade.shares ?? null,
      trade.nav ?? null,
      trade.amount ?? null,
      trade.fee ?? null,
      trade.feeRate ?? null,
      trade.date ?? null,
      trade.realizedPnl ?? null,
      trade.note ?? null,
      trade.auto ? "auto" : "manual",
      trade.settled === false ? 0 : 1,
      JSON.stringify(trade),
    );
  }
}

export function getRules(db) {
  const rows = db.prepare("SELECT * FROM trade_rules").all();
  const portfolio = db.prepare("SELECT * FROM portfolio_rules WHERE id = 1").get();
  const result = { portfolio: { ...portfolio } };
  for (const row of rows) {
    result[row.market] = {
      minHoldingDays: row.min_holding_days,
      buyFeeRate: row.buy_fee_rate,
      sellTiers: JSON.parse(row.sell_tiers),
    };
  }
  return result;
}

export function setRules(db, rules) {
  const update = db.prepare(
    "INSERT INTO trade_rules (market, min_holding_days, buy_fee_rate, sell_tiers, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET min_holding_days = excluded.min_holding_days, buy_fee_rate = excluded.buy_fee_rate, sell_tiers = excluded.sell_tiers, updated_at = excluded.updated_at",
  );
  for (const market of ["otc", "exchange"]) {
    const item = rules[market];
    update.run(market, item.minHoldingDays, item.buyFeeRate, JSON.stringify(item.sellTiers), now());
  }
  const p = rules.portfolio;
  db.prepare(
    "UPDATE portfolio_rules SET max_single_position_pct = ?, max_total_position_pct = ?, min_cash_reserve_pct = ?, max_order_amount = ?, updated_at = ? WHERE id = 1",
  ).run(p.maxSinglePositionPct, p.maxTotalPositionPct, p.minCashReservePct, p.maxOrderAmount, now());
}

export function stateSummary(db) {
  const account = getAccount(db);
  const positions = listPositions(db).map((row) => {
    const nav = row.last_nav ?? row.avg_cost;
    const marketValue = row.shares * nav;
    const pnl = marketValue - row.cost;
    return {
      ...row,
      marketValue,
      pnl,
      pnlPct: row.cost > 0 ? pnl / row.cost : 0,
    };
  });
  const positionValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
  const equity = account.cash + positionValue;
  const unrealizedPnl = positions.reduce((sum, row) => sum + row.pnl, 0);
  const cost = positions.reduce((sum, row) => sum + row.cost, 0);
  return {
    account: {
      initialCash: account.initial_cash,
      cash: account.cash,
      realizedPnl: account.realized_pnl,
      updatedAt: account.updated_at,
    },
    positions: positions.map((row) => ({
      ...row,
      weight: equity > 0 ? row.marketValue / equity : 0,
    })),
    summary: {
      cash: account.cash,
      positionValue,
      equity,
      cost,
      unrealizedPnl,
      realizedPnl: account.realized_pnl,
      totalPnl: equity - account.initial_cash,
      totalPnlPct: account.initial_cash > 0 ? (equity - account.initial_cash) / account.initial_cash : 0,
      cashPct: equity > 0 ? account.cash / equity : 0,
      investedPct: equity > 0 ? positionValue / equity : 0,
    },
  };
}
