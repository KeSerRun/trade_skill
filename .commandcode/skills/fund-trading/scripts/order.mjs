#!/usr/bin/env node
import { ensureUtf8Console, fail, isJsonMode, numberFlag, parseArgs, requireFlag } from "./lib/cli.mjs";
import { table, money, pct, signed } from "./lib/format.mjs";
import { buyRateFor, loadConfig } from "./lib/config.mjs";
import { round, today } from "./lib/store.mjs";
import { holdingDaysForFee, loadAccount, resolveNav, saveAccount, sellRateFor, snapshot } from "./lib/portfolio.mjs";
import { checkBuy, checkSell } from "./lib/riskcore.mjs";
import { computeBuyFill, computeSellFill, applyBuy, applySell } from "./lib/trade.mjs";
import { ORDER_STATUS, createOrder, findOrder, loadOrders, saveOrders, updateOrder } from "./lib/orders.mjs";
import { isVerdictFresh, loadVerdict, verdictAgeHours } from "./lib/news.mjs";

ensureUtf8Console();

const USAGE = `交易指令（模拟下单 -> 用户手动执行 -> 回报成交）

用法:
  node order.mjs new --side buy  --code 161725 --amount 10000 [--nav 0.5964] [--note 备注] [--skip-news]
  node order.mjs new --side sell --code 161725 --shares 5000 [--all] [--nav 0.5964] [--note 备注]
  node order.mjs list [--status pending|filled|cancelled|expired] [--limit 20]
  node order.mjs show <指令ID>
  node order.mjs fill <指令ID> [--nav 实际净值] [--shares 实际份额] [--amount 实际金额] [--fee 实际费用] [--date 成交日]
  node order.mjs cancel <指令ID> [--reason 原因]
  node order.mjs expire [--days 1]

流程:
  1. news.mjs profile/scan  先完成雷点/热点扫描（买入必做，结论过期需重扫）
  2. new    生成待执行指令（风控 + 资讯双重校验，不通过则拒绝生成）
  3. 用户按指令单在交易平台手动下单
  4. fill   回报实际成交，写入纸面账户
  5. cancel 用户未执行时取消；expire 批量过期逾期指令`;

