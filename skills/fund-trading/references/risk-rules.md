# 风控规则与配置

配置优先级：SQLite 中的 `trade_rules` / `portfolio_rules` > 脚本内置默认值。
通过管理后台修改，或直接改 `fund.db`，下一次调用即生效。场外和场内可以分别配置最短持有天数、买入费率和赎回费分档。

## 默认参数

```json
{
  "risk": {
    "maxSinglePositionPct": 0.3,
    "maxTotalPositionPct": 0.95,
    "minCashReservePct": 0.05,
    "maxOrderAmount": 50000,
    "minHoldingDays": 2,
    "exchangeMinHoldingDays": 1,
    "stopLossPct": 0.15,
    "takeProfitPct": 0.3,
    "maxDrawdownAlertPct": 0.2
  },
  "fees": {
    "buyRate": 0.0015,
    "sellRateTiers": [
      { "maxHoldingDays": 7, "rate": 0.015 },
      { "maxHoldingDays": 30, "rate": 0.005 },
      { "maxHoldingDays": 365, "rate": 0.001 },
      { "maxHoldingDays": null, "rate": 0 }
    ]
  },
  "data": {
    "quoteCacheSeconds": 30,
    "historyCacheSeconds": 3600,
    "fundListCacheSeconds": 86400
  }
}
```

## 买入校验规则（`risk.mjs check --side buy`）

按顺序全部检查，任一不满足即 `allowed=false`：

1. 单笔金额 ≤ `maxOrderAmount`
2. 可用现金 ≥ 本次金额
3. 交易后现金 / 总资产 ≥ `minCashReservePct`
4. 该基金交易后市值 / 总资产 ≤ `maxSinglePositionPct`
5. 全部持仓市值（交易后） / 总资产 ≤ `maxTotalPositionPct`

提示（不拦截）：

- 已持有该基金时提示为加仓，并给出当前成本价。

## 卖出校验规则（`risk.mjs check --side sell`）

1. 必须持有该基金
2. 卖出份额 ≤ 持仓份额
3. 持有天数 ≥ 最短持有天数：场外 `minHoldingDays`（默认 2，买入当日与次日不可赎回），场内 `exchangeMinHoldingDays`（默认 1，T+1）
4. 清仓时提示将释放全部仓位

赎回费从**份额确认日**起算（场外 = 买入日 + 1 天），不足 7 天收 1.5%。

## 费用计算

- 申购费 = 金额 × `buyRate`；份额 = (金额 − 申购费) / 净值
- 赎回费 = 赎回金额 × 持有天数对应费率；到账 = 赎回金额 − 赎回费
- 成本按「累计投入含费」记账，`avgCost = 累计成本 / 累计份额`
- 卖出时按均价结转成本：`costPortion = avgCost × 卖出份额`，`实现盈亏 = 到账 − costPortion`
- 持有天数从该基金**首次买入日**起算（简化处理，不做逐笔 FIFO）

## 回撤

`paper.mjs snapshot` 将当日总资产写入 `fund.db` 的 `equity_snapshots` 表。
`risk.mjs drawdown` 以历史最高点为峰计算最大回撤，以及相对上一个峰值的最新回撤。
最大回撤 ≥ `maxDrawdownAlertPct` 时标记 `breached=true`。

## 调仓

`risk.mjs rebalance --targets "code:weight,..."`：

- 权重为占总资产比例，合计不得超过 100%
- 未列出的持仓保持不动
- 差额 < 1 元不下单
- 生成的是建议指令，执行前仍需逐笔 `check`

## 建议的实盘迁移路径

该技能只做模拟。若将来要接真实交易：

1. 保持 `fund.mjs` / `risk.mjs` 不变，仅替换 `paper.mjs` 的执行后端；
2. 真实下单必须增加二次确认、幂等键、失败回滚与成交流水对账；
3. 不要在代码或配置中硬编码账户凭证，使用系统密钥管理。
