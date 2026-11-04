#!/usr/bin/env node
import { ensureUtf8Console, fail, isJsonMode, numberFlag, parseArgs } from "./lib/cli.mjs";
import { table, money, pct, signed } from "./lib/format.mjs";
import { buyRateFor, loadConfig } from "./lib/config.mjs";
import { DB_FILE } from "./lib/paths.mjs";
import { hasAccount, resetAccountAndOrders } from "./lib/sqlite.mjs";
import { round, today } from "./lib/store.mjs";
import {
  appendEquitySnapshot,
  loadAccount,
  positionSummary,
  refreshHoldings,
  resolveNav,
  saveAccount,
  sellRateFor,
} from "./lib/portfolio.mjs";
import { computeBuyFill, computeSellFill, applyBuy, applySell } from "./lib/trade.mjs";
import { checkSell } from "./lib/riskcore.mjs";

ensureUtf8Console();

const USAGE = `纸面账户（直接记账：适用于已在平台完成交易后补记）

用法:
  node paper.mjs init --cash 100000 [--force]
  node paper.mjs buy --code 510300 --amount 10000 [--nav 4.1] [--fee-rate 0.0015] [--date 2026-11-03] [--note 备注] [--dry-run]
  node paper.mjs sell --code 510300 --shares 1000 [--all] [--nav 4.2] [--fee-rate 0.005] [--date] [--note] [--dry-run]
  node paper.mjs status [--offline] [--json]
  node paper.mjs refresh
  node paper.mjs history [--limit 20] [--json]
  node paper.mjs snapshot
  node paper.mjs reset --confirm

提示: 需要「先生成指令、用户手动执行、再回报成交」时，请用 order.mjs。
账户数据库: ${DB_FILE}`;

const config = loadConfig();

