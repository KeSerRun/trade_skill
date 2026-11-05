#!/usr/bin/env node
import { ensureUtf8Console, fail, isJsonMode, numberFlag, parseArgs, requireFlag } from "./lib/cli.mjs";
import { table, money, pct, signed } from "./lib/format.mjs";
import { loadConfig } from "./lib/config.mjs";
import { readEquitySnapshots } from "./lib/sqlite.mjs";
import { round } from "./lib/store.mjs";
import { loadAccount, refreshHoldings, snapshot } from "./lib/portfolio.mjs";
import { checkBuy, checkSell } from "./lib/riskcore.mjs";

ensureUtf8Console();

const USAGE = `仓位与风控工具

用法:
  node risk.mjs check --code 510300 --side buy --amount 10000 [--refresh] [--json]
  node risk.mjs check --code 510300 --side sell --shares 1000 [--json]
  node risk.mjs size --price 4.12 [--pct 0.1] [--equity 100000]
  node risk.mjs exposure [--json]
  node risk.mjs alerts [--json]
  node risk.mjs drawdown [--json]
  node risk.mjs rebalance --targets "510300:0.4,161725:0.3" [--json]

说明:
  check    交易前风控校验（单笔限额/集中度/现金底线）
  size     按总资产比例计算建议买入金额与份额
  exposure 当前持仓分布
  alerts   止损/止盈提示
  drawdown 基于 equity_snapshots 表计算最大回撤
  rebalance 按目标权重生成调仓指令`;

