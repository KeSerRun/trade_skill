import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "./paths.mjs";

let db = null;

function ensureSchema(handle) {
  handle.exec(`
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
      sector TEXT,
      queries TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (market, code)
    );
    CREATE TABLE IF NOT EXISTS products (
      market TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (market, code)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS advice_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      max_buys_per_day INTEGER NOT NULL DEFAULT 1,
      max_sells_per_day INTEGER NOT NULL DEFAULT 1,
      buy_pct REAL NOT NULL DEFAULT 0.3,
      min_buy_amount REAL NOT NULL DEFAULT 500,
      buy_stances TEXT NOT NULL DEFAULT '["hot"]',
      min_d20 REAL NOT NULL DEFAULT 0,
      max_distance_from_high REAL NOT NULL DEFAULT 0.08,
      min_confidence TEXT NOT NULL DEFAULT 'medium',
      sell_stances TEXT NOT NULL DEFAULT '["risk"]',
      stop_loss_pct REAL NOT NULL DEFAULT -0.15,
      take_profit_pct REAL NOT NULL DEFAULT 0.3,
      exit_if_d20_below REAL NOT NULL DEFAULT -0.05,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notify_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel TEXT NOT NULL DEFAULT 'none',
      wecom_webhook TEXT,
      serverchan_key TEXT,
      pushplus_token TEXT,
      title_prefix TEXT NOT NULL DEFAULT '基金日报',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  ensureSchema(db);
  return db;
}

function tx(fn) {
  const handle = getDb();
  handle.exec("BEGIN");
  try {
    const result = fn(handle);
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}

export function hasAccount() {
  return Boolean(getDb().prepare("SELECT id FROM account WHERE id = 1").get());
}

export function resetAccountAndOrders() {
  tx((handle) => {
    handle.exec("DELETE FROM account; DELETE FROM positions; DELETE FROM trades; DELETE FROM orders;");
  });
}

export function loadAccountFromDb() {
  const handle = getDb();
  const account = handle.prepare("SELECT * FROM account WHERE id = 1").get();
  if (!account) return null;
  const positions = handle.prepare("SELECT * FROM positions ORDER BY market, code").all();
  const trades = handle.prepare("SELECT * FROM trades ORDER BY date, id").all();
  const holdings = {};
  for (const position of positions) {
    const base = position.raw ? JSON.parse(position.raw) : {};
    holdings[position.code] = {
      ...base,
      code: position.code,
      name: position.name,
      market: position.market,
      shares: position.shares,
      cost: position.cost,
      avgCost: position.avg_cost,
      firstBuyDate: position.first_buy_date,
      lastNav: position.last_nav,
      lastNavDate: position.last_nav_date,
    };
  }
  return {
    version: 1,
    createdAt: account.updated_at,
    updatedAt: account.updated_at,
    initialCash: account.initial_cash,
    cash: account.cash,
    realizedPnl: account.realized_pnl,
    holdings,
    trades: trades.map((trade) => {
      const base = trade.raw ? JSON.parse(trade.raw) : {};
      return {
        ...base,
        id: trade.id,
        code: trade.code,
        name: trade.name,
        type: trade.type,
        shares: trade.shares,
        nav: trade.nav,
        amount: trade.amount,
        fee: trade.fee,
        feeRate: trade.fee_rate,
        date: trade.date,
        realizedPnl: trade.realized_pnl,
        note: trade.note,
        settled: trade.settled === 1,
      };
    }),
  };
}

export function saveAccountToDb(account) {
  const at = account.updatedAt ?? new Date().toISOString();
  tx((handle) => {
    handle.prepare(
      `INSERT INTO account (id, initial_cash, cash, realized_pnl, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET initial_cash = excluded.initial_cash, cash = excluded.cash,
         realized_pnl = excluded.realized_pnl, updated_at = excluded.updated_at`,
    ).run(account.initialCash, account.cash, account.realizedPnl ?? 0, at);

    handle.exec("DELETE FROM positions");
    const insertPosition = handle.prepare(
      `INSERT INTO positions (code, name, market, shares, cost, avg_cost, first_buy_date, last_nav, last_nav_date, raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const holding of Object.values(account.holdings ?? {})) {
      insertPosition.run(
        holding.code,
        holding.name ?? null,
        holding.market ?? "otc",
        holding.shares ?? 0,
        holding.cost ?? 0,
        holding.avgCost ?? (holding.shares > 0 ? holding.cost / holding.shares : 0),
        holding.firstBuyDate ?? null,
        holding.lastNav ?? null,
        holding.lastNavDate ?? null,
        JSON.stringify(holding),
        at,
      );
    }

    handle.exec("DELETE FROM trades");
    const insertTrade = handle.prepare(
      `INSERT INTO trades (id, code, name, type, shares, nav, amount, fee, fee_rate, date, realized_pnl, note, source, settled, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const trade of account.trades ?? []) {
      insertTrade.run(
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
  });
}

export function loadOrdersFromDb() {
  return getDb()
    .prepare("SELECT payload FROM orders ORDER BY updated_at ASC")
    .all()
    .map((row) => JSON.parse(row.payload));
}

export function saveOrdersToDb(orders) {
  const at = new Date().toISOString();
  tx((handle) => {
    handle.exec("DELETE FROM orders");
    const insert = handle.prepare("INSERT INTO orders (id, payload, updated_at) VALUES (?, ?, ?)");
    for (const order of orders) {
      insert.run(String(order.id), JSON.stringify(order), at);
    }
  });
}

export function appendEquitySnapshotToDb(record) {
  getDb()
    .prepare(
      "INSERT INTO equity_snapshots (date, at, equity, cash, position_value, total_pnl) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(record.date, record.at, record.equity, record.cash, record.positionValue, record.totalPnl);
}

export function readEquitySnapshots() {
  return getDb().prepare("SELECT * FROM equity_snapshots ORDER BY id ASC").all().map((row) => ({ ...row }));
}

export function loadVerdictFromDb(code) {
  const row = getDb().prepare("SELECT payload FROM news_verdicts WHERE code = ?").get(code);
  return row ? JSON.parse(row.payload) : null;
}

export function saveVerdictToDb(verdict) {
  getDb()
    .prepare(
      "INSERT INTO news_verdicts (code, payload, scanned_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET payload = excluded.payload, scanned_at = excluded.scanned_at",
    )
    .run(String(verdict.code), JSON.stringify(verdict), verdict.scannedAt);
}

export function loadMarketMode() {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = 'market_mode'").get();
  return row?.value === "exchange" ? "exchange" : "otc";
}

export function loadWatchlist(market) {
  const rows = getDb()
    .prepare("SELECT * FROM watchlist WHERE market = ? AND enabled = 1 ORDER BY sort_order, code")
    .all(market);
  return rows.map((row) => ({
    code: row.code,
    market: row.market,
    name: row.name,
    sector: row.sector,
    queries: JSON.parse(row.queries || "[]"),
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
  }));
}

export function loadAppSettings() {
  const rows = getDb().prepare("SELECT key, value FROM app_settings").all();
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    autoExecute: map.auto_execute !== "false",
    queriesPerFund: Number(map.queries_per_fund ?? 3),
    maxTurns: Number(map.max_turns ?? 60),
    reportMaxTurns: Number(map.report_max_turns ?? 20),
    model: map.model ?? "",
  };
}

export function loadAdviceSettings() {
  const row = getDb().prepare("SELECT * FROM advice_settings WHERE id = 1").get();
  if (!row) return {};
  return {
    enabled: row.enabled === 1,
    maxBuysPerDay: row.max_buys_per_day,
    maxSellsPerDay: row.max_sells_per_day,
    buyPct: row.buy_pct,
    minBuyAmount: row.min_buy_amount,
    buyStances: JSON.parse(row.buy_stances || "[]"),
    minD20: row.min_d20,
    maxDistanceFromHigh: row.max_distance_from_high,
    minConfidence: row.min_confidence,
    sellStances: JSON.parse(row.sell_stances || "[]"),
    stopLossPct: row.stop_loss_pct,
    takeProfitPct: row.take_profit_pct,
    exitIfD20Below: row.exit_if_d20_below,
  };
}

export function loadNotifySettings() {
  const row = getDb().prepare("SELECT * FROM notify_settings WHERE id = 1").get();
  return {
    channel: row?.channel ?? "none",
    wecomWebhook: row?.wecom_webhook ?? "",
    serverChanKey: row?.serverchan_key ?? "",
    pushplusToken: row?.pushplus_token ?? "",
    titlePrefix: row?.title_prefix ?? "基金日报",
  };
}

export function loadRulesFromDb() {
  const handle = getDb();
  const rows = handle.prepare("SELECT * FROM trade_rules").all();
  const portfolio = handle.prepare("SELECT * FROM portfolio_rules WHERE id = 1").get();
  if (rows.length === 0 && !portfolio) return {};
  const result = {};
  if (portfolio) {
    result.risk = {
      maxSinglePositionPct: portfolio.max_single_position_pct,
      maxTotalPositionPct: portfolio.max_total_position_pct,
      minCashReservePct: portfolio.min_cash_reserve_pct,
      maxOrderAmount: portfolio.max_order_amount,
    };
  }
  const otc = rows.find((row) => row.market === "otc");
  const exchange = rows.find((row) => row.market === "exchange");
  if (otc) {
    result.risk = { ...(result.risk ?? {}), minHoldingDays: otc.min_holding_days };
    result.fees = { buyRate: otc.buy_fee_rate, sellRateTiers: JSON.parse(otc.sell_tiers) };
  }
  if (exchange) {
    result.risk = { ...(result.risk ?? {}), exchangeMinHoldingDays: exchange.min_holding_days };
    const markets = {};
    if (otc) markets.otc = { buyRate: otc.buy_fee_rate, sellRateTiers: JSON.parse(otc.sell_tiers) };
    markets.exchange = { buyRate: exchange.buy_fee_rate, sellRateTiers: JSON.parse(exchange.sell_tiers) };
    result.fees = { ...(result.fees ?? {}), markets };
  }
  return result;
}
