import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deletePosition,
  deleteWatchlist,
  getAdviceSettings,
  getAppSettings,
  getNotifySettings,
  getProductsByKeys,
  getRules,
  listPositions,
  listProducts,
  listTrades,
  listWatchlist,
  openDb,
  setAccount,
  setAdviceSettings,
  setAppSettings,
  setNotifySettings,
  setRules,
  stateSummary,
  upsertPosition,
  upsertWatchlist,
} from "./db.mjs";
import { createTask, deleteTask, ensureTaskActions, listTasks, runTask, updateTask } from "./tasks.mjs";
import { createMarket } from "./market.mjs";
import { syncProducts } from "./products.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const adminDir = path.resolve(here, "..");
const projectRoot = path.resolve(adminDir, "..");
const distDir = path.join(adminDir, "dist");
const stateDir = process.env.FUND_TRADE_HOME
  ? path.resolve(process.env.FUND_TRADE_HOME)
  : path.join(projectRoot, ".fund-trading");
const dbPath = process.env.FUND_TRADE_DB
  ? path.resolve(process.env.FUND_TRADE_DB)
  : path.join(stateDir, "fund.db");
const portFlag = (() => {
  const index = process.argv.indexOf("--port");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
})();
const hostFlag = (() => {
  const index = process.argv.indexOf("--host");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
})();
const port = Number(portFlag === true ? process.env.PORT || 8787 : portFlag || process.env.PORT || 8787);
const host = hostFlag === true ? "0.0.0.0" : hostFlag || process.env.HOST || "127.0.0.1";

const db = openDb(dbPath);
const market = createMarket(db);
await ensureTaskActions(db).catch((error) => console.error("task action sync failed:", error.message));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

