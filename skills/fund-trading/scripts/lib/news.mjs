import path from "node:path";
import { CACHE_DIR, loadConfig } from "./config.mjs";
import { request } from "./http.mjs";
import { ensureDir, fileAgeMs, readJson, round, writeJson } from "./store.mjs";
import { loadVerdictFromDb, saveVerdictToDb } from "./sqlite.mjs";
import { fundName } from "./data.mjs";

const PROFILE_TTL_SECONDS = 6 * 3600;
const REFERER = "https://fundf10.eastmoney.com/";

const RISK_HIGH = [
  "清盘", "终止", "暂停申购", "暂停赎回", "暂停大额申购", "巨额赎回", "立案",
  "处罚", "违规", "造假", "违约", "爆雷", "踩雷", "退市", "离任", "诉讼", "冻结",
];
const RISK_MED = [
  "调查", "变更", "警示", "风险提示", "下跌", "大跌", "暴跌", "亏损", "回撤",
  "减持", "下调", "业绩不佳", "跑输", "规模缩水", "迷你基金", "清盘风险",
];
const HOT_HIGH = [
  "创新高", "大涨", "涨停", "净流入", "获批", "超预期", "政策支持", "利好",
];
const HOT_MED = [
  "上涨", "反弹", "回暖", "走强", "增长", "突破", "龙头", "景气", "热门",
  "增持", "分红", "修复", "加仓", "重仓", "风口",
];

export const KEYWORDS = { RISK_HIGH, RISK_MED, HOT_HIGH, HOT_MED };

function pad(n) {
  return String(n).padStart(2, "0");
}

