import { tx } from "./db.mjs";

const FUND_LIST_URL = "https://fund.eastmoney.com/js/fundcode_search.js";

function marketFor(code, name) {
  if (code.startsWith("16")) return "exchange";
  if (code.startsWith("15") && /ETF|LOF/.test(name)) return "exchange";
  if (/^(50|51|52|56|58)/.test(code) && /ETF|LOF/.test(name) && !/联接/.test(name)) {
    return "exchange";
  }
  return "otc";
}

function typeFor(market, name) {
  if (market !== "exchange") return "otc";
  if (/ETF/.test(name) && !/联接/.test(name)) return "etf";
  if (/LOF/.test(name)) return "lof";
  return "exchange";
}

export async function syncProducts(db) {
  const response = await fetch(FUND_LIST_URL, {
    headers: {
      Referer: "https://fund.eastmoney.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`基金列表 HTTP ${response.status}`);
  const text = await response.text();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("基金列表格式异常");
  const rows = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error("基金列表为空或过短");

  const updatedAt = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO products (market, code, name, category, type, benchmark, sector, status, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active', ?)
     ON CONFLICT(market, code) DO UPDATE SET
       name = excluded.name, category = excluded.category, type = excluded.type,
       status = 'active', updated_at = excluded.updated_at`,
  );

  let changed = 0;
  tx(db, () => {
    db.prepare("UPDATE products SET status = 'stale' WHERE market != 'index'").run();
    for (const row of rows) {
      const [code, , name, category] = row;
      if (!/^\d{6}$/.test(code) || !name) continue;
      const market = marketFor(code, name);
      upsert.run(market, code, name, category ?? null, typeFor(market, name), updatedAt);
      changed += 1;
    }
  });

  const counts = { all: 0, index: 0, exchange: 0, otc: 0 };
  for (const row of db.prepare("SELECT market, COUNT(*) AS n FROM products WHERE status = 'active' GROUP BY market").all()) {
    if (counts[row.market] !== undefined) counts[row.market] = row.n;
    counts.all += row.n;
  }
  return { changed, ...counts };
}