function numberField(value, field, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${field} 不合法`);
  }
  return parsed;
}

function normalizeMarket(value) {
  if (value !== "otc" && value !== "exchange") throw new HttpError(400, "market 只能是 otc 或 exchange");
  return value;
}

function normalizeTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) throw new HttpError(400, "sellTiers 不能为空");
  const normalized = tiers.map((tier, index) => ({
    maxHoldingDays:
      tier.maxHoldingDays === null || tier.maxHoldingDays === undefined || tier.maxHoldingDays === ""
        ? null
        : numberField(tier.maxHoldingDays, `tier[${index}].maxHoldingDays`, { min: 1 }),
    rate: numberField(tier.rate, `tier[${index}].rate`, { min: 0, max: 1 }),
  }));
  normalized.sort((a, b) => (a.maxHoldingDays ?? Infinity) - (b.maxHoldingDays ?? Infinity));
  if (normalized[normalized.length - 1].maxHoldingDays !== null) {
    normalized.push({ maxHoldingDays: null, rate: 0 });
  }
  return normalized;
}

function normalizeRules(body) {
  const result = {};
  for (const market of ["otc", "exchange"]) {
    const item = body?.[market];
    if (!item) throw new HttpError(400, `缺少 ${market} 规则`);
    result[market] = {
      minHoldingDays: numberField(item.minHoldingDays, `${market}.minHoldingDays`, { min: 0, max: 3650 }),
      buyFeeRate: numberField(item.buyFeeRate, `${market}.buyFeeRate`, { min: 0, max: 0.1 }),
      sellTiers: normalizeTiers(item.sellTiers),
    };
  }
  const portfolio = body?.portfolio;
  if (!portfolio) throw new HttpError(400, "缺少 portfolio 规则");
  result.portfolio = {
    maxSinglePositionPct: numberField(portfolio.maxSinglePositionPct, "portfolio.maxSinglePositionPct", { min: 0, max: 1 }),
    maxTotalPositionPct: numberField(portfolio.maxTotalPositionPct, "portfolio.maxTotalPositionPct", { min: 0, max: 1 }),
    minCashReservePct: numberField(portfolio.minCashReservePct, "portfolio.minCashReservePct", { min: 0, max: 1 }),
    maxOrderAmount: numberField(portfolio.maxOrderAmount, "portfolio.maxOrderAmount", { min: 0 }),
  };
  if (result.portfolio.minCashReservePct + result.portfolio.maxTotalPositionPct > 1.0001) {
    throw new HttpError(400, "现金底线 + 总仓位上限不能超过 100%");
  }
  return result;
}

function payload() {
  return {
    ok: true,
    ...stateSummary(db),
    rules: getRules(db),
    meta: {
      stateDir,
      dbPath,
      dbFile: dbPath,
    },
  };
}

function watchlistsPayload() {
  return {
    otc: listWatchlist(db, "otc"),
    exchange: listWatchlist(db, "exchange"),
  };
}

const STANCES = ["risk", "hot", "mixed", "neutral"];
const CONFIDENCE_LEVELS = ["low", "medium", "high"];
const CHANNELS = ["none", "serverchan", "wecom", "pushplus"];

function maskSecret(value) {
  return value ? `****${value.slice(-4)}` : "";
}

function publicNotify(settings) {
  return {
    channel: settings.channel,
    titlePrefix: settings.titlePrefix,
    wecomWebhook: maskSecret(settings.wecomWebhook),
    serverChanKey: maskSecret(settings.serverChanKey),
    pushplusToken: maskSecret(settings.pushplusToken),
    hasWecomWebhook: Boolean(settings.wecomWebhook),
    hasServerChanKey: Boolean(settings.serverChanKey),
    hasPushplusToken: Boolean(settings.pushplusToken),
  };
}

function normalizeQueryText(query) {
  return String(query)
    .replace(/20\d{2}年\d{0,2}月?/g, "")
    .replace(/20\d{2}[-/]\d{1,2}([-/]\d{1,2})?/g, "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRuntime(body) {
  return {
    autoExecute: body.autoExecute !== false,
    queriesPerFund: numberField(body.queriesPerFund, "queriesPerFund", { min: 1, max: 10 }),
    maxTurns: numberField(body.maxTurns, "maxTurns", { min: 5, max: 300 }),
    reportMaxTurns: numberField(body.reportMaxTurns, "reportMaxTurns", { min: 5, max: 200 }),
    model: String(body.model ?? "").trim().slice(0, 100),
  };
}

function normalizeStances(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, `${field} 不能为空`);
  for (const stance of value) {
    if (!STANCES.includes(stance)) throw new HttpError(400, `${field} 包含不合法立场`);
  }
  return [...new Set(value)];
}

function normalizeAdvice(body) {
  if (!CONFIDENCE_LEVELS.includes(body.minConfidence)) {
    throw new HttpError(400, "minConfidence 不合法");
  }
  return {
    enabled: body.enabled !== false,
    maxBuysPerDay: numberField(body.maxBuysPerDay, "maxBuysPerDay", { min: 0, max: 10 }),
    maxSellsPerDay: numberField(body.maxSellsPerDay, "maxSellsPerDay", { min: 0, max: 10 }),
    buyPct: numberField(body.buyPct, "buyPct", { min: 0, max: 1 }),
    minBuyAmount: numberField(body.minBuyAmount, "minBuyAmount", { min: 0 }),
    buyStances: normalizeStances(body.buyStances, "buyStances"),
    minD20: numberField(body.minD20, "minD20", { min: -1, max: 1 }),
    maxDistanceFromHigh: numberField(body.maxDistanceFromHigh, "maxDistanceFromHigh", { min: 0, max: 1 }),
    minConfidence: body.minConfidence,
    sellStances: normalizeStances(body.sellStances, "sellStances"),
    stopLossPct: numberField(body.stopLossPct, "stopLossPct", { min: -1, max: 0 }),
    takeProfitPct: numberField(body.takeProfitPct, "takeProfitPct", { min: 0, max: 1 }),
    exitIfD20Below: numberField(body.exitIfD20Below, "exitIfD20Below", { min: -1, max: 0 }),
  };
}

function normalizeNotify(body) {
  const channel = String(body.channel ?? "none");
  if (!CHANNELS.includes(channel)) throw new HttpError(400, "推送通道不合法");
  const current = getNotifySettings(db);
  const pickSecret = (value, existing) => {
    if (typeof value !== "string") return existing;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("****")) return existing;
    return trimmed;
  };
  return {
    channel,
    wecomWebhook: pickSecret(body.wecomWebhook, current.wecomWebhook),
    serverChanKey: pickSecret(body.serverChanKey, current.serverChanKey),
    pushplusToken: pickSecret(body.pushplusToken, current.pushplusToken),
    titlePrefix: String(body.titlePrefix ?? current.titlePrefix ?? "基金日报").trim().slice(0, 50),
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": res.req.headers.origin || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveStatic(res, pathname) {
  if (!fs.existsSync(distDir)) {
    sendJson(res, 404, {
      ok: false,
      error: "前端尚未构建。开发时运行 npm run dev，生产时先 npm run build。",
    });
    return;
  }
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(path.join(distDir, safePath));
  if (!resolved.startsWith(path.resolve(distDir))) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(resolved)] ?? "application/octet-stream" });
    fs.createReadStream(resolved).pipe(res);
    return;
  }
  const index = path.join(distDir, "index.html");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  fs.createReadStream(index).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || host}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  if (!pathname.startsWith("/api")) {
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    serveStatic(res, pathname);
    return;
  }

  try {
    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, time: now(), dbPath });
      return;
    }

    if (method === "GET" && pathname === "/api/market/snapshot") {
      const data = await market.snapshot();
      sendJson(res, 200, { ...data, ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/market/trend") {
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "缺少基金代码");
      const data = await market.trend(code);
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (method === "GET" && pathname === "/api/market/candles") {
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "缺少基金代码");
      const period = url.searchParams.get("period") || "day";
      const data = await market.candles(code, period);
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (method === "GET" && pathname === "/api/market/quotes") {
      const items = String(url.searchParams.get("items") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length === 0) throw new HttpError(400, "缺少产品代码");
      if (items.length > 50) throw new HttpError(400, "一次最多查询 50 个产品");
      for (const item of items) {
        if (!/^[a-z]+:[0-9A-Za-z.]+$/.test(item)) throw new HttpError(400, "产品代码格式不正确");
      }
      const data = await market.quotes(items);
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (method === "GET" && pathname === "/api/market/navs") {
      const items = String(url.searchParams.get("items") || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length === 0) throw new HttpError(400, "缺少产品代码");
      if (items.length > 50) throw new HttpError(400, "一次最多查询 50 个产品");
      for (const item of items) {
        if (!/^[a-z]+:[0-9A-Za-z.]+$/.test(item)) throw new HttpError(400, "产品代码格式不正确");
      }
      const data = await market.navs(items);
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (method === "GET" && pathname === "/api/products") {
      const search = String(url.searchParams.get("search") || "");
      const marketFilter = String(url.searchParams.get("market") || "");
      const watched = url.searchParams.get("watched") === "1";
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("pageSize") || 20);
      const data = listProducts(db, { search, market: marketFilter, watched, page, pageSize });
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (method === "POST" && pathname === "/api/products/sync") {
      const data = await syncProducts(db);
      sendJson(res, 200, { ok: true, ...data });
      return;
    }

    if (method === "GET" && pathname === "/api/market/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      const send = (data) => {
        try {
          res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // client disconnected; cleanup happens on close
        }
      };
      const unsubscribe = market.subscribe(send);
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          // client disconnected
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, payload());
      return;
    }

    if (method === "PUT" && pathname === "/api/account") {
      const body = await readBody(req);
      setAccount(db, {
        initialCash: numberField(body.initialCash, "initialCash", { min: 0 }),
        cash: numberField(body.cash, "cash", { min: 0 }),
        realizedPnl: numberField(body.realizedPnl ?? 0, "realizedPnl"),
      });
      sendJson(res, 200, payload());
      return;
    }

    if (method === "POST" && pathname === "/api/positions") {
      const body = await readBody(req);
      const code = String(body.code ?? "").trim();
      if (!/^[0-9A-Za-z.]{4,12}$/.test(code)) throw new HttpError(400, "基金代码格式不正确");
      const shares = numberField(body.shares ?? 0, "shares", { min: 0 });
      const cost = numberField(body.cost ?? 0, "cost", { min: 0 });
      const avgCost =
        body.avgCost === undefined || body.avgCost === null || body.avgCost === ""
          ? shares > 0
            ? cost / shares
            : 0
          : numberField(body.avgCost, "avgCost", { min: 0 });
      upsertPosition(db, {
        code,
        name: body.name ? String(body.name).trim() : null,
        market: normalizeMarket(body.market),
        shares,
        cost,
        avgCost,
        firstBuyDate: body.firstBuyDate || null,
        lastNav:
          body.lastNav === undefined || body.lastNav === null || body.lastNav === ""
            ? null
            : numberField(body.lastNav, "lastNav", { min: 0 }),
        lastNavDate: body.lastNavDate || null,
      });
      sendJson(res, 200, payload());
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/positions/")) {
      const code = decodeURIComponent(pathname.slice("/api/positions/".length));
      if (!code) throw new HttpError(400, "缺少基金代码");
      deletePosition(db, code);
      sendJson(res, 200, payload());
      return;
    }

    if (method === "GET" && pathname === "/api/trades") {
      sendJson(res, 200, {
        ok: true,
        trades: listTrades(db, {
          limit: numberField(url.searchParams.get("limit") ?? 200, "limit", { min: 1, max: 5000 }),
          code: url.searchParams.get("code") || null,
          type: url.searchParams.get("type") || null,
        }),
      });
      return;
    }

    if (method === "GET" && pathname === "/api/rules") {
      sendJson(res, 200, { ok: true, rules: getRules(db) });
      return;
    }

    if (method === "PUT" && pathname === "/api/rules") {
      const body = await readBody(req);
      setRules(db, normalizeRules(body));
      sendJson(res, 200, payload());
      return;
    }

    if (method === "GET" && pathname === "/api/tasks") {
      sendJson(res, 200, {
        ok: true,
        tasks: await listTasks(db),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/tasks") {
      const body = await readBody(req);
      const tasks = await createTask(db, {
        name: body.name === undefined ? "" : String(body.name),
        type: body.type === undefined ? "daily" : String(body.type),
        time: body.time === undefined ? "14:30" : String(body.time),
        market: body.market === undefined ? "otc" : String(body.market),
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      });
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (method === "GET" && pathname === "/api/watchlist") {
      sendJson(res, 200, { ok: true, watchlists: watchlistsPayload() });
      return;
    }

    if (method === "POST" && pathname === "/api/watchlist") {
      const body = await readBody(req);
      const market = String(body.market ?? "");
      if (market !== "otc" && market !== "exchange") throw new HttpError(400, "market 只能是 otc 或 exchange");
      const code = String(body.code ?? "").trim();
      if (!/^[0-9A-Za-z.]{4,12}$/.test(code)) throw new HttpError(400, "基金代码格式不正确");
      const productKey = `${market}:${code}`;
      const product = getProductsByKeys(db, [productKey]).get(productKey);
      if (!product) throw new HttpError(400, "请先从产品库选择产品");
      upsertWatchlist(db, {
        market,
        code,
        name: product.name,
        sector: body.sector ? String(body.sector).trim() : null,
        queries: Array.isArray(body.queries)
          ? body.queries.map(normalizeQueryText).filter(Boolean)
          : [],
        enabled: body.enabled !== false,
        sortOrder: numberField(body.sortOrder ?? 0, "sortOrder", { min: 0 }),
      });
      sendJson(res, 200, { ok: true, watchlists: watchlistsPayload() });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/watchlist/")) {
      const parts = pathname.split("/").filter(Boolean);
      const market = decodeURIComponent(parts[2] ?? "");
      const code = decodeURIComponent(parts[3] ?? "");
      if (market !== "otc" && market !== "exchange") throw new HttpError(400, "market 只能是 otc 或 exchange");
      if (!code) throw new HttpError(400, "缺少基金代码");
      deleteWatchlist(db, market, code);
      sendJson(res, 200, { ok: true, watchlists: watchlistsPayload() });
      return;
    }

    if (method === "PUT" && pathname.startsWith("/api/tasks/")) {
      const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
      const body = await readBody(req);
      const tasks = await updateTask(db, id, {
        name: body.name === undefined ? undefined : String(body.name),
        type: body.type === undefined ? undefined : String(body.type),
        time: body.time === undefined ? undefined : String(body.time),
        market: body.market === undefined ? undefined : String(body.market),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/tasks/")) {
      const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
      const tasks = await deleteTask(db, id);
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/tasks/") && pathname.endsWith("/run")) {
      const id = decodeURIComponent(pathname.slice("/api/tasks/".length, -"/run".length));
      const tasks = await runTask(db, id);
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (method === "GET" && pathname === "/api/settings") {
      sendJson(res, 200, {
        ok: true,
        runtime: getAppSettings(db),
        advice: getAdviceSettings(db),
        notify: publicNotify(getNotifySettings(db)),
      });
      return;
    }

    if (method === "PUT" && pathname === "/api/settings/runtime") {
      const body = await readBody(req);
      const runtime = setAppSettings(db, normalizeRuntime(body));
      sendJson(res, 200, { ok: true, runtime });
      return;
    }

    if (method === "PUT" && pathname === "/api/settings/advice") {
      const body = await readBody(req);
      const advice = setAdviceSettings(db, normalizeAdvice(body));
      sendJson(res, 200, { ok: true, advice });
      return;
    }

    if (method === "PUT" && pathname === "/api/settings/notify") {
      const body = await readBody(req);
      const notify = setNotifySettings(db, normalizeNotify(body));
      sendJson(res, 200, { ok: true, notify: publicNotify(notify) });
      return;
    }

    sendJson(res, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    sendJson(res, status, { ok: false, error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`fund admin api: http://${host}:${port}`);
  console.log(`db: ${dbPath}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