function text(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function daysBetween(fromDate, toDate = new Date()) {
  const from = new Date(`${fromDate}T00:00:00`);
  if (Number.isNaN(from.getTime())) return null;
  return Math.max(0, Math.floor((toDate.getTime() - from.getTime()) / 86400000));
}

function parseSize(textValue, unit) {
  const value = Number(String(textValue).replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const yi = unit === "万元" ? value / 10000 : value;
  return { yi: round(yi, 2), display: `${value}${unit}` };
}

function parseProfileText(pageText, code) {
  const pick = (re) => pageText.match(re)?.[1]?.trim() ?? null;
  const statusIndex = pageText.indexOf("交易状态");
  const statusBlock =
    statusIndex >= 0 ? pageText.slice(statusIndex, statusIndex + 240).replace(/\s+/g, " ") : "";
  const sizeMatch = pageText.match(/净资产规模[：:]\s*([\d.,]+)\s*(亿元|万元)/);
  const limitMatch = pageText.match(/单日累计购买上限\s*([\d.,]+)\s*(万元|元)/);
  const managerSince = pageText
    .slice(pageText.indexOf("基金经理变动一览"))
    .match(/(20\d{2}-\d{2}-\d{2})\s*至今/)?.[1] ?? null;

  return {
    code,
    name: pick(/^(.+?)\(\d{6}\)基金基本概况/m) ?? null,
    manager: pick(/基金经理[：:]\s*([^\s（(]{1,12})/),
    managerSince,
    inception: pick(/成立日期[：:]\s*(20\d{2}-\d{2}-\d{2})/),
    type: pick(/类型[：:]\s*([^\s]{1,24})/),
    company: pick(/管理人[：:]\s*([^\s]{1,24})/),
    size: sizeMatch ? parseSize(sizeMatch[1], sizeMatch[2]) : null,
    tradeStatus: statusBlock || null,
    purchaseStatus: /限大额/.test(statusBlock)
      ? "限大额"
      : /暂停申购/.test(statusBlock)
        ? "暂停申购"
        : /开放申购/.test(statusBlock)
          ? "开放申购"
          : null,
    redeemStatus: /暂停赎回/.test(statusBlock)
      ? "暂停赎回"
      : /开放赎回/.test(statusBlock)
        ? "开放赎回"
        : null,
    purchaseLimit: limitMatch ? `${limitMatch[1]}${limitMatch[2]}` : null,
  };
}

function parseHoldings(content) {
  const rows = [];
  const firstTbody = content.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  const re = /<tr><td>\d+<\/td><td><a[^>]*>(\d{6})<\/a><\/td><td class='tol'><a[^>]*>([^<]+)<\/a><\/td>[\s\S]*?<td class='tor'>([\d.]+)%<\/td>/g;
  let match;
  const seen = new Set();
  while ((match = re.exec(firstTbody))) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    rows.push({ code: match[1], name: match[2].trim(), weight: round(Number(match[3]) / 100, 4) });
  }
  return rows;
}

function structuralFlags(profile) {
  const flags = [];
  if (profile.purchaseStatus === "暂停申购") {
    flags.push({ level: "high", code: "SUSPENDED_PURCHASE", message: "暂停申购：当前无法买入" });
  }
  if (profile.redeemStatus === "暂停赎回") {
    flags.push({ level: "high", code: "SUSPENDED_REDEEM", message: "暂停赎回：当前无法卖出" });
  }
  if (profile.purchaseLimit) {
    const value = Number(profile.purchaseLimit.replace(/[^\d.]/g, ""));
    const cap = /万元/.test(profile.purchaseLimit) ? value * 10000 : value;
    if (cap <= 10000) {
      flags.push({ level: "medium", code: "LOW_PURCHASE_LIMIT", message: `单日申购上限仅 ${profile.purchaseLimit}，大额买入会受限` });
    }
  }
  if (profile.size && profile.size.yi < 5) {
    flags.push({ level: "medium", code: "SMALL_SIZE", message: `规模 ${profile.size.display}，低于 5 亿，注意清盘风险` });
  }
  if (profile.inception) {
    const days = daysBetween(profile.inception);
    if (days !== null && days < 365) {
      flags.push({ level: "medium", code: "YOUNG_FUND", message: `成立仅 ${days} 天，历史业绩参考性弱` });
    }
  }
  if (profile.managerSince) {
    const days = daysBetween(profile.managerSince);
    if (days !== null && days < 180) {
      flags.push({ level: "medium", code: "NEW_MANAGER", message: `现任基金经理任职 ${days} 天，稳定性待观察` });
    }
  }
  return flags;
}

export async function fetchProfile(code, options = {}) {
  const { force = false } = options;
  const cacheFile = path.join(CACHE_DIR, `profile-${code}.json`);
  if (!force && fileAgeMs(cacheFile) < PROFILE_TTL_SECONDS * 1000) {
    const hit = readJson(cacheFile, null);
    if (hit) return hit;
  }

  const url = `https://fundf10.eastmoney.com/jjjl_${code}.html`;
  const html = await request(url, { headers: { Referer: REFERER } });
  const profile = parseProfileText(text(html), code);
  profile.name = profile.name ?? (await fundName(code));

  try {
    const holdingsHtml = await request(
      `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=`,
      { headers: { Referer: REFERER } },
    );
    profile.holdings = parseHoldings(holdingsHtml);
  } catch {
    profile.holdings = [];
  }

  profile.flags = structuralFlags(profile);
  profile.sources = [
    url,
    `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}`,
  ];
  profile.fetchedAt = new Date().toISOString();
  ensureDir(CACHE_DIR);
  writeJson(cacheFile, profile);
  return profile;
}

export function buildQueries(profile, extra = []) {
  const name = profile.name ?? profile.code;
  const queries = [
    `${name} 基金 最新消息 ${new Date().getFullYear()}`,
    `${name} 公告 清盘 暂停申购 风险`,
    `${name} 基金经理 ${profile.manager ?? ""} 离任 变更`.replace(/\s+/g, " ").trim(),
    `${name} 业绩 下跌 亏损 跑输`,
  ];
  const top = (profile.holdings ?? []).slice(0, 3).map((h) => h.name).filter(Boolean);
  if (top.length > 0) queries.push(`${name} 重仓股 ${top.join(" ")} 风险 消息`);
  return [...queries, ...extra];
}

function pickDate(item) {
  if (item.date && /^20\d{2}-\d{2}-\d{2}$/.test(item.date)) return item.date;
  const hay = `${item.title ?? ""} ${item.snippet ?? ""} ${item.url ?? ""}`;
  let m = hay.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = hay.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  return null;
}

function recencyFactor(date, now = new Date()) {
  const days = date ? daysBetween(date, now) : null;
  if (days === null) return 0.9;
  if (days <= 7) return 1.5;
  if (days <= 30) return 1.2;
  if (days <= 90) return 1.0;
  if (days <= 365) return 0.7;
  return 0.5;
}

function scoreItem(item) {
  const title = item.title ?? "";
  const snippet = item.snippet ?? "";
  const body = `${title} ${snippet}`;
  const riskHits = [];
  const hotHits = [];
  let risk = 0;
  let hot = 0;

  for (const word of RISK_HIGH) {
    if (body.includes(word)) {
      risk += title.includes(word) ? 4.5 : 3;
      riskHits.push(word);
    }
  }
  for (const word of RISK_MED) {
    if (body.includes(word)) {
      risk += title.includes(word) ? 3 : 2;
      riskHits.push(word);
    }
  }
  for (const word of HOT_HIGH) {
    if (body.includes(word)) {
      hot += title.includes(word) ? 4.5 : 3;
      hotHits.push(word);
    }
  }
  for (const word of HOT_MED) {
    if (body.includes(word)) {
      hot += title.includes(word) ? 2.5 : 1.5;
      hotHits.push(word);
    }
  }

  const date = pickDate(item);
  const factor = recencyFactor(date);
  return {
    title,
    url: item.url ?? null,
    snippet,
    date,
    riskScore: round(risk * factor, 2),
    hotScore: round(hot * factor, 2),
    riskHits: [...new Set(riskHits)],
    hotHits: [...new Set(hotHits)],
    polarity: risk > hot ? "risk" : hot > risk ? "hot" : "neutral",
  };
}

export function classifyItems(items, profile) {
  const seen = new Set();
  const evidence = [];
  for (const item of items) {
    const key = `${item.url ?? ""}|${item.title ?? ""}`.toLowerCase();
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    const scored = scoreItem(item);
    if (scored.riskScore === 0 && scored.hotScore === 0) continue;
    evidence.push(scored);
  }
  evidence.sort((a, b) => Math.max(b.riskScore, b.hotScore) - Math.max(a.riskScore, a.hotScore));

  const riskScore = round(evidence.reduce((sum, item) => sum + item.riskScore, 0), 2);
  const hotScore = round(evidence.reduce((sum, item) => sum + item.hotScore, 0), 2);
  const riskItems = evidence.filter((item) => item.polarity === "risk").length;
  const hotItems = evidence.filter((item) => item.polarity === "hot").length;

  let stance = "neutral";
  if (riskScore >= 5 && riskScore >= hotScore * 1.5) stance = "risk";
  else if (hotScore >= 5 && hotScore >= riskScore * 1.5) stance = "hot";
  else if (riskScore > 0 && hotScore > 0) stance = "mixed";

  const flags = profile?.flags ?? [];
  if (flags.some((flag) => flag.level === "high") && stance !== "risk") {
    stance = stance === "hot" ? "mixed" : "risk";
  }

  const maxSide = Math.max(riskScore, hotScore);
  const confidence = evidence.length >= 5 && maxSide >= 12 ? "high" : evidence.length >= 3 && maxSide >= 6 ? "medium" : "low";

  const recommendation = {
    risk: "雷点占优：建议回避；已持有可考虑减仓",
    hot: "热点占优：可考虑买入或继续持有",
    mixed: "多空交织：建议观望，等方向明确",
    neutral: "无明显雷点或热点：不建议仅凭资讯操作",
  }[stance];

  return {
    code: profile?.code ?? null,
    name: profile?.name ?? null,
    stance,
    recommendation,
    confidence,
    riskScore,
    hotScore,
    counts: { evidence: evidence.length, riskItems, hotItems },
    evidence: evidence.slice(0, 12),
    structuralFlags: flags,
    profile: profile
      ? {
          name: profile.name,
          manager: profile.manager,
          managerSince: profile.managerSince,
          inception: profile.inception,
          type: profile.type,
          company: profile.company,
          size: profile.size,
          purchaseStatus: profile.purchaseStatus,
          redeemStatus: profile.redeemStatus,
          purchaseLimit: profile.purchaseLimit,
          holdings: (profile.holdings ?? []).slice(0, 10),
        }
      : null,
  };
}

export function loadVerdict(code) {
  return loadVerdictFromDb(code);
}

export function saveVerdict(verdict) {
  const record = { ...verdict, scannedAt: new Date().toISOString() };
  saveVerdictToDb(record);
  return record;
}

export function verdictAgeHours(verdict) {
  if (!verdict?.scannedAt) return Infinity;
  return (Date.now() - new Date(verdict.scannedAt).getTime()) / 3600000;
}

export function isVerdictFresh(verdict, config = loadConfig()) {
  return Boolean(verdict) && verdictAgeHours(verdict) <= config.news.maxAgeHours;
}

export function buildQueriesFor(profile, extra = []) {
  return buildQueries(profile, extra);
}
