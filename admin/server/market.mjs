import { getProductsByKeys, listWatchlist } from "./db.mjs";

const EASTMONEY_UT = "bd1d9ddb04089700cf9c27f6f7426281";
const KLINE_PERIODS = {
  day: { klt: 101, limit: 120 },
  week: { klt: 102, limit: 104 },
  month: { klt: 103, limit: 60 },
};

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

function buildWatchlist(db) {
  const exchange = [];
  const otc = [];

  for (const fund of listWatchlist(db, "exchange")) {
    if (!fund.enabled) continue;
    exchange.push({
      key: `exchange:${fund.code}`,
      code: fund.code,
      name: fund.name || fund.code,
      kind: "etf",
      group: "exchange",
      groups: ["exchange"],
      secid: secidFor(fund.code),
    });
  }

  for (const fund of listWatchlist(db, "otc")) {
    if (!fund.enabled) continue;
    otc.push({
      key: `otc:${fund.code}`,
      code: fund.code,
      name: fund.name || fund.code,
      market: "otc",
      kind: "otc",
      group: "otc",
      groups: ["otc"],
    });
  }

  return { exchange, otc };
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
  const candleCache = new Map();
  const navCache = new Map();
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
      const { exchange, otc } = buildWatchlist(db);
      let quotes = [];
      let error = null;
      if (exchange.length > 0) {
        try {
          quotes = await fetchEastmoneyQuotes(exchange);
        } catch (firstError) {
          try {
            quotes = await fetchTencentQuotes(exchange);
          } catch (secondError) {
            error = `${firstError.message}; ${secondError.message}`;
          }
        }
      }

      let otcQuotes = [];
      if (otc.length > 0) {
        const navResult = await navs(otc.map((fund) => fund.key));
        const navMap = new Map((navResult.navs ?? []).map((nav) => [nav.code, nav]));
        otcQuotes = otc.map((fund) => {
          const nav = navMap.get(fund.code);
          return {
            ...fund,
            id: fund.key,
            price: nav?.nav ?? null,
            prevClose: null,
            open: null,
            high: null,
            low: null,
            change: null,
            changePct: nav?.changePct ?? null,
            volume: null,
            amount: null,
            decimals: 4,
            navDate: nav?.navDate ?? null,
            at: nav ? new Date().toISOString() : null,
            source: nav?.source ?? null,
          };
        });
      }

      const merged = [...quotes, ...otcQuotes];
      cache = {
        ok: merged.length > 0,
        at: new Date().toISOString(),
        session: sessionStatus(),
        quotes: merged.length ? merged : cache.quotes,
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

  async function quotes(items) {
    const keys = [...new Set(items ?? [])].slice(0, 50);
    const products = getProductsByKeys(db, keys);
    const symbols = [];
    const placeholders = [];
    for (const key of keys) {
      const product = products.get(key);
      if (!product) continue;
      if (product.market === "otc") {
        placeholders.push({
          id: key,
          key,
          code: product.code,
          name: product.name,
          market: "otc",
          type: "otc",
          price: null,
          prevClose: null,
          open: null,
          high: null,
          low: null,
          change: null,
          changePct: null,
          volume: null,
          amount: null,
          decimals: 3,
          at: null,
          source: "none",
        });
        continue;
      }
      symbols.push({
        id: key,
        key,
        code: product.code,
        name: product.name,
        kind: product.type === "index" ? "index" : "etf",
        group: product.market,
        type: product.type,
        secid: secidFor(product.code),
      });
    }
    if (symbols.length === 0) {
      return { quotes: placeholders, at: new Date().toISOString(), source: null, error: null };
    }

    let result = [];
    let error = null;
    try {
      result = await fetchEastmoneyQuotes(symbols);
    } catch (firstError) {
      try {
        result = await fetchTencentQuotes(symbols);
      } catch (secondError) {
        error = `${firstError.message}; ${secondError.message}`;
      }
    }
    return {
      quotes: [...result, ...placeholders],
      at: new Date().toISOString(),
      source: result[0]?.source ?? null,
      error,
    };
  }

  async function navs(items) {
    const keys = [...new Set(items ?? [])].slice(0, 50);
    const products = getProductsByKeys(db, keys);
    const result = [];

    await Promise.all(
      keys.map(async (key) => {
        const product = products.get(key);
        if (!product || product.market !== "otc") return;
        const cached = navCache.get(key);
        if (cached && Date.now() - cached.cachedAt < 10 * 60 * 1000) {
          result.push(cached.data);
          return;
        }
        try {
          const url =
            `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(product.code)}` +
            "&pageIndex=1&pageSize=1&startDate=&endDate=";
          const response = await fetch(url, {
            headers: { Referer: "https://fundf10.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) return;
          const payload = await response.json();
          const row = payload?.Data?.LSJZList?.[0];
          if (!row) return;
          const data = {
            id: key,
            key,
            code: product.code,
            name: product.name,
            nav: Number(row.DWJZ),
            navDate: row.FSRQ,
            changePct: row.JZZZL === "" || row.JZZZL === undefined ? null : Number(row.JZZZL),
            source: "eastmoney-lsjz",
          };
          navCache.set(key, { cachedAt: Date.now(), data });
          result.push(data);
        } catch {
          // 单只基金净值失败不影响整页
        }
      }),
    );

    return { navs: result, at: new Date().toISOString() };
  }

  async function candles(code, period = "day") {
    const clean = String(code ?? "").trim();
    if (!/^[0-9A-Za-z.]{4,12}$/.test(clean)) throw new Error("基金代码格式不正确");
    const normalized = period === "daily" ? "day" : period;
    const config = KLINE_PERIODS[normalized];
    if (!config) throw new Error("period 只能是 day、week 或 month");
    const cacheKey = `${clean}:${normalized}`;
    const cached = candleCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 60000) return cached.data;

    const secid = secidFor(clean);
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
      "&fields1=f1,f2,f3,f4,f5,f6" +
      "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
      `&klt=${config.klt}&fqt=1&beg=0&end=20500101&lmt=${config.limit}&ut=${EASTMONEY_UT}`;
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`eastmoney kline HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload?.data;
    if (!data || !Array.isArray(data.klines) || data.klines.length === 0) {
      throw new Error("没有历史数据");
    }
    const rows = data.klines
      .map((row) => {
        const [date, open, close, high, low, volume, amount, amplitude, changePct, change, turnover] =
          row.split(",");
        const price = Number(close);
        if (!Number.isFinite(price)) return null;
        return {
          date,
          open: Number(open),
          close: price,
          high: Number(high),
          low: Number(low),
          volume: Number(volume),
          amount: Number(amount),
          amplitude: Number(amplitude),
          changePct: Number(changePct),
          change: Number(change),
          turnover: Number(turnover),
        };
      })
      .filter(Boolean)
      .slice(-config.limit);
    const result = {
      code: data.code || clean,
      name: data.name || clean,
      period: normalized,
      decimals: Number(data.decimal) || (clean.startsWith("399") || clean === "000001" ? 2 : 3),
      candles: rows,
      at: new Date().toISOString(),
      source: "eastmoney",
    };
    candleCache.set(cacheKey, { cachedAt: Date.now(), data: result });
    return result;
  }

  return { update, snapshot, subscribe, trend, candles, quotes, navs };
}