function print(data, renderHuman, flags) {
  if (isJsonMode(flags)) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(data)}\n`);
}

async function run() {
  const [, , command, ...rest] = process.argv;
  const valueFlags = ["cash", "code", "amount", "shares", "nav", "fee-rate", "date", "note", "limit"];
  const { flags } = parseArgs(rest, valueFlags);

  switch (command) {
    case "init": {
      const cash = numberFlag(flags, "cash", 100000);
      if (hasAccount() && !flags.force) {
        throw new Error("账户已存在，如需重建请加 --force（会清空现有持仓与流水）");
      }
      const account = {
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        initialCash: cash,
        cash,
        realizedPnl: 0,
        holdings: {},
        trades: [],
      };
      saveAccount(account);
      print({ ok: true, account }, (data) => `账户已创建，初始资金 ${money(data.account.initialCash)} 元\n数据库: ${DB_FILE}`, flags);
      return;
    }

    case "buy": {
      const code = String(flags.code ?? "");
      if (!code) throw new Error("缺少必需参数 --code");
      const amount = numberFlag(flags, "amount", null);
      if (!amount || amount <= 0) throw new Error("买入金额必须大于 0（--amount）");

      const account = loadAccount();
      const info = await resolveNav(code, { nav: numberFlag(flags, "nav", null), date: flags.date });
      const feeRate = numberFlag(flags, "fee-rate", buyRateFor(info.market, config));
      const fill = computeBuyFill({ amount, nav: info.nav, feeRate });
      const date = flags.date ?? info.date ?? today();

      if (amount > account.cash + 1e-9) {
        throw new Error(`现金不足：可用 ${money(account.cash)} 元，本次需要 ${money(amount)} 元`);
      }

      if (flags["dry-run"]) {
        print(
          { ok: true, dryRun: true, type: "BUY", code, name: info.name, amount, fee: fill.fee, feeRate, nav: info.nav, shares: fill.shares, date },
          (data) => `[预览] 申购 ${data.name ?? data.code} 金额 ${money(data.amount)} 元，费 ${money(data.fee)}，份额 ${data.shares}，成交净值 ${data.nav}`,
          flags,
        );
        return;
      }

      const trade = applyBuy(account, {
        code,
        name: info.name,
        amount,
        nav: info.nav,
        shares: fill.shares,
        fee: fill.fee,
        date,
        market: info.market ?? "otc",
        note: flags.note ?? null,
      });
      saveAccount(account);
      const summary = positionSummary(account);
      print(
        { ok: true, trade, position: account.holdings[code], account: { cash: summary.cash, equity: summary.equity } },
        (data) =>
          `已申购 ${data.trade.name ?? data.trade.code}\n` +
          `  金额 ${money(data.trade.amount)} 元（费 ${money(data.trade.fee)}），份额 ${data.trade.shares}，净值 ${data.trade.nav}\n` +
          `  剩余现金 ${money(data.account.cash)} 元，总资产 ${money(data.account.equity)} 元`,
        flags,
      );
      return;
    }

    case "sell": {
      const code = String(flags.code ?? "");
      if (!code) throw new Error("缺少必需参数 --code");
      const account = loadAccount();
      const holding = account.holdings[code];
      if (!holding) throw new Error(`未持有基金 ${code}`);

      let shares = numberFlag(flags, "shares", null);
      if (flags.all) shares = holding.shares;
      if (!shares || shares <= 0) throw new Error("请指定 --shares 或 --all");
      if (shares > holding.shares + 1e-6) {
        throw new Error(`持有份额不足：当前 ${holding.shares}，本次 ${shares}`);
      }

      const check = checkSell(account, config, code, shares);
      if (!check.allowed) {
        print(
          { ok: false, error: "赎回校验未通过", ...check },
          (data) => `赎回校验未通过:\n${data.violations.map((v) => `  - ${v}`).join("\n")}`,
          flags,
        );
        process.exitCode = 2;
        return;
      }

      const info = await resolveNav(code, { nav: numberFlag(flags, "nav", null), date: flags.date });
      const feeRate = numberFlag(flags, "fee-rate", sellRateFor(holding, config));
      const fill = computeSellFill({ shares, nav: info.nav, feeRate });
      const costPortion = round(holding.avgCost * shares, 2);
      const realized = round(fill.proceeds - costPortion, 2);
      const date = flags.date ?? info.date ?? today();

      if (flags["dry-run"]) {
        print(
          {
            ok: true,
            dryRun: true,
            type: "SELL",
            code,
            name: holding.name,
            shares,
            nav: info.nav,
            gross: fill.gross,
            fee: fill.fee,
            feeRate,
            proceeds: fill.proceeds,
            costPortion,
            realizedPnl: realized,
            closing: shares >= holding.shares - 1e-6,
            date,
          },
          (data) =>
            `[预览] 赎回 ${data.name ?? data.code} ${data.shares} 份，到账 ${money(data.proceeds)} 元，` +
            `实现盈亏 ${signed(data.realizedPnl)} 元（费率 ${(data.feeRate * 100).toFixed(3)}%）`,
          flags,
        );
        return;
      }

      const result = applySell(account, {
        code,
        shares,
        nav: info.nav,
        feeRate,
        date,
        note: flags.note ?? null,
      });
      saveAccount(account);
      const summary = positionSummary(account);
      print(
        { ok: true, trade: result.trade, realizedPnl: result.realized, account: { cash: summary.cash, equity: summary.equity, realizedPnl: summary.realizedPnl } },
        (data) =>
          `已赎回 ${data.trade.name ?? data.trade.code} ${data.trade.shares} 份\n` +
          `  到账 ${money(data.trade.amount)} 元（费 ${money(data.trade.fee)}），实现盈亏 ${signed(data.realizedPnl)} 元\n` +
          `  剩余现金 ${money(data.account.cash)} 元`,
        flags,
      );
      return;
    }

    case "status": {
      const account = loadAccount();
      if (!flags.offline) {
        await refreshHoldings(account);
        saveAccount(account);
      }
      const summary = positionSummary(account);
      print(
        { ok: true, ...summary },
        (data) =>
          [
            table(data.holdings, [
              { label: "代码", value: (h) => h.code },
              { label: "名称", value: (h) => h.name ?? "-" },
              { label: "份额", value: (h) => h.shares.toFixed(2) },
              { label: "成本价", value: (h) => money(h.avgCost) },
              { label: "最新净值", value: (h) => money(h.lastNav) },
              { label: "市值", value: (h) => money(h.marketValue) },
              { label: "浮盈", value: (h) => signed(h.pnl) },
              { label: "收益率", value: (h) => pct(h.pnlPct) },
              { label: "占比", value: (h) => pct(data.equity > 0 ? h.marketValue / data.equity : 0) },
            ]),
            "",
            `现金 ${money(data.cash)}（${pct(data.cashPct)}）  持仓市值 ${money(data.positionValue)}（${pct(data.investedPct)}）`,
            `总资产 ${money(data.equity)}  浮动盈亏 ${signed(data.unrealizedPnl)}  已实现 ${signed(data.realizedPnl)}  总收益 ${signed(data.totalPnl)}（${pct(data.totalPnlPct)}）`,
          ].join("\n"),
        flags,
      );
      return;
    }

    case "refresh": {
      const account = loadAccount();
      await refreshHoldings(account);
      saveAccount(account);
      const summary = positionSummary(account);
      print({ ok: true, holdings: summary.holdings, equity: summary.equity }, (data) => `已刷新 ${data.holdings.length} 只持仓，总资产 ${money(data.equity)} 元`, flags);
      return;
    }

    case "history": {
      const account = loadAccount();
      const limit = numberFlag(flags, "limit", 20);
      const trades = account.trades.slice(-limit);
      print(
        { ok: true, count: trades.length, trades },
        (data) =>
          table(data.trades, [
            { label: "日期", value: (t) => t.date },
            { label: "类型", value: (t) => (t.type === "BUY" ? "申购" : "赎回") },
            { label: "代码", value: (t) => t.code },
            { label: "名称", value: (t) => t.name ?? "-" },
            { label: "份额", value: (t) => t.shares.toFixed(2) },
            { label: "净值", value: (t) => money(t.nav) },
            { label: "金额", value: (t) => money(t.amount) },
            { label: "费用", value: (t) => money(t.fee) },
            { label: "实现盈亏", value: (t) => (t.realizedPnl === undefined ? "-" : signed(t.realizedPnl)) },
          ]),
        flags,
      );
      return;
    }

    case "snapshot": {
      const account = loadAccount();
      if (!flags.offline) {
        await refreshHoldings(account);
        saveAccount(account);
      }
      const { record, snapshots } = appendEquitySnapshot(account);
      print({ ok: true, record, snapshots: snapshots.length }, (data) => `已记录 ${data.record.date} 总资产 ${money(data.record.equity)} 元（共 ${data.snapshots} 条）`, flags);
      return;
    }

    case "reset": {
      if (!flags.confirm) throw new Error("重置会删除全部纸面账户与指令数据，请加 --confirm");
      resetAccountAndOrders();
      print({ ok: true, reset: true }, () => `已重置，账户与指令已清空`, flags);
      return;
    }

    default:
      process.stdout.write(`${USAGE}\n`);
      if (command) process.exitCode = 1;
  }
}

run().catch((error) => fail(error.message));
