# 基金交易台（管理后台）

本地管理台，Vue 3 + Element Plus 界面，所有交易数据只存在一个 SQLite 文件里，不再维护 account.json / config.json 副本。

## 功能

- 总览：总资产、现金、持仓市值、累计盈亏、仓位分布
- 持仓管理：新增/编辑/删除持仓，区分场外/场内，维护份额、成本、首次买入日、最新净值
- 交易限制：分别配置场外/场内的最短持有天数、买入费率、赎回费分档，以及组合层面的单只上限、总仓位上限、现金底线、单笔上限
- 交易记录：查看自动/手动成交，含结算状态

## 单一数据源

- SQLite：`../.fund-trading/fund.db`
- 账户、持仓、成交、指令、交易规则、净值快照、资讯结论全部在这个文件里
- 14:30 / 15:30 的定时任务和管理后台读写同一个数据库，不需要导入导出
- 不再生成 `account.json`、`orders.json`、`config.json`、`equity.jsonl`

## 运行

```bash
cd admin
npm install
npm run dev
```

- 前端：http://localhost:5173
- API：http://127.0.0.1:8787

生产模式：

```bash
npm run build
npm start
```

然后访问 http://127.0.0.1:8787

## 环境变量

- `PORT`：API 端口，默认 8787
- `HOST`：监听地址，默认 127.0.0.1
- `FUND_TRADE_DB`：SQLite 文件路径，默认 `../.fund-trading/fund.db`
- `FUND_TRADE_HOME`：状态目录，默认项目根 `.fund-trading`

## 注意

- 默认只监听本机，没有登录鉴权；不要直接暴露到公网
- 管理台只管理模拟盘数据，不会连接真实账户或下单
- 交易脚本同样读取 `fund.db` 里的规则，场内/场外费率会分别生效
