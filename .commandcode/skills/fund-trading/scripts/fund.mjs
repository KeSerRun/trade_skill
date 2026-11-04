#!/usr/bin/env node
import { ensureUtf8Console, fail, isJsonMode, numberFlag, parseArgs } from "./lib/cli.mjs";
import { table, money, pct, signed } from "./lib/format.mjs";
import { loadFundList, navHistory, quoteFund, searchFunds } from "./lib/data.mjs";
import { probe } from "./lib/http.mjs";

ensureUtf8Console();

const USAGE = `基金行情与数据工具

用法:
  node fund.mjs quote <基金代码> [--exchange] [--json]
  node fund.mjs nav <基金代码> [--pages N] [--page-size N] [--json]
  node fund.mjs search <关键词> [--limit N] [--json]
  node fund.mjs doctor [--json]

说明:
  quote  获取最新净值/价格（场外走净值，场内 ETF 走实时价格）
  nav    获取历史净值序列
  search 按代码/名称/拼音检索基金
  doctor 检测数据源连通性`;

function print(data, renderHuman, flags) {
  if (isJsonMode(flags)) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(data)}\n`);
  }
}

async function run() {
  const [, , command, ...rest] = process.argv;
  const valueFlags = ["pages", "page-size", "limit"];
  const { positional, flags } = parseArgs(rest, valueFlags);

  switch (command) {
    case "quote": {
      const code = positional[0];
      if (!code) throw new Error("用法: quote <基金代码>");
      const quote = await quoteFund(code, { prefer: flags.exchange ? "exchange" : "nav" });
      print(
        { ok: true, ...quote },
        (q) =>
          table([
            {
              item: "名称",
              value: q.name ?? "-",
            },
            { item: "代码", value: q.code },
            { item: "市场", value: q.market === "exchange" ? "场内" : "场外" },
            {
              item: q.market === "exchange" ? "现价" : "单位净值",
              value: money(q.market === "exchange" ? q.price : q.nav),
            },
            { item: "累计净值", value: q.accNav ? money(q.accNav) : "-" },
            { item: "涨跌幅", value: q.changePct === null || q.changePct === undefined ? "-" : `${signed(q.changePct * 100)}%` },
            { item: "日期", value: q.date ?? q.time?.slice(0, 10) ?? "-" },
            { item: "来源", value: q.source },
          ], [
            { label: "项目", value: (row) => row.item },
            { label: "值", value: (row) => row.value },
          ]),
        flags,
      );
      return;
    }

    case "nav": {
      const code = positional[0];
      if (!code) throw new Error("用法: nav <基金代码>");
      const rows = await navHistory(code, {
        pages: numberFlag(flags, "pages", 1),
        pageSize: numberFlag(flags, "page-size", 20),
      });
      print(
        { ok: true, code, count: rows.length, rows },
        (data) =>
          table(data.rows, [
            { label: "日期", value: (row) => row.date },
            { label: "单位净值", value: (row) => money(row.nav) },
            { label: "累计净值", value: (row) => money(row.accNav) },
            { label: "日涨跌", value: (row) => (row.changePct === null ? "-" : `${signed(row.changePct * 100)}%`) },
          ]),
        flags,
      );
      return;
    }

    case "search": {
      const keyword = positional[0];
      if (!keyword) throw new Error("用法: search <关键词>");
      const funds = await searchFunds(keyword, numberFlag(flags, "limit", 10));
      print(
        { ok: true, keyword, count: funds.length, funds },
        (data) => table(data.funds, [
          { label: "代码", value: (fund) => fund.code },
          { label: "名称", value: (fund) => fund.name },
          { label: "类型", value: (fund) => fund.type },
        ]),
        flags,
      );
      return;
    }

    case "doctor": {
      const results = await probe([
        ["历史净值(东财)", "https://api.fund.eastmoney.com/f10/lsjz?fundCode=000001&pageIndex=1&pageSize=1", { headers: { Referer: "https://fundf10.eastmoney.com/" } }],
        ["基金列表(东财)", "https://fund.eastmoney.com/js/fundcode_search.js", { headers: { Referer: "https://fund.eastmoney.com/" } }],
        ["场外行情(腾讯)", "https://qt.gtimg.cn/q=jj000001", { encoding: "gbk", headers: { Referer: "https://gu.qq.com/" } }],
        ["场外行情(新浪)", "https://hq.sinajs.cn/list=f_000001", { encoding: "gbk", headers: { Referer: "https://finance.sina.com.cn" } }],
        ["场内行情(东财)", "https://push2.eastmoney.com/api/qt/stock/get?secid=1.510300&fields=f43,f57,f58,f59", { headers: { Referer: "https://quote.eastmoney.com/" } }],
      ]);
      let listOk = true;
      let listCount = 0;
      try {
        listCount = (await loadFundList()).length;
      } catch (error) {
        listOk = false;
        results.push({ name: "基金列表解析", ok: false, error: error.message });
      }
      print(
        { ok: results.every((item) => item.ok), fundListLoaded: listOk, fundCount: listCount, checks: results },
        (data) => table([...data.checks, { name: "基金列表条数", ok: data.fundListLoaded, latencyMs: data.fundCount }], [
          { label: "数据源", value: (row) => row.name },
          { label: "状态", value: (row) => (row.ok ? "OK" : "FAIL") },
          { label: "耗时/条数", value: (row) => row.latencyMs ?? "-" },
          { label: "错误", value: (row) => row.error ?? "" },
        ]),
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
