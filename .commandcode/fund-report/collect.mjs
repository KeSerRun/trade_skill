#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppSettings, loadMarketMode, loadWatchlist } from "../skills/fund-trading/scripts/lib/sqlite.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const scriptsDir = path.join(root, ".commandcode", "skills", "fund-trading", "scripts");
const stateDir = process.env.FUND_TRADE_HOME
  ? path.resolve(process.env.FUND_TRADE_HOME)
  : path.join(root, ".fund-trading");
const collectDir = path.join(stateDir, "collect");
const closeMode = process.argv.includes("--close");

function call(script, args) {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = (result.stdout || "").trim();
  const start = stdout.indexOf("{");
  if (start >= 0) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      // fall through to error object
    }
  }
  const detail = (result.stderr || stdout || "no output").trim().slice(0, 400);
  return { ok: false, error: detail };
}

function ret(rows, days) {
  if (!rows || rows.length <= days) return null;
  return rows[0].nav / rows[days].nav - 1;
}

function maxDrawdown(rows, days) {
  if (!rows || rows.length === 0) return null;
  const slice = rows.slice(0, days + 1);
  let peak = -Infinity;
  let worst = 0;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    peak = Math.max(peak, slice[i].nav);
    worst = Math.min(worst, slice[i].nav / peak - 1);
  }
  return worst;
}

function fromHigh(rows, days) {
  if (!rows || rows.length === 0) return null;
  const slice = rows.slice(0, days + 1);
  const high = Math.max(...slice.map((row) => row.nav));
  return high > 0 ? rows[0].nav / high - 1 : null;
}