function print(data, renderHuman, flags) {
  if (isJsonMode(flags)) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(data)}\n`);
}

async function run() {
  const [, , command, ...rest] = process.argv;
  const valueFlags = ["code", "side", "amount", "shares", "price", "pct", "equity", "targets", "limit"];
  const { flags } = parseArgs(rest, valueFlags);
  const config = loadConfig();

  switch (command) {
    case "check": {
      const code = String(requireFlag(flags, "code"));
      const side = String(requireFlag(flags, "side")).toLowerCase();
      if (!["buy", "sell"].includes(side)) throw new Error("--side 只能是 buy 或 sell");
      const account = loadAccount();
      if (flags.refresh) await refreshHoldings(account);
      const state = snapshot(account);

      const amount = numberFlag(flags, "amount", null);
      const shares = numberFlag(flags, "shares", null);
      if (side === "buy" && (!amount || amount <= 0)) throw new Error("买入校验需要 --amount");
      if (side === "sell" && (!shares || shares <= 0)) throw new Error("卖出校验需要 --shares");

      const result =
        side === "buy"
          ? checkBuy(account, config, code, amount, state)
          : checkSell(account, config, code, shares);

      print(
        { ok: true, side, code, ...result, state: { cash: state.cash, equity: state.equity, positionValue: state.positionValue } },
        (data) => {
          const lines = [
            `风控校验 [${data.side === "buy" ? "买入" : "卖出"}] ${data.code}${data.projection?.name ? ` ${data.projection.name}` : ""}`,
            `结论: ${data.allowed ? "通过" : "拦截"}`,
          ];
          if (data.violations.length > 0) lines.push(`违规:\n${data.violations.map((v) => `  - ${v}`).join("\n")}`);
          if (data.warnings.length > 0) lines.push(`提示:\n${data.warnings.map((w) => `  - ${w}`).join("\n")}`);
          return lines.join("\n");
        },
        flags,
      );
      if (!result.allowed) process.exitCode = 2;
      return;
    }

    case "size": {
      const price = numberFlag(flags, "price", null);
      if (!price || price <= 0) throw new Error("请提供有效 --price");
      const pctFlag = numberFlag(flags, "pct", config.risk.maxSinglePositionPct);
      let equity = numberFlag(flags, "equity", null);
      if (!equity) equity = snapshot(loadAccount()).equity;
      const amount = round(equity * pctFlag, 2);
      const shares = round(amount / price, 2);
      print(
        { ok: true, equity, pct: pctFlag, price, amount, shares },
        (data) => `总资产 ${money(data.equity)} 元，按 ${pct(data.pct)} 配置\n建议买入 ${money(data.amount)} 元 ≈ ${data.shares} 份（净值 ${data.price}）`,
        flags,
      );
      return;
    }

    case "exposure": {
      const account = loadAccount();
      const state = snapshot(account);
      const rows = state.holdings.map((h) => {
        const value = h.shares * (h.lastNav ?? h.avgCost);
        return { ...h, marketValue: round(value, 2), weight: state.equity > 0 ? value / state.equity : 0 };
      });
      print(
        { ok: true, cash: state.cash, equity: state.equity, positionValue: state.positionValue, cashPct: state.equity > 0 ? state.cash / state.equity : 0, holdings: rows },
        (data) =>
          [
            table(data.holdings, [
              { label: "代码", value: (h) => h.code },
              { label: "名称", value: (h) => h.name ?? "-" },
              { label: "市值", value: (h) => money(h.marketValue) },
              { label: "权重", value: (h) => pct(h.weight) },
              { label: "收益率", value: (h) => pct(h.cost > 0 ? (h.marketValue - h.cost) / h.cost : 0) },
            ]),
            "",
            `现金 ${money(data.cash)}（${pct(data.cashPct)}）  总资产 ${money(data.equity)}`,
          ].join("\n"),
        flags,
      );
      return;
    }

    case "alerts": {
      const account = loadAccount();
      const state = snapshot(account);
      const alerts = [];
      for (const h of state.holdings) {
        const pnlPct = h.cost > 0 ? (h.shares * (h.lastNav ?? h.avgCost) - h.cost) / h.cost : 0;
        if (pnlPct <= -config.risk.stopLossPct) {
          alerts.push({ type: "STOP_LOSS", code: h.code, name: h.name, pnlPct, threshold: -config.risk.stopLossPct });
        } else if (pnlPct >= config.risk.takeProfitPct) {
          alerts.push({ type: "TAKE_PROFIT", code: h.code, name: h.name, pnlPct, threshold: config.risk.takeProfitPct });
        }
      }
      print(
        { ok: true, count: alerts.length, alerts },
        (data) =>
          data.alerts.length === 0
            ? "无止损/止盈触发"
            : table(data.alerts, [
                { label: "类型", value: (a) => (a.type === "STOP_LOSS" ? "止损" : "止盈") },
                { label: "代码", value: (a) => a.code },
                { label: "名称", value: (a) => a.name ?? "-" },
                { label: "收益率", value: (a) => pct(a.pnlPct) },
                { label: "阈值", value: (a) => pct(a.threshold) },
              ]),
        flags,
      );
      return;
    }

    case "drawdown": {
      const snapshots = readEquitySnapshots();
      if (snapshots.length === 0) throw new Error("还没有净值快照，请先执行 paper.mjs snapshot");
      let peak = -Infinity;
      let maxDrawdown = 0;
      let peakDate = null;
      let troughDate = null;
      let currentPeak = -Infinity;
      for (const item of snapshots) {
        if (item.equity > peak) {
          peak = item.equity;
          peakDate = item.date;
        }
        const dd = peak > 0 ? (peak - item.equity) / peak : 0;
        if (dd > maxDrawdown) {
          maxDrawdown = dd;
          troughDate = item.date;
        }
        if (item.equity > currentPeak) currentPeak = item.equity;
      }
      const latest = snapshots.at(-1);
      const currentDrawdown = currentPeak > 0 ? (currentPeak - latest.equity) / currentPeak : 0;
      const breached = maxDrawdown >= config.risk.maxDrawdownAlertPct;
      print(
        { ok: true, snapshots: snapshots.length, maxDrawdown, peakDate, troughDate, currentDrawdown, latest, alertThreshold: config.risk.maxDrawdownAlertPct, breached },
        (data) =>
          [
            `快照 ${data.snapshots} 条`,
            `最大回撤 ${pct(data.maxDrawdown)}（${data.peakDate ?? "-"} → ${data.troughDate ?? "-"}）`,
            `当前回撤 ${pct(data.currentDrawdown)}，最新总资产 ${money(data.latest.equity)}`,
            data.breached ? `警告: 最大回撤超过预警线 ${pct(data.alertThreshold)}` : "",
          ].filter(Boolean).join("\n"),
        flags,
      );
      return;
    }

    case "rebalance": {
      const targetsRaw = String(requireFlag(flags, "targets"));
      const account = loadAccount();
      const state = snapshot(account);
      const targets = targetsRaw.split(",").map((pair) => {
        const [code, weightText] = pair.split(":").map((s) => s.trim());
        const weight = Number(weightText);
        if (!code || !Number.isFinite(weight) || weight < 0) throw new Error(`目标权重格式错误: ${pair}`);
        return { code, weight };
      });
      const weightSum = targets.reduce((sum, t) => sum + t.weight, 0);
      if (weightSum > 1.0001) throw new Error(`目标权重合计 ${pct(weightSum)} 超过 100%`);

      const orders = [];
      for (const target of targets) {
        const holding = account.holdings[target.code];
        const currentValue = holding ? holding.shares * (holding.lastNav ?? holding.avgCost) : 0;
        const targetValue = state.equity * target.weight;
        const delta = round(targetValue - currentValue, 2);
        const nav = holding?.lastNav ?? holding?.avgCost ?? null;
        if (Math.abs(delta) < 1) continue;
        orders.push({
          code: target.code,
          name: holding?.name ?? null,
          action: delta > 0 ? "BUY" : "SELL",
          amount: Math.abs(delta),
          shares: nav ? round(Math.abs(delta) / nav, 2) : null,
          currentWeight: state.equity > 0 ? currentValue / state.equity : 0,
          targetWeight: target.weight,
        });
      }
      print(
        { ok: true, equity: state.equity, targets, orders },
        (data) =>
          data.orders.length === 0
            ? "当前持仓已接近目标权重，无需调仓"
            : table(data.orders, [
                { label: "操作", value: (o) => (o.action === "BUY" ? "买入" : "卖出") },
                { label: "代码", value: (o) => o.code },
                { label: "名称", value: (o) => o.name ?? "-" },
                { label: "金额", value: (o) => money(o.amount) },
                { label: "估算份额", value: (o) => (o.shares === null ? "-" : o.shares.toFixed(2)) },
                { label: "当前权重", value: (o) => pct(o.currentWeight) },
                { label: "目标权重", value: (o) => pct(o.targetWeight) },
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
