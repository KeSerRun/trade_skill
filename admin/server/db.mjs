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
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      time TEXT NOT NULL,
      market TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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

  const appDefaults = {
    auto_execute: "true",
    queries_per_fund: "3",
    max_turns: "60",
    report_max_turns: "20",
    model: "",
  };
  const insertApp = db.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)");
  for (const [key, value] of Object.entries(appDefaults)) insertApp.run(key, value, now());

  const advice = db.prepare("SELECT COUNT(*) AS n FROM advice_settings").get();
  if (!advice.n) {
    db.prepare(
      `INSERT INTO advice_settings (id, enabled, max_buys_per_day, max_sells_per_day, buy_pct, min_buy_amount,
        buy_stances, min_d20, max_distance_from_high, min_confidence, sell_stances, stop_loss_pct, take_profit_pct,
        exit_if_d20_below, updated_at)
       VALUES (1, 1, 1, 1, 0.3, 500, '["hot"]', 0, 0.08, 'medium', '["risk"]', -0.15, 0.3, -0.05, ?)`,
    ).run(now());
  }

  const notify = db.prepare("SELECT COUNT(*) AS n FROM notify_settings").get();
  if (!notify.n) {
    db.prepare(
      "INSERT INTO notify_settings (id, channel, wecom_webhook, serverchan_key, pushplus_token, title_prefix, updated_at) VALUES (1, 'none', '', '', '', '基金日报', ?)",
    ).run(now());
  }

  const insertProduct = db.prepare(
    `INSERT OR IGNORE INTO products (market, code, name, category, type, status, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  );
  for (const item of [
    { code: "000001", name: "上证指数", category: "指数", type: "index" },
    { code: "399001", name: "深证成指", category: "指数", type: "index" },
    { code: "399006", name: "创业板指", category: "指数", type: "index" },
  ]) {
    insertProduct.run("index", item.code, item.name, item.category, item.type, now());
  }

  const modeRow = db.prepare("SELECT value FROM meta WHERE key = 'market_mode'").get();
  const defaultMarket = modeRow?.value === "exchange" ? "exchange" : "otc";
  const insertTask = db.prepare(
    `INSERT OR IGNORE INTO scheduled_tasks (id, name, type, time, market, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  insertTask.run("FundDailyReport", "14:30 操作", "daily", "14:30", defaultMarket, now(), now());
  insertTask.run("FundDailyClose", "15:30 收盘", "close", "15:30", null, now(), now());
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  dropLegacyProductColumns(db);
  seed(db);
  return db;
}

function dropLegacyProductColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(products)").all().map((row) => row.name));
  for (const name of ["sector", "benchmark"]) {
    if (columns.has(name)) db.exec(`ALTER TABLE products DROP COLUMN ${name}`);
  }
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
    ? db
        .prepare(
          `SELECT w.*, p.category AS product_category, p.type AS product_type
           FROM watchlist w
           LEFT JOIN products p ON p.market = w.market AND p.code = w.code
           WHERE w.market = ? ORDER BY w.sort_order, w.code`,
        )
        .all(market)
    : db
        .prepare(
          `SELECT w.*, p.category AS product_category, p.type AS product_type
           FROM watchlist w
           LEFT JOIN products p ON p.market = w.market AND p.code = w.code
           ORDER BY w.market, w.sort_order, w.code`,
        )
        .all();
  return rows.map((row) => ({
    code: row.code,
    market: row.market,
    name: row.name,
    benchmark: row.benchmark,
    sector: row.sector,
    queries: JSON.parse(row.queries || "[]"),
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    category: row.product_category ?? null,
    productType: row.product_type ?? null,
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

export function listScheduledTasks(db) {
  return db.prepare("SELECT * FROM scheduled_tasks ORDER BY time, id").all().map((row) => ({ ...row }));
}

export function getScheduledTask(db, id) {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) ?? null;
}

export function createScheduledTask(db, task) {
  const at = now();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, name, type, time, market, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(task.id, task.name, task.type, task.time, task.market || null, task.enabled ? 1 : 0, at, at);
  return getScheduledTask(db, task.id);
}

export function updateScheduledTask(db, id, patch) {
  const current = getScheduledTask(db, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(
    "UPDATE scheduled_tasks SET name = ?, type = ?, time = ?, market = ?, enabled = ?, updated_at = ? WHERE id = ?",
  ).run(next.name, next.type, next.time, next.market || null, next.enabled ? 1 : 0, now(), id);
  return getScheduledTask(db, id);
}

export function deleteScheduledTask(db, id) {
  return db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id).changes;
}

export function countDailyTasks(db, excludeId = null) {
  if (excludeId) {
    return db.prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE type = 'daily' AND id != ?").get(excludeId).n;
  }
  return db.prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE type = 'daily'").get().n;
}

export function listProducts(db, { search = "", market = "", watched = false, page = 1, pageSize = 20 } = {}) {
  const filters = ["p.status = 'active'"];
  const params = [];
  const query = String(search ?? "").trim();
  if (query) {
    filters.push("(p.code LIKE ? OR p.name LIKE ?)");
    params.push(`%${query}%`, `%${query}%`);
  }
  const marketFilter = String(market ?? "").trim();
  if (marketFilter && marketFilter !== "all") {
    filters.push("p.market = ?");
    params.push(marketFilter);
  }
  if (watched) {
    filters.push("EXISTS (SELECT 1 FROM watchlist w WHERE w.market = p.market AND w.code = p.code)");
  }
  const where = filters.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${where}`).get(...params).n;
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const rows = db
    .prepare(
      `SELECT p.*, EXISTS (
         SELECT 1 FROM watchlist w WHERE w.market = p.market AND w.code = p.code
       ) AS watched
       FROM products p
       WHERE ${where}
       ORDER BY CASE p.market WHEN 'index' THEN 0 WHEN 'exchange' THEN 1 ELSE 2 END, p.code
       LIMIT ? OFFSET ?`,
    )
    .all(...params, safeSize, (safePage - 1) * safeSize);
  const counts = { all: 0, index: 0, exchange: 0, otc: 0 };
  for (const row of db.prepare("SELECT market, COUNT(*) AS n FROM products WHERE status = 'active' GROUP BY market").all()) {
    if (counts[row.market] !== undefined) counts[row.market] = row.n;
    counts.all += row.n;
  }
  return {
    items: rows.map((row) => ({
      key: `${row.market}:${row.code}`,
      market: row.market,
      code: row.code,
      name: row.name,
      category: row.category,
      type: row.type,
      status: row.status,
      watched: row.watched === 1,
    })),
    total,
    page: safePage,
    pageSize: safeSize,
    counts,
  };
}

export function getProductsByKeys(db, keys) {
  const statement = db.prepare("SELECT * FROM products WHERE market = ? AND code = ?");
  const result = new Map();
  for (const key of keys ?? []) {
    const [market, ...rest] = String(key).split(":");
    const code = rest.join(":");
    const row = statement.get(market, code);
    if (row) result.set(key, { ...row, key });
  }
  return result;
}

export function getAppSettings(db) {
  const rows = db.prepare("SELECT key, value FROM app_settings").all();
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    autoExecute: map.auto_execute !== "false",
    queriesPerFund: Number(map.queries_per_fund ?? 3),
    maxTurns: Number(map.max_turns ?? 60),
    reportMaxTurns: Number(map.report_max_turns ?? 20),
    model: map.model ?? "",
  };
}

export function setAppSettings(db, payload) {
  const values = {
    auto_execute: payload.autoExecute === undefined ? undefined : payload.autoExecute ? "true" : "false",
    queries_per_fund: payload.queriesPerFund === undefined ? undefined : String(payload.queriesPerFund),
    max_turns: payload.maxTurns === undefined ? undefined : String(payload.maxTurns),
    report_max_turns: payload.reportMaxTurns === undefined ? undefined : String(payload.reportMaxTurns),
    model: payload.model === undefined ? undefined : String(payload.model),
  };
  const upsert = db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) upsert.run(key, value, now());
  }
  return getAppSettings(db);
}

export function getAdviceSettings(db) {
  const row = db.prepare("SELECT * FROM advice_settings WHERE id = 1").get();
  if (!row) return null;
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
    updatedAt: row.updated_at,
  };
}

export function setAdviceSettings(db, payload) {
  const current = getAdviceSettings(db);
  const next = { ...current, ...payload };
  db.prepare(
    `UPDATE advice_settings SET
      enabled = ?, max_buys_per_day = ?, max_sells_per_day = ?, buy_pct = ?, min_buy_amount = ?,
      buy_stances = ?, min_d20 = ?, max_distance_from_high = ?, min_confidence = ?, sell_stances = ?,
      stop_loss_pct = ?, take_profit_pct = ?, exit_if_d20_below = ?, updated_at = ?
     WHERE id = 1`,
  ).run(
    next.enabled ? 1 : 0,
    next.maxBuysPerDay,
    next.maxSellsPerDay,
    next.buyPct,
    next.minBuyAmount,
    JSON.stringify(next.buyStances),
    next.minD20,
    next.maxDistanceFromHigh,
    next.minConfidence,
    JSON.stringify(next.sellStances),
    next.stopLossPct,
    next.takeProfitPct,
    next.exitIfD20Below,
    now(),
  );
  return getAdviceSettings(db);
}

export function getNotifySettings(db) {
  const row = db.prepare("SELECT * FROM notify_settings WHERE id = 1").get();
  return {
    channel: row?.channel ?? "none",
    wecomWebhook: row?.wecom_webhook ?? "",
    serverChanKey: row?.serverchan_key ?? "",
    pushplusToken: row?.pushplus_token ?? "",
    titlePrefix: row?.title_prefix ?? "基金日报",
    updatedAt: row?.updated_at ?? null,
  };
}

export function setNotifySettings(db, payload) {
  const current = getNotifySettings(db);
  const next = { ...current, ...payload };
  db.prepare(
    `INSERT INTO notify_settings (id, channel, wecom_webhook, serverchan_key, pushplus_token, title_prefix, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, wecom_webhook = excluded.wecom_webhook,
       serverchan_key = excluded.serverchan_key, pushplus_token = excluded.pushplus_token,
       title_prefix = excluded.title_prefix, updated_at = excluded.updated_at`,
  ).run(
    next.channel,
    next.wecomWebhook ?? "",
    next.serverChanKey ?? "",
    next.pushplusToken ?? "",
    next.titlePrefix ?? "基金日报",
    now(),
  );
  return getNotifySettings(db);
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
