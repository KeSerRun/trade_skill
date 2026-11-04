import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deletePosition,
  getRules,
  listTrades,
  openDb,
  setAccount,
  setRules,
  stateSummary,
  upsertPosition,
} from "./db.mjs";
import { TASKS, listTasks, runTask, updateTask } from "./tasks.mjs";

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
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const db = openDb(dbPath);

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
      sendJson(res, 200, { ok: true, tasks: await listTasks() });
      return;
    }

    if (method === "PUT" && pathname.startsWith("/api/tasks/")) {
      const name = decodeURIComponent(pathname.slice("/api/tasks/".length));
      if (!TASKS[name]) throw new HttpError(404, "未知任务");
      const body = await readBody(req);
      const tasks = await updateTask(name, {
        time: body.time === undefined ? undefined : String(body.time),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      sendJson(res, 200, { ok: true, tasks });
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/tasks/") && pathname.endsWith("/run")) {
      const name = decodeURIComponent(pathname.slice("/api/tasks/".length, -"/run".length));
      if (!TASKS[name]) throw new HttpError(404, "未知任务");
      const tasks = await runTask(name);
      sendJson(res, 200, { ok: true, tasks });
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
