#!/usr/bin/env node
import fs from "node:fs";
import { ensureUtf8Console, fail, isJsonMode, parseArgs } from "./lib/cli.mjs";
import { table, money, pct, signed } from "./lib/format.mjs";
import { loadConfig } from "./lib/config.mjs";
import {
  buildQueries,
  classifyItems,
  fetchProfile,
  isVerdictFresh,
  loadVerdict,
  saveVerdict,
  verdictAgeHours,
} from "./lib/news.mjs";

ensureUtf8Console();

const USAGE = `资讯雷点 / 热点扫描（联网搜索结果 + 确定性分类）

用法:
  node news.mjs profile <基金代码> [--force] [--json]
  node news.mjs queries <基金代码> [--json]
  node news.mjs scan <基金代码> --input <结果JSON文件|-> [--no-profile] [--json]
  node news.mjs verdict <基金代码> [--json]
  node news.mjs report <基金代码> [--input <结果JSON文件>] [--json]

说明:
  profile  抓取基金档案、重仓股、申赎状态，输出建议搜索词
  queries  仅输出建议搜索词
  scan     对联网搜索到的结果做雷点/热点分类打分，写入结论文件
  verdict  查看已保存的结论与新鲜度
  report   档案 + 结论一次输出

输入文件格式（scan / report --input）:
  [{ "title": "...", "url": "...", "snippet": "...", "date": "2026-10-29" }, ...]
  也接受 { "results": [ ... ] }`;