function isExchange(code) {
  return /^(5\d{5}|1(59|6\d)\d{3}|588\d{3})$/.test(code);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeWatchlist(entry) {
  if (typeof entry === "string") return { code: entry };
  return entry ?? {};
}

async function fetchExchangeQuote(code) {
  const secid = `${/^[56]/.test(code) ? 1 : 0}.${code}`;
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}` +
    "&fields=f43,f57,f58,f59,f60,f169,f170,f86";
  const response = await fetch(url, {
    headers: { Referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const data = payload?.data;
  if (!data || data.f43 === "-" || data.f43 === undefined) return null;
  const scale = 10 ** (data.f59 ?? 3);
  return {
    code,
    name: data.f58 ?? null,
    market: "exchange",
    price: data.f43 / scale,
    prevClose: data.f60 === "-" ? null : data.f60 / scale,
    changePct: data.f170 === "-" ? null : data.f170 / 10000,
    time: data.f86 ? new Date(data.f86 * 1000).toISOString() : null,
    source: "eastmoney-push2-direct",
  };
}

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const offline = process.argv.includes("--offline");
  const closeMode = process.argv.includes("--close");
  const settings = loadAppSettings();
  fs.mkdirSync(collectDir, { recursive: true });

  const errors = [];
  const account = call("paper.mjs", ["status", ...(offline ? ["--offline"] : [])]);
  if (!account.ok) errors.push(`account: ${account.error}`);

  const held = account.ok ? (account.holdings ?? []).map((h) => h.code) : [];
  const marketMode = loadMarketMode();
  const dbWatchlist = loadWatchlist(marketMode);
  const configured = dbWatchlist.map(normalizeWatchlist);
  const byCode = new Map();
  for (const item of configured) byCode.set(item.code, item);
  for (const code of held) if (!byCode.has(code)) byCode.set(code, { code });
  const watchlist = [...byCode.values()];

  const funds = [];
  for (const item of watchlist) {
    const quote = call("fund.mjs", ["quote", item.code, ...(isExchange(item.code) ? ["--exchange"] : [])]);
    const history = call("fund.mjs", ["nav", item.code, "--pages", "8", "--page-size", "20"]);
    const rows = history.ok ? history.rows ?? [] : [];
    const queries = item.queries?.length
      ? item.queries.slice(0, settings.queriesPerFund)
      : (call("news.mjs", ["queries", item.code]).queries ?? []).slice(0, settings.queriesPerFund);
    if (!history.ok) errors.push(`${item.code}: ${history.error}`);

    const officialToday = closeMode && rows[0]?.date === date;
    let benchmark = null;
    let estimatedNav = null;
    let estimatedChangePct = null;
    let estimate = false;
    let estimateNote = null;
    if (closeMode) {
      if (quote.ok && quote.market === "exchange") {
        estimatedNav = quote.price;
        estimatedChangePct = quote.changePct ?? null;
      } else if (officialToday) {
        estimatedNav = quote.ok ? quote.nav ?? rows[0].nav : rows[0].nav;
        estimatedChangePct = rows[0].changePct ?? null;
      } else if (item.benchmark) {
        benchmark = item.benchmark;
        let bench = null;
        try {
          bench = await fetchExchangeQuote(item.benchmark);
        } catch {
          bench = null;
        }
        if (!bench) {
          const fallback = call("fund.mjs", ["quote", item.benchmark, "--exchange"]);
          if (fallback.ok && fallback.market === "exchange") bench = fallback;
        }
        const benchDate = bench?.time?.slice(0, 10) ?? null;
        if (bench && bench.changePct !== null && bench.changePct !== undefined && benchDate === date) {
          estimatedChangePct = bench.changePct;
          const base = quote.ok ? (quote.market === "exchange" ? quote.price : quote.nav) : rows[0]?.nav ?? null;
          if (base) {
            estimatedNav = base * (1 + estimatedChangePct);
            estimate = true;
          }
        } else {
          estimateNote = "对应 ETF 今日收盘行情未更新";
        }
      }
    }

    funds.push({
      code: item.code,
      name: quote.ok ? quote.name ?? item.name ?? null : item.name ?? null,
      sector: item.sector ?? null,
      market: quote.ok ? quote.market ?? null : null,
      price: quote.ok ? (quote.market === "exchange" ? quote.price : quote.nav) ?? null : null,
      prevClose: quote.ok ? quote.prevClose ?? null : null,
      changePct: quote.ok ? quote.changePct ?? null : null,
      priceDate: quote.ok ? quote.date ?? quote.time?.slice(0, 10) ?? null : null,
      lastNavDate: rows[0]?.date ?? null,
      benchmark,
      estimatedNav,
      estimatedChangePct,
      estimate,
      estimateNote,
      d5: ret(rows, 5),
      d20: ret(rows, 20),
      d60: ret(rows, 60),
      maxDrawdown60: maxDrawdown(rows, 60),
      fromHigh60: fromHigh(rows, 60),
      inWatchlist: true,
      queries,
      historyError: history.ok ? null : history.error,
    });
  }

  if (account.ok && Array.isArray(account.holdings)) {
    const navDates = new Map(funds.map((fund) => [fund.code, fund.lastNavDate]));
    for (const holding of account.holdings) {
      const navDate = navDates.get(holding.code);
      if (navDate) holding.lastNavDate = navDate;
    }
  }

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    date,
    marketMode,
    weekday: new Date().toLocaleDateString("zh-CN", { weekday: "long" }),
    account: account.ok ? account : { ok: false, error: account.error },
    alerts: call("risk.mjs", ["alerts"]),
    exposure: call("risk.mjs", ["exposure"]),
    drawdown: call("risk.mjs", ["drawdown"]),
    pendingOrders: call("order.mjs", ["list", "--status", "pending"]),
    watchlist: funds,
    errors,
  };

  if (closeMode) {
    const cash = account.ok ? account.cash ?? 0 : 0;
    const closeHoldings = (account.ok && Array.isArray(account.holdings) ? account.holdings : []).map((holding) => {
      const fund = funds.find((item) => item.code === holding.code);
      const isExchange = holding.market === "exchange";
      const isNewToday = holding.firstBuyDate === date;
      const prevNav = isExchange
        ? isNewToday
          ? holding.avgCost ?? holding.lastNav ?? 0
          : fund?.prevClose ?? holding.lastNav ?? holding.avgCost ?? 0
        : holding.lastNav ?? holding.avgCost ?? 0;
      let nav = prevNav;
      let estimated = false;
      let source = "按最近净值";
      if (isExchange) {
        nav = fund?.price ?? holding.lastNav ?? prevNav;
        source = "收盘价";
      } else if (fund?.estimatedNav) {
        nav = fund.estimatedNav;
        estimated = fund.estimate === true;
        source = fund.estimate ? `按 ${fund.benchmark} 收盘估算` : "官方净值";
      } else if (fund?.estimateNote) {
        source = fund.estimateNote;
      }
      if (!isExchange && isNewToday) {
        nav = prevNav;
        estimated = false;
        source = "今日新买入，待 15:00 净值确认，当日盈亏暂不计入";
      }
      const value = holding.shares * nav;
      const dayPnl = isExchange
        ? holding.shares * (nav - prevNav)
        : isNewToday
          ? 0
          : holding.shares * (nav - prevNav);
      return {
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        cost: holding.cost,
        prevNav,
        prevNavDate: holding.lastNavDate,
        nav: round(nav, 4),
        changePct: prevNav > 0 ? nav / prevNav - 1 : 0,
        value: round(value, 2),
        pnl: round(value - holding.cost, 2),
        pnlPct: holding.cost > 0 ? (value - holding.cost) / holding.cost : 0,
        dayPnl: round(dayPnl, 2),
        estimated,
        pending: !isExchange && isNewToday,
        source,
      };
    });
    const positionEstimate = closeHoldings.reduce((sum, item) => sum + item.value, 0);
    const dayPnl = closeHoldings.reduce((sum, item) => sum + item.dayPnl, 0);
    const equityEstimate = cash + positionEstimate;
    const prevEquity = equityEstimate - dayPnl;
    payload.close = {
      cash: round(cash, 2),
      equity: round(equityEstimate, 2),
      positionValue: round(positionEstimate, 2),
      dayPnl: round(dayPnl, 2),
      dayPnlPct: prevEquity > 0 ? dayPnl / prevEquity : 0,
      estimatedAny: closeHoldings.some((item) => item.estimated),
      pendingAny: closeHoldings.some((item) => item.pending),
      holdings: closeHoldings,
    };
  }

  const target = path.join(collectDir, `${date}.json`);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
  const okCount = funds.filter((f) => f.d5 !== null).length;
  console.log(JSON.stringify({ ok: true, file: target, funds: funds.length, withHistory: okCount, errors }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exit(1);
});
