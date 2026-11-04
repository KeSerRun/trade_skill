import path from "node:path";
import { CACHE_DIR, loadConfig } from "./config.mjs";
import { request, requestJson } from "./http.mjs";
import { fileAgeMs, readJson, writeJson, ensureDir } from "./store.mjs";

const EASTMONEY_REFERER = "https://fund.eastmoney.com/";

function cachePath(name) {
  return path.join(CACHE_DIR, name);
}

function cached(name, maxAgeSeconds) {
  const file = cachePath(name);
  if (fileAgeMs(file) > maxAgeSeconds * 1000) return null;
  return readJson(file, null);
}

function saveCache(name, data) {
  ensureDir(CACHE_DIR);
  writeJson(cachePath(name), data);
  return data;
}

export async function loadFundList(options = {}) {
  const { force = false } = options;
  const ttl = loadConfig().data.fundListCacheSeconds;
  if (!force) {
    const hit = cached("fund-list.json", ttl);
    if (hit) return hit;
  }
  const text = await request("https://fund.eastmoney.com/js/fundcode_search.js", {
    headers: { Referer: EASTMONEY_REFERER },
  });
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("基金列表解析失败");
  const list = JSON.parse(match[0]).map(([code, abbr, name, type, pinyin]) => ({
    code,
    abbr,
    name,
    type,
    pinyin,
  }));
  saveCache("fund-list.json", list);
  return list;
}

export async function searchFunds(keyword, limit = 10) {
  const list = await loadFundList();
  const key = String(keyword).trim().toLowerCase();
  if (!key) return [];
  const scored = [];
  for (const fund of list) {
    const code = fund.code.toLowerCase();
    const name = fund.name.toLowerCase();
    const pinyin = (fund.pinyin || "").toLowerCase();
    let score = -1;
    if (code === key) score = 100;
    else if (code.startsWith(key)) score = 90;
    else if (name === key) score = 85;
    else if (name.includes(key)) score = 70 - name.indexOf(key);
    else if (pinyin.includes(key)) score = 50 - pinyin.indexOf(key);
    else if (fund.abbr && fund.abbr.toLowerCase().includes(key)) score = 40;
    if (score >= 0) scored.push({ score, fund });
  }
  scored.sort((a, b) => b.score - a.score || a.fund.code.localeCompare(b.fund.code));
  return scored.slice(0, limit).map((item) => item.fund);
}

export async function fundName(code) {
  try {
    const list = await loadFundList();
    return list.find((fund) => fund.code === code)?.name ?? null;
  } catch {
    return null;
  }
}

function exchangeSecid(code) {
  return `${/^[56]/.test(code) ? 1 : 0}.${code}`;
}

export async function quoteExchange(code) {
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${exchangeSecid(code)}` +
    "&fields=f43,f57,f58,f59,f60,f169,f170,f86";
  const payload = await requestJson(url, { headers: { Referer: "https://quote.eastmoney.com/" } });
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
    source: "eastmoney-push2",
  };
}

export async function quoteOtc(code) {
  const text = await request(`https://qt.gtimg.cn/q=jj${code}`, {
    encoding: "gbk",
    headers: { Referer: "https://gu.qq.com/" },
  });
  const match = text.match(/="([^"]*)"/);
  if (!match || !match[1]) return null;
  const fields = match[1].split("~");
  const nav = Number(fields[5]);
  if (!nav) return null;
  return {
    code,
    name: fields[1] || null,
    market: "otc",
    nav,
    accNav: Number(fields[6]) || null,
    changePct: fields[7] === undefined || fields[7] === "" ? null : Number(fields[7]) / 100,
    date: fields[8] || null,
    source: "tencent",
  };
}

async function quoteOtcSina(code) {
  const text = await request(`https://hq.sinajs.cn/list=f_${code}`, {
    encoding: "gbk",
    headers: { Referer: "https://finance.sina.com.cn" },
  });
  const match = text.match(/="([^"]*)"/);
  if (!match || !match[1]) return null;
  const fields = match[1].split(",");
  const nav = Number(fields[1]);
  if (!nav) return null;
  return {
    code,
    name: fields[0] || null,
    market: "otc",
    nav,
    accNav: Number(fields[2]) || null,
    prevNav: Number(fields[3]) || null,
    date: fields[4] || null,
    changePct: fields[3] ? (nav - Number(fields[3])) / Number(fields[3]) : null,
    source: "sina",
  };
}

export async function quoteFund(code, options = {}) {
  const { prefer = "nav" } = options;
  const ttl = loadConfig().data.quoteCacheSeconds;
  const cacheName = `quote-${prefer}-${code}.json`;
  if (!options.noCache) {
    const hit = cached(cacheName, ttl);
    if (hit) return { ...hit, cached: true };
  }

  const tryOtc = async () => {
    try {
      const quote = await quoteOtc(code);
      if (quote) return quote;
    } catch {
      // fall through
    }
    try {
      return await quoteOtcSina(code);
    } catch {
      return null;
    }
  };

  const tryExchange = async () => {
    try {
      return await quoteExchange(code);
    } catch {
      return null;
    }
  };

  let result = null;
  if (prefer === "exchange") {
    result = (await tryExchange()) ?? (await tryOtc());
  } else {
    result = (await tryOtc()) ?? (await tryExchange());
  }

  if (!result) {
    const history = await navHistory(code, { pages: 1, pageSize: 1, noCache: true }).catch(() => []);
    if (history.length > 0) {
      result = {
        code,
        name: await fundName(code),
        market: "otc",
        nav: history[0].nav,
        accNav: history[0].accNav,
        changePct: history[0].changePct,
        date: history[0].date,
        source: "eastmoney-lsjz",
      };
    }
  }

  if (!result) throw new Error(`未获取到基金 ${code} 的行情，请检查代码是否正确`);
  if (!result.name) result.name = await fundName(code);
  return saveCache(cacheName, result);
}

export async function navHistory(code, options = {}) {
  const { pages = 1, pageSize = 20, noCache = false } = options;
  const ttl = loadConfig().data.historyCacheSeconds;
  const cacheName = `nav-${code}-${pages}-${pageSize}.json`;
  if (!noCache) {
    const hit = cached(cacheName, ttl);
    if (hit) return hit;
  }

  const rows = [];
  for (let page = 1; page <= pages; page++) {
    const url =
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
      `&pageIndex=${page}&pageSize=${pageSize}`;
    const payload = await requestJson(url, {
      headers: { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` },
    });
    const list = payload?.Data?.LSJZList ?? [];
    if (list.length === 0) break;
    for (const item of list) {
      rows.push({
        date: item.FSRQ,
        nav: Number(item.DWJZ),
        accNav: Number(item.LJJZ),
        changePct: item.JZZZL === "" ? null : Number(item.JZZZL) / 100,
      });
    }
    if (list.length < pageSize) break;
  }
  if (rows.length === 0) throw new Error(`未获取到基金 ${code} 的历史净值`);
  return saveCache(cacheName, rows);
}

export async function latestNav(code) {
  const quote = await quoteFund(code);
  if (quote.market === "exchange") {
    return { code, name: quote.name, nav: quote.price, date: quote.time?.slice(0, 10) ?? null, market: "exchange", changePct: quote.changePct };
  }
  return { code, name: quote.name, nav: quote.nav, date: quote.date, market: "otc", changePct: quote.changePct };
}
