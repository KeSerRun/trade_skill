# trade_skill — 基金交易助手

给 Command Code 用的基金助手：查行情与净值、抓基金档案与重仓股、对联网资讯做雷点/热点打分、维护纸面账户与风控，并支持每天自动生成操作与收盘盈亏。**全部为模拟盘，不连接真实账户，不自动下单，不构成投资建议。**

当前形态：

- **14:30** 自动生成操作（场外 15:00 前提交），按规则自动记账
- **15:30** 用对应 ETF 收盘涨跌估算当日盈亏并推送
- **SQLite 单一数据源**：账户、持仓、成交、指令、规则、净值快照、资讯结论都在 `.fund-trading/fund.db`
- **管理后台**：Vue 3 + Element Plus，管理持仓和场内/场外交易限制

## 目录结构

```
trade_skill/
├── .commandcode/
│   ├── skills/fund-trading/
│   │   ├── SKILL.md
│   │   ├── scripts/
│   │   │   ├── fund.mjs      # 行情 / 净值 / 检索
│   │   │   ├── news.mjs      # 雷点热点：档案、搜索词、分类打分、结论
│   │   │   ├── order.mjs     # 模拟指令：新建/列表/回报/取消/过期
│   │   │   ├── paper.mjs     # 纸面账户：记账、持仓、流水、快照
│   │   │   ├── risk.mjs      # 风控：限额、集中度、止损止盈、回撤、调仓
│   │   │   └── lib/
│   │   │       ├── paths.mjs      # 状态目录与数据库路径
│   │   │       ├── sqlite.mjs     # SQLite 存储层
│   │   │       ├── config.mjs     # 默认规则 + SQLite 规则读取
│   │   │       ├── portfolio.mjs  trade.mjs    riskcore.mjs
│   │   │       ├── orders.mjs     news.mjs     data.mjs
│   │   │       ├── http.mjs       store.mjs    cli.mjs  format.mjs
│   │   └── references/
│   └── fund-report/          # 14:30 / 15:30 自动任务
│       ├── run-daily.ps1
│       ├── run-close.ps1
│       ├── collect.mjs       advice.mjs   execute.mjs
│       ├── settle.mjs        render.mjs   report-close.mjs
│       ├── notify.mjs        settings.mjs  prompt-a.md
│       └── prompt-b.md
├── admin/                    # Vue 3 + Element Plus 管理后台
│   ├── server/               # Node API + SQLite
│   ├── src/                  # 前端页面
│   └── dist/                 # 构建产物
└── .fund-trading/
    └── fund.db               # 唯一交易数据源（含设置与推送配置）
```

## 环境

- Node.js 22+（使用内置 `node:sqlite`）
- 可访问东方财富 / 腾讯 / 新浪
- Agent 使用内置 `web_search` 抓新闻（脚本只做分类）
- 管理后台需要 `npm install`（Vue、Element Plus、Vite）

## 管理后台

```bash
cd admin
npm install
npm run dev      # 前端 http://localhost:5173，API http://127.0.0.1:8787
```

生产模式：

```bash
npm run build
npm start        # http://127.0.0.1:8787
```

页面：

- **总览**：总资产、现金、持仓市值、累计盈亏、仓位环形图
- **实时行情**：只展示关注列表中的产品；场内 ETF 实时行情与分时 / 日 / 周 / 月 K 线，场外基金显示最新净值
- **产品库**：全市场基金与 ETF 产品表，支持搜索、分页、按当前页刷新行情；场内显示实时价，场外显示最新净值，并可加入关注
- **持仓管理**：新增/编辑/删除，区分场外/场内，维护份额、成本、首次买入日、最新净值
- **交易限制**：场外/场内分别配置最短持有天数、买入费率、赎回费分档；组合层面配置单只上限、总仓位、现金底线、单笔上限
- **关注列表**：从产品库选择场外 / 场内产品，维护对标 ETF、搜索词、启用状态和排序
- **定时任务**：查看 14:30 / 15:30 的 Windows 计划任务状态、下次运行、上次结果，支持改时间、启停、立即运行，以及场外 / 场内关注列表切换
- **系统设置**：策略参数、运行参数、推送通道与密钥
- **交易记录**：自动/手动成交、费用、实现盈亏、结算状态

后台写入直接落 `fund.db`，定时任务读同一份规则，不需要导入导出。实时行情使用东方财富公开接口、腾讯兜底；免费源没有 SLA，仅作参考。

局域网访问：开发用 `npm run dev -- --host 0.0.0.0`，生产用 `npm start -- --host 0.0.0.0`。防火墙和注意事项见 `admin/README.md`。

