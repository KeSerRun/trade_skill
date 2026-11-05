import { listWatchlist } from "./db.mjs";

const EASTMONEY_UT = "bd1d9ddb04089700cf9c27f6f7426281";
const INDICES = [
  { code: "000001", name: "上证指数", kind: "index", group: "index", secid: "1.000001" },
  { code: "399001", name: "深证成指", kind: "index", group: "index", secid: "0.399001" },
  { code: "399006", name: "创业板指", kind: "index", group: "index", secid: "0.399006" },
];

const HEADERS = {
  Referer: "https://quote.eastmoney.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

function secidFor(code) {
  if (code === "000001") return "1.000001";
  if (code.startsWith("399")) return `0.${code}`;
  return `${/^[56]/.test(code) ? 1 : 0}.${code}`;
}

function decimalsFor(kind, value) {
  const decimals = Number(value);
  if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 4) return decimals;
  return kind === "index" ? 2 : 3;
}

function numberOrNull(value, scale = 1) {
  if (value === null || value === undefined || value === "-" || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number / scale : null;
}

export function sessionStatus(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return "closed";
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes >= 9 * 60 + 15 && minutes < 9 * 60 + 30) return "preopen";
  if ((minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60)) {
    return "trading";
  }
  if (minutes > 11 * 60 + 30 && minutes < 13 * 60) return "lunch";
  return "closed";
}

function addSymbol(map, item) {
  const existing = map.get(item.code);
  if (!existing) {
    map.set(item.code, { ...item, groups: [item.group], related: item.related ? [item.related] : [] });
    return;
  }
  if (!existing.groups.includes(item.group)) existing.groups.push(item.group);
  if (item.related && !existing.related.includes(item.related)) existing.related.push(item.related);
}

function buildSymbols(db) {
  const map = new Map();
  for (const item of INDICES) addSymbol(map, { ...item });

  for (const fund of listWatchlist(db, "exchange")) {
    if (!fund.enabled) continue;
    addSymbol(map, {
      code: fund.code,
      name: fund.name || fund.code,
      kind: "etf",
      group: "exchange",
      secid: secidFor(fund.code),
      fundCode: fund.code,
      related: `${fund.code} ${fund.name || ""}`.trim(),
    });
  }

  for (const fund of listWatchlist(db, "otc")) {
    if (!fund.enabled || !fund.benchmark) continue;
    addSymbol(map, {
      code: fund.benchmark,
      name: fund.name || fund.benchmark,
      kind: "etf",
      group: "otc",
      secid: secidFor(fund.benchmark),
      fundCode: fund.code,
      related: `${fund.code} ${fund.name || ""}`.trim(),
    });
  }

  return [...map.values()];
}

async function fetchEastmoneyQuotes(symbols) {
  const secids = symbols.map((symbol) => symbol.secid).join(",");
  const fields = "f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124";
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${encodeURIComponent(secids)}` +
    `&fields=${fields}&ut=${EASTMONEY_UT}`;
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`eastmoney HTTP ${response.status}`);
  const payload = await response.json();
  const rows = payload?.data?.diff;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("eastmoney empty quote");

  const byCode = new Map(rows.map((row) => [String(row.f12), row]));
  return symbols
    .map((symbol) => {
      const row = byCode.get(symbol.code);
      if (!row) return null;
      const decimals = decimalsFor(symbol.kind, row.f1);
      const scale = 10 ** decimals;
      const price = numberOrNull(row.f2, scale);
      if (price === null) return null;
      return {
        ...symbol,
        name: row.f14 || symbol.name,
        price,
        prevClose: numberOrNull(row.f18, scale),
        open: numberOrNull(row.f17, scale),
        high: numberOrNull(row.f15, scale),
        low: numberOrNull(row.f16, scale),
        change: numberOrNull(row.f4, scale),
        changePct: numberOrNull(row.f3, 100),
        volume: numberOrNull(row.f5),
        amount: numberOrNull(row.f6),
        decimals,
        at: row.f124 ? new Date(row.f124 * 1000).toISOString() : new Date().toISOString(),
        source: "eastmoney",
      };
    })
    .filter(Boolean);
}

async function fetchTencentQuotes(symbols) {
  const names = symbols.map((symbol) => `${symbol.secid.startsWith("1.") ? "sh" : "sz"}${symbol.code}`);
  const response = await fetch(`https://qt.gtimg.cn/q=${names.join(",")}`, {
    headers: { Referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`tencent HTTP ${response.status}`);
  const text = new TextDecoder("gbk").decode(Buffer.from(await response.arrayBuffer()));
  const rows = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/v_\w+="([^"]*)"/);
    if (!match) continue;
    const fields = match[1].split("~");
    if (fields.length < 35) continue;
    rows.set(fields[2], fields);
  }

  return symbols
    .map((symbol) => {
      const fields = rows.get(symbol.code);
      if (!fields) return null;
      const price = Number(fields[3]);
      if (!Number.isFinite(price)) return null;
      const decimals = decimalsFor(symbol.kind, symbol.kind === "index" ? 2 : 3);
      return {
        ...symbol,
        name: fields[1] || symbol.name,
        price,
        prevClose: numberOrNull(fields[4]),
        open: numberOrNull(fields[5]),
        high: numberOrNull(fields[33]),
        low: numberOrNull(fields[34]),
        change: numberOrNull(fields[31]),
        changePct: numberOrNull(fields[32]),
        volume: numberOrNull(fields[6]),
        amount: numberOrNull(fields[37]) === null ? null : numberOrNull(fields[37]) * 10000,
        decimals,
        at: fields[30] ? fields[30] : new Date().toISOString(),
        source: "tencent",
      };
    })
    .filter(Boolean);
}