function print(data, renderHuman, flags) {
  if (isJsonMode(flags)) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(data)}\n`);
}

const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

function nextCutoff(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setHours(15, 0, 0, 0);
  if (now < cutoff && !isWeekend(now)) {
    return { cutoffIso: cutoff.toISOString(), label: "今日 15:00 前", sameDay: true };
  }
  const next = new Date(cutoff);
  do {
    next.setDate(next.getDate() + 1);
  } while (isWeekend(next));
  return { cutoffIso: next.toISOString(), label: "下一交易日 15:00 前", sameDay: false };
}

export function newsSnapshot(code, config) {
  const verdict = loadVerdict(code);
  if (!verdict) return { status: "missing", fresh: false };
  const ageHours = verdictAgeHours(verdict);
  return {
    status: isVerdictFresh(verdict, config) ? "fresh" : "stale",
    fresh: isVerdictFresh(verdict, config),
    stance: verdict.stance,
    recommendation: verdict.recommendation,
    confidence: verdict.confidence,
    riskScore: verdict.riskScore,
    hotScore: verdict.hotScore,
    scannedAt: verdict.scannedAt,
    ageHours: Number(ageHours.toFixed(1)),
    topRisks: (verdict.evidence ?? []).filter((item) => item.polarity === "risk").slice(0, 3).map((item) => item.title),
    topThemes: (verdict.evidence ?? []).filter((item) => item.polarity === "hot").slice(0, 3).map((item) => item.title),
    structuralFlags: verdict.structuralFlags ?? [],
  };
}

function renderTicket(order) {
  const isBuy = order.side === "buy";
  const statusLabel = { PENDING: "待执行", FILLED: "已成交", CANCELLED: "已取消", EXPIRED: "已过期" }[order.status] ?? order.status;
  const lines = [
    "────────────────────────────────────────────",
    `${statusLabel}指令 ${order.id}  [${order.status}]`,
    "────────────────────────────────────────────",
    `方向: ${isBuy ? "申购 / 买入" : "赎回 / 卖出"}`,
    `基金: ${order.name ?? "-"} (${order.code})`,
  ];
  if (isBuy) {
    lines.push(`金额: ${money(order.amount)} 元`);
    lines.push(`参考净值: ${order.estimatedNav}${order.navDate ? ` (${order.navDate})` : ""}`);
    lines.push(`预计费率: ${(order.feeRate * 100).toFixed(4)}%`);
    lines.push(`预计手续费: ${money(order.estimatedFee)} 元`);
    lines.push(`预计份额: ${money(order.estimatedShares)} 份`);
  } else {
    lines.push(`份额: ${money(order.shares)} 份`);
    lines.push(`参考净值: ${order.estimatedNav}${order.navDate ? ` (${order.navDate})` : ""}`);
    lines.push(`预计费率: ${(order.feeRate * 100).toFixed(4)}%`);
    lines.push(`预计手续费: ${money(order.estimatedFee)} 元`);
    lines.push(`预计到账: ${money(order.estimatedProceeds)} 元`);
    lines.push(`预计实现盈亏: ${signed(order.estimatedRealizedPnl)} 元`);
  }
  if (order.status === "PENDING") {
    if (order.market === "exchange") {
      lines.push("执行窗口: 交易时段 9:30-11:30 / 13:00-15:00（场内按实时价格成交）");
    } else {
      lines.push(`执行窗口: ${order.deadline?.label ?? "-"}（场外按当日净值成交，超时顺延下一交易日）`);
    }
  }
  if (order.risk?.warnings?.length) {
    lines.push(`风险提示: ${order.risk.warnings.join("；")}`);
  }
  if (order.news) {
    if (order.news.status === "fresh") {
      const stanceLabel = { risk: "雷点占优", hot: "热点占优", mixed: "多空交织", neutral: "中性" }[order.news.stance] ?? order.news.stance;
      lines.push(`资讯结论: ${stanceLabel}（雷点分 ${order.news.riskScore} / 热点分 ${order.news.hotScore}，置信度 ${order.news.confidence}）`);
      lines.push(`资讯建议: ${order.news.recommendation}`);
    } else {
      lines.push(`资讯结论: 未扫描或已过期（${order.news.status}）`);
    }
  }
  lines.push("────────────────────────────────────────────");

  if (order.status === "FILLED" && order.fill) {
    const fill = order.fill;
    lines.push(`成交日期: ${fill.date}`);
    lines.push(`成交净值: ${fill.nav}`);
    if (fill.shares !== undefined) lines.push(`成交份额: ${money(fill.shares)} 份`);
    if (fill.amount !== undefined) lines.push(`成交金额: ${money(fill.amount)} 元`);
    if (fill.proceeds !== undefined) lines.push(`实际到账: ${money(fill.proceeds)} 元`);
    if (fill.fee !== undefined) lines.push(`实际费用: ${money(fill.fee)} 元`);
    if (fill.realizedPnl !== undefined) lines.push(`实现盈亏: ${signed(fill.realizedPnl)} 元`);
    lines.push("已写入纸面账户，可用 paper.mjs status 查看持仓。");
  } else if (order.status === "CANCELLED") {
    lines.push(`已取消${order.reason ? `：${order.reason}` : ""}（${(order.cancelledAt ?? "").slice(0, 19).replace("T", " ")}）`);
  } else if (order.status === "EXPIRED") {
    lines.push("已过期：超过有效期未回报成交，如需继续请重新生成指令。");
  } else {
    lines.push("请在交易平台按上述信息手动提交。");
    lines.push(`成交后回报: node order.mjs fill ${order.id} --nav <实际净值> [--shares <实际份额>]`);
    lines.push(`放弃执行: node order.mjs cancel ${order.id}`);
  }
  return lines.join("\n");
}

async function run() {
  const [, , command, ...rest] = process.argv;
  const valueFlags = ["side", "code", "amount", "shares", "nav", "fee", "fee-rate", "note", "date", "status", "limit", "days", "reason"];
  const { positional, flags } = parseArgs(rest, valueFlags);
  const config = loadConfig();

  switch (command) {
    case "new": {
      const side = String(requireFlag(flags, "side")).toLowerCase();
      if (!["buy", "sell"].includes(side)) throw new Error("--side 只能是 buy 或 sell");
      const code = String(requireFlag(flags, "code"));
      const account = loadAccount();
      const state = snapshot(account);
      const manualNav = numberFlag(flags, "nav", null);

      if (side === "buy") {
        const amount = numberFlag(flags, "amount", null);
        if (!amount || amount <= 0) throw new Error("买入指令需要 --amount");
        const risk = checkBuy(account, config, code, amount, state);
        if (!risk.allowed) {
          print(
            { ok: false, error: "风控拦截，未生成指令", ...risk },
            (data) => [`风控拦截，未生成指令:`, ...data.violations.map((v) => `  - ${v}`)].join("\n"),
            flags,
          );
          process.exitCode = 2;
          return;
        }
        const news = newsSnapshot(code, config);
        if (!news.fresh && config.news.requireForBuy && !flags["skip-news"]) {
          print(
            {
              ok: false,
              error: "缺少最新资讯扫描，已阻止买入",
              news,
              next: [
                `node news.mjs profile ${code} --json`,
                "按返回的 queries 用联网搜索抓取结果，保存为 JSON",
                `node news.mjs scan ${code} --input <结果.json> --json`,
                "完成后再下单；确需跳过资讯校验请加 --skip-news",
              ],
            },
            (data) => [
              `已阻止买入: ${data.error}`,
              `当前资讯状态: ${data.news.status}`,
              "请先完成资讯扫描:",
              ...data.next.map((v) => `  - ${v}`),
            ].join("\n"),
            flags,
          );
          process.exitCode = 3;
          return;
        }
        if (news.fresh && config.news.blockOnRisk && news.stance === "risk") {
          print(
            { ok: false, error: "资讯雷点占优，已阻止买入", news },
            (data) => [
              `已阻止买入: ${data.error}`,
              `雷点分 ${data.news.riskScore} / 热点分 ${data.news.hotScore}，置信度 ${data.news.confidence}`,
              `建议: ${data.news.recommendation}`,
              ...(data.news.topRisks ?? []).map((t) => `  - ${t}`),
            ].join("\n"),
            flags,
          );
          process.exitCode = 2;
          return;
        }
        if (news.fresh && news.stance === "hot") risk.warnings.push("资讯热点占优，注意追高风险");
        if (news.fresh && news.stance === "mixed") risk.warnings.push("资讯多空交织，建议控制仓位");
        const info = await resolveNav(code, { nav: manualNav, date: flags.date });
        const market = manualNav ? "otc" : info.market ?? null;
        const feeRate = numberFlag(flags, "fee-rate", buyRateFor(market, config));
        const fill = computeBuyFill({ amount, nav: info.nav, feeRate });
        const order = createOrder({
          side: "buy",
          code,
          name: info.name ?? risk.projection.name ?? null,
          market,
          amount: round(amount, 2),
          shares: null,
          feeRate,
          estimatedNav: info.nav,
          navDate: info.date ?? null,
          estimatedShares: fill.shares,
          estimatedFee: fill.fee,
          estimatedProceeds: null,
          estimatedRealizedPnl: null,
          deadline: nextCutoff(),
          risk,
          news,
          note: flags.note ?? null,
        });
        print(
          { ok: true, order, instructions: renderTicket(order) },
          (data) => data.instructions,
          flags,
        );
        return;
      }

      const holding = account.holdings[code];
      if (!holding) throw new Error(`未持有基金 ${code}，无法生成卖出指令`);
      const shares = flags.all ? holding.shares : numberFlag(flags, "shares", null);
      if (!shares || shares <= 0) throw new Error("卖出指令需要 --shares 或 --all");
      const risk = checkSell(account, config, code, shares);
      if (!risk.allowed) {
        print(
          { ok: false, error: "校验未通过，未生成指令", ...risk },
          (data) => [`校验未通过，未生成指令:`, ...data.violations.map((v) => `  - ${v}`)].join("\n"),
          flags,
        );
        process.exitCode = 2;
        return;
      }
      const news = newsSnapshot(code, config);
      if (news.fresh && news.stance === "hot") risk.warnings.push("资讯偏热，卖出前确认是否仍然必要");
      if (news.fresh && news.stance === "risk") risk.warnings.push("资讯偏冷，支持减仓");
      const info = await resolveNav(code, { nav: manualNav, date: flags.date });
      const feeRate = numberFlag(flags, "fee-rate", sellRateFor(holding, config));
      const fill = computeSellFill({ shares, nav: info.nav, feeRate });
      const costPortion = round(holding.avgCost * shares, 2);
      const order = createOrder({
        side: "sell",
        code,
        name: holding.name,
        market: manualNav ? "otc" : info.market ?? null,
        amount: null,
        shares: round(shares, 2),
        feeRate,
        estimatedNav: info.nav,
        navDate: info.date ?? null,
        estimatedShares: round(shares, 2),
        estimatedFee: fill.fee,
        estimatedProceeds: fill.proceeds,
        estimatedRealizedPnl: round(fill.proceeds - costPortion, 2),
        holdingDays: holdingDaysForFee(holding),
        deadline: nextCutoff(),
        risk,
        news,
        note: flags.note ?? null,
      });
      print({ ok: true, order, instructions: renderTicket(order) }, (data) => data.instructions, flags);
      return;
    }

    case "list": {
      const status = flags.status ? String(flags.status).toUpperCase() : null;
      const limit = numberFlag(flags, "limit", 20);
      const all = loadOrders();
      const filtered = status ? all.filter((order) => order.status === status) : all;
      const rank = { PENDING: 0, FILLED: 1, CANCELLED: 2, EXPIRED: 3 };
      const rows = filtered
        .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      print(
        { ok: true, count: rows.length, orders: rows },
        (data) => table(data.orders, [
          { label: "指令", value: (o) => o.id },
          { label: "状态", value: (o) => o.status },
          { label: "方向", value: (o) => (o.side === "buy" ? "申购" : "赎回") },
          { label: "代码", value: (o) => o.code },
          { label: "名称", value: (o) => o.name ?? "-" },
          { label: "金额", value: (o) => (o.side === "buy" ? money(o.amount) : "-") },
          { label: "份额", value: (o) => money(o.side === "sell" ? o.shares : o.estimatedShares) },
          { label: "创建时间", value: (o) => o.createdAt.slice(0, 19).replace("T", " ") },
        ]),
        flags,
      );
      return;
    }

    case "show": {
      const id = positional[0];
      if (!id) throw new Error("用法: show <指令ID>");
      const order = findOrder(id);
      if (!order) throw new Error(`未找到指令 ${id}`);
      print({ ok: true, order, instructions: renderTicket(order) }, (data) => data.instructions, flags);
      return;
    }

    case "fill": {
      const id = positional[0];
      if (!id) throw new Error("用法: fill <指令ID> [--nav] [--shares]");
      const order = findOrder(id);
      if (!order) throw new Error(`未找到指令 ${id}`);
      if (order.status !== ORDER_STATUS.PENDING) {
        throw new Error(`指令 ${id} 当前状态为 ${order.status}，只有 PENDING 可回报成交`);
      }
      const account = loadAccount();
      const nav = numberFlag(flags, "nav", order.estimatedNav);
      const date = flags.date ?? today();

      if (order.side === "buy") {
        const amount = numberFlag(flags, "amount", order.amount);
        const fee = numberFlag(flags, "fee", null);
        const fill = computeBuyFill({
          amount,
          nav,
          feeRate: order.feeRate,
          fee,
          shares: numberFlag(flags, "shares", null),
        });
        const trade = applyBuy(account, {
          code: order.code,
          name: order.name,
          amount: fill.amount,
          nav,
          shares: fill.shares,
          fee: fill.fee,
          date,
          market: order.market,
          note: order.note,
          orderId: order.id,
        });
        saveAccount(account);
        const updated = updateOrder(id, {
          status: ORDER_STATUS.FILLED,
          filledAt: new Date().toISOString(),
          fill: { nav, date, amount: fill.amount, shares: fill.shares, fee: fill.fee },
        });
        print(
          { ok: true, order: updated, trade, account: { cash: account.cash } },
          (data) => `指令 ${id} 已成交并记账\n  申购 ${data.trade.name ?? data.trade.code} ${money(data.trade.shares)} 份 @ ${data.trade.nav}\n  金额 ${money(data.trade.amount)} 元（费 ${money(data.trade.fee)}）\n  剩余现金 ${money(data.account.cash)} 元`,
          flags,
        );
        return;
      }

      const shares = numberFlag(flags, "shares", order.shares);
      const fee = numberFlag(flags, "fee", null);
      const result = applySell(account, {
        code: order.code,
        shares,
        nav,
        feeRate: order.feeRate,
        fee,
        date,
        note: order.note,
        orderId: order.id,
      });
      saveAccount(account);
      const updated = updateOrder(id, {
        status: ORDER_STATUS.FILLED,
        filledAt: new Date().toISOString(),
        fill: {
          nav,
          date,
          shares: result.fill.shares,
          gross: result.fill.gross,
          fee: result.fill.fee,
          proceeds: result.fill.proceeds,
          realizedPnl: result.realized,
        },
      });
      print(
        { ok: true, order: updated, trade: result.trade, realizedPnl: result.realized, account: { cash: account.cash } },
        (data) => `指令 ${id} 已成交并记账\n  赎回 ${money(data.trade.shares)} 份 @ ${data.trade.nav}，到账 ${money(data.trade.amount)} 元（费 ${money(data.trade.fee)}）\n  实现盈亏 ${signed(data.realizedPnl)} 元，剩余现金 ${money(data.account.cash)} 元`,
        flags,
      );
      return;
    }

    case "cancel": {
      const id = positional[0];
      if (!id) throw new Error("用法: cancel <指令ID>");
      const order = findOrder(id);
      if (!order) throw new Error(`未找到指令 ${id}`);
      if (order.status !== ORDER_STATUS.PENDING) {
        throw new Error(`指令 ${id} 当前状态为 ${order.status}，只有 PENDING 可取消`);
      }
      const updated = updateOrder(id, {
        status: ORDER_STATUS.CANCELLED,
        cancelledAt: new Date().toISOString(),
        reason: flags.reason ?? null,
      });
      print({ ok: true, order: updated }, (data) => `指令 ${id} 已取消${data.order.reason ? `（${data.order.reason}）` : ""}`, flags);
      return;
    }

    case "expire": {
      const days = numberFlag(flags, "days", 1);
      const orders = loadOrders();
      const now = Date.now();
      let count = 0;
      for (const order of orders) {
        if (order.status !== ORDER_STATUS.PENDING) continue;
        if (now - new Date(order.createdAt).getTime() >= days * 86400000) {
          order.status = ORDER_STATUS.EXPIRED;
          order.updatedAt = new Date().toISOString();
          count += 1;
        }
      }
      if (count > 0) {
        saveOrders(orders);
      }
      print({ ok: true, expired: count, days }, (data) => `已过期 ${data.expired} 条超过 ${data.days} 天的待执行指令`, flags);
      return;
    }

    default:
      process.stdout.write(`${USAGE}\n`);
      if (command) process.exitCode = 1;
  }
}

run().catch((error) => fail(error.message));