## 定时任务

Windows 计划任务：

- `FundDailyReport`：每天 14:30，生成操作并自动记账
- `FundDailyClose`：每天 15:30，生成收盘盈亏

两个任务只在开机且已登录时运行；睡眠会尝试唤醒，关机不会补跑。

手动重跑当天任务（复用已抓新闻、不重复推送）：

```powershell
powershell -ExecutionPolicy Bypass -File .commandcode\fund-report\run-daily.ps1 -ReuseNews -NoPush
```

运行日志在 `.fund-trading/logs/`，采集和报告产物在 `.fund-trading/collect/` 与 `.fund-trading/reports/`。

## 数据存储

`.fund-trading/fund.db` 中的表：

| 表 | 内容 |
| --- | --- |
| `account` | 初始资金、现金、已实现盈亏 |
| `positions` | 持仓、成本、成本价、首次买入日、最新净值 |
| `trades` | 买入/卖出成交、费用、结算状态 |
| `orders` | 待执行/已成交/已取消指令 |
| `trade_rules` | 场外/场内最短持有天数、买入费率、赎回费分档 |
| `portfolio_rules` | 单只上限、总仓位、现金底线、单笔上限 |
| `equity_snapshots` | 每日总资产快照，用于回撤 |
| `news_verdicts` | 雷点/热点结论与证据 |
| `watchlist` | 场外 / 场内候选基金、对标 ETF、搜索词、启用和排序 |
| `products` | 全市场基金 / ETF 产品主表，按市场和代码唯一 |
| `meta` | 当前市场模式 `market_mode` 等键值 |
| `app_settings` | 自动记账、搜索词数、轮数、模型等运行参数 |
| `advice_settings` | 买入/卖出立场、阈值、仓位、止损止盈 |
| `notify_settings` | 推送通道、Webhook / Key、标题前缀 |

运行时还会产生 `cache/`（行情缓存）、`collect/`、`reports/`、`logs/`，这些是可删除的缓存和产物，不是交易数据的副本。

## 命令行

```bash
# 数据源连通性
node .commandcode/skills/fund-trading/scripts/fund.mjs doctor --json

# 行情 / 净值 / 检索
node .commandcode/skills/fund-trading/scripts/fund.mjs search 白酒 --json
node .commandcode/skills/fund-trading/scripts/fund.mjs quote 161725 --json

# 基金档案 + 建议搜索词
node .commandcode/skills/fund-trading/scripts/news.mjs profile 161725 --json

# 账户与持仓
node .commandcode/skills/fund-trading/scripts/paper.mjs init --cash 10000 --json
node .commandcode/skills/fund-trading/scripts/paper.mjs status --json

# 风控
node .commandcode/skills/fund-trading/scripts/risk.mjs alerts --json
node .commandcode/skills/fund-trading/scripts/risk.mjs drawdown --json
```

手动指令模式仍保留：`order.mjs new` 生成指令单，用户执行后 `order.mjs fill` 回报成交。自动模式则直接由 `execute.mjs` 写入 SQLite。

## 资讯结论怎么来

1. `news.mjs profile <code>` 抓基金档案、重仓股、申赎状态，并生成建议搜索词。
2. Agent 用 `web_search` 逐条搜索，记录 `title/url/snippet/date`。
3. `news.mjs scan` 按关键词权重、时间衰减打分：
   - `risk` 雷点占优 → 回避 / 减仓
   - `hot` 热点占优 → 可考虑买入 / 持有
   - `mixed` 多空交织 → 观望
   - `neutral` 无明显信号 → 不建议仅凭资讯操作
4. 结论默认 24 小时有效，过期需重扫，存放在 `news_verdicts` 表。

**买入硬门槛**：没有新鲜结论 → 退出码 3；结论为 `risk` → 退出码 2。

## 场外规则

- 15:00 前提交按当日 15:00 净值确认
- 最短持有 2 天，T+2（第三个交易日）才能赎回
- 赎回费：不满 7 天 1.5%，7–30 天 0.5%，30–365 天 0.1%，满 1 年 0

场内 ETF 默认 T+1，费率可在管理后台单独配置。

## 边界

- 覆盖场内 ETF 与场外公募基金，全部模拟。
- 资讯结论是关键词启发式，只看标题摘要，不核实真伪，不预测涨跌。
- 15:30 的场外盈亏用对应 ETF 收盘涨跌估算；官方净值通常晚间公布，次日 14:30 结算更正。
- 行情来自公开页面接口，可能滞后或改版。
- 不构成投资建议。