export function createMarket(db) {
  const subscribers = new Set();
  const trendCache = new Map();
  let cache = {
    ok: true,
    at: null,
    session: sessionStatus(),
    quotes: [],
    error: null,
  };
  let inFlight = null;
  let timer = null;

  async function update() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const symbols = buildSymbols(db);
      let quotes = [];
      let error = null;
      try {
        quotes = await fetchEastmoneyQuotes(symbols);
      } catch (firstError) {
        try {
          quotes = await fetchTencentQuotes(symbols);
        } catch (secondError) {
          error = `${firstError.message}; ${secondError.message}`;
        }
      }
      cache = {
        ok: quotes.length > 0,
        at: new Date().toISOString(),
        session: sessionStatus(),
        quotes: quotes.length ? quotes : cache.quotes,
        error,
      };
      for (const subscriber of subscribers) {
        try {
          subscriber(cache);
        } catch {
          subscribers.delete(subscriber);
        }
      }
      return cache;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function ensureLoop() {
    if (timer || subscribers.size === 0) return;
    const tick = async () => {
      await update();
      if (subscribers.size === 0) {
        timer = null;
        return;
      }
      timer = setTimeout(tick, sessionStatus() === "trading" ? 3000 : 15000);
    };
    tick();
  }

  async function snapshot() {
    const age = cache.at ? Date.now() - Date.parse(cache.at) : Infinity;
    if (age > 2500) await update();
    return cache;
  }

  function subscribe(callback) {
    subscribers.add(callback);
    callback(cache);
    if (!cache.at) update();
    ensureLoop();
    return () => {
      subscribers.delete(callback);
      if (subscribers.size === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  async function trend(code) {
    const clean = String(code ?? "").trim();
    if (!/^[0-9A-Za-z.]{4,12}$/.test(clean)) throw new Error("基金代码格式不正确");
    const cached = trendCache.get(clean);
    if (cached && Date.now() - cached.cachedAt < 15000) return cached.data;

    const secid = secidFor(clean);
    const fields1 = "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13";
    const fields2 = "f51,f52,f53,f54,f55,f56,f57,f58";
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
      `&fields1=${fields1}&fields2=${fields2}&iscr=0&ndays=1&ut=${EASTMONEY_UT}`;
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`eastmoney trend HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload?.data;
    if (!data || !Array.isArray(data.trends) || data.trends.length === 0) {
      throw new Error("没有分时数据");
    }
    const points = data.trends
      .map((row) => {
        const [time, open, close, high, low, volume, amount, avg] = row.split(",");
        const price = Number(close);
        if (!Number.isFinite(price)) return null;
        return {
          time: time.slice(11),
          open: Number(open),
          high: Number(high),
          low: Number(low),
          price,
          avg: Number(avg),
          volume: Number(volume),
          amount: Number(amount),
        };
      })
      .filter(Boolean);
    const result = {
      code: data.code || clean,
      name: data.name || clean,
      preClose: Number(data.preClose) || points[0]?.price || null,
      decimals: Number(data.decimal) || (clean.startsWith("399") || clean === "000001" ? 2 : 3),
      points,
      at: data.time ? new Date(data.time * 1000).toISOString() : new Date().toISOString(),
      source: "eastmoney",
    };
    trendCache.set(clean, { cachedAt: Date.now(), data: result });
    return result;
  }

  return { update, snapshot, subscribe, trend };
}