function print(data, renderHuman, flags) {
  if (isJsonMode(flags)) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(data)}\n`);
}

function readInput(source) {
  const raw = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`输入不是合法 JSON: ${error.message}`);
  }
  const items = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : null;
  if (!items) throw new Error('输入需为 JSON 数组，或 {"results":[...]}');
  return items;
}

async function safeProfile(code, force = false) {
  try {
    return await fetchProfile(code, { force });
  } catch (error) {
    process.stderr.write(`[warn] 档案获取失败，仅做资讯分类: ${error.message}\n`);
    return { code, flags: [], holdings: [], name: null };
  }
}

function renderVerdict(verdict) {
  const age = verdictAgeHours(verdict);
  const stanceLabel = { risk: "雷点占优", hot: "热点占优", mixed: "多空交织", neutral: "中性" }[verdict.stance] ?? verdict.stance;
  const lines = [
    `资讯结论 [${verdict.code}${verdict.name ? ` ${verdict.name}` : ""}]`,
    `立场: ${stanceLabel}（${verdict.stance}）  置信度: ${verdict.confidence}`,
    `建议: ${verdict.recommendation}`,
    `雷点分 ${verdict.riskScore} / 热点分 ${verdict.hotScore}  证据 ${verdict.counts.evidence} 条`,
    `扫描时间: ${verdict.scannedAt}（${age.toFixed(1)} 小时前）`,
  ];
  if (verdict.structuralFlags?.length) {
    lines.push("结构性问题:");
    for (const flag of verdict.structuralFlags) lines.push(`  - [${flag.level}] ${flag.message}`);
  }
  if (verdict.evidence?.length) {
    lines.push("", "证据:");
    for (const item of verdict.evidence.slice(0, 8)) {
      const tag = item.polarity === "risk" ? "雷" : item.polarity === "hot" ? "热" : "中";
      const hits = [...item.riskHits, ...item.hotHits].slice(0, 4).join("/");
      lines.push(`  [${tag}] ${item.date ?? "日期未知"} ${item.title}`);
      if (hits) lines.push(`        命中: ${hits}`);
      if (item.url) lines.push(`        ${item.url}`);
    }
  }
  return lines.join("\n");
}

async function run() {
  const [, , command, ...rest] = process.argv;
  const valueFlags = ["input", "limit"];
  const { positional, flags } = parseArgs(rest, valueFlags);
  const config = loadConfig();

  switch (command) {
    case "profile": {
      const code = positional[0];
      if (!code) throw new Error("用法: profile <基金代码>");
      const profile = await fetchProfile(code, { force: Boolean(flags.force) });
      const queries = buildQueries(profile);
      print(
        { ok: true, profile, queries },
        (data) => {
          const p = data.profile;
          const lines = [
            table([
              { k: "代码", v: p.code },
              { k: "名称", v: p.name ?? "-" },
              { k: "类型", v: p.type ?? "-" },
              { k: "管理人", v: p.company ?? "-" },
              { k: "基金经理", v: p.manager ?? "-" },
              { k: "经理任职起", v: p.managerSince ?? "-" },
              { k: "成立日期", v: p.inception ?? "-" },
              { k: "净资产规模", v: p.size?.display ?? "-" },
              { k: "申购状态", v: p.purchaseStatus ?? "-" },
              { k: "赎回状态", v: p.redeemStatus ?? "-" },
              { k: "单日申购上限", v: p.purchaseLimit ?? "-" },
            ], [
              { label: "项目", value: (r) => r.k },
              { label: "值", value: (r) => r.v },
            ]),
          ];
          if (p.flags?.length) {
            lines.push("", "结构性问题:");
            for (const flag of p.flags) lines.push(`  - [${flag.level}] ${flag.message}`);
          }
          if (p.holdings?.length) {
            lines.push("", table(p.holdings, [
              { label: "代码", value: (h) => h.code },
              { label: "重仓股", value: (h) => h.name },
              { label: "占净值", value: (h) => pct(h.weight) },
            ]));
          }
          lines.push("", "建议搜索词:");
          for (const query of data.queries) lines.push(`  - ${query}`);
          return lines.join("\n");
        },
        flags,
      );
      return;
    }

    case "queries": {
      const code = positional[0];
      if (!code) throw new Error("用法: queries <基金代码>");
      const profile = await safeProfile(code);
      const queries = buildQueries(profile);
      print({ ok: true, code, queries }, (data) => data.queries.map((q) => `- ${q}`).join("\n"), flags);
      return;
    }

    case "scan": {
      const code = positional[0];
      if (!code) throw new Error("用法: scan <基金代码> --input <文件|->");
      if (!flags.input) throw new Error("需要 --input <搜索结果JSON文件|->");
      const items = readInput(String(flags.input));
      const profile = flags["no-profile"] ? { code, flags: [], holdings: [] } : await safeProfile(code);
      const verdict = classifyItems(items, profile);
      const saved = saveVerdict(verdict);
      print(
        { ok: true, verdict: saved, fresh: true },
        () => renderVerdict(saved),
        flags,
      );
      return;
    }

    case "verdict": {
      const code = positional[0];
      if (!code) throw new Error("用法: verdict <基金代码>");
      const verdict = loadVerdict(code);
      if (!verdict) throw new Error(`没有 ${code} 的资讯结论，请先执行 scan`);
      const fresh = isVerdictFresh(verdict, config);
      print({ ok: true, fresh, ageHours: verdictAgeHours(verdict), verdict }, (data) => `${renderVerdict(data.verdict)}\n\n新鲜度: ${data.fresh ? "有效" : "已过期"}（阈值 ${config.news.maxAgeHours} 小时）`, flags);
      if (!fresh) process.exitCode = 4;
      return;
    }

    case "report": {
      const code = positional[0];
      if (!code) throw new Error("用法: report <基金代码> [--input <文件>]");
      const profile = await safeProfile(code, Boolean(flags.force));
      const queries = buildQueries(profile);
      let verdict = null;
      if (flags.input) {
        verdict = saveVerdict(classifyItems(readInput(String(flags.input)), profile));
      } else {
        verdict = loadVerdict(code);
      }
      print(
        { ok: true, profile, queries, verdict, fresh: verdict ? isVerdictFresh(verdict, config) : false },
        (data) =>
          [
            `基金: ${data.profile.name ?? code} (${code})  经理 ${data.profile.manager ?? "-"}  规模 ${data.profile.size?.display ?? "-"}`,
            data.profile.flags?.length ? `结构性问题 ${data.profile.flags.length} 项` : "结构性问题: 无",
            "",
            data.verdict ? renderVerdict(data.verdict) : "尚无资讯结论，请先执行 scan",
            "",
            "建议搜索词:",
            ...data.queries.map((q) => `  - ${q}`),
          ].join("\n"),
        flags,
      );
      return;
    }

    default:
      process.stdout.write(`${USAGE}\n`);
      if (command) process.exitCode = 1;
  }
}

run().catch((error) => fail(error.message));
