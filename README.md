# trade_skill — 基金交易助手

面向支持 Agent Skills 的智能体的基金助手：查行情与净值、抓基金档案与重仓股、对联网资讯做雷点/热点打分、维护纸面账户与风控，并支持每天自动生成操作与收盘盈亏。**全部为模拟盘，不连接真实账户，不自动下单，不构成投资建议。**

当前形态：

- **14:30** 自动生成操作（场外 15:00 前提交），按规则自动记账
- **15:30** 用对应 ETF 收盘涨跌估算当日盈亏并推送
- **SQLite 单一数据源**：账户、持仓、成交、指令、规则、净值快照、资讯结论都在 `.fund-trading/fund.db`
- **管理后台**：Vue 3 + Element Plus，管理持仓和场内/场外交易限制

## 安装

技能本体在 `skills/fund-trading/`，包含标准 `SKILL.md`、`scripts/`、`references/` 和可选的 `runner/`。

- 通用 Agent Skills 宿主：把 `skills/fund-trading/` 复制到宿主的 skills 目录。
- Command Code：直接把 `skills/fund-trading` 作为技能目录加载。
- 管理后台是独立可选项，不影响核心技能使用。
- 首次加载时技能会运行 `fund.mjs welcome`，介绍功能、当前账户状态和下一步；安装器本身不会执行脚本。

## 目录结构

```
trade_skill/
├── skills/fund-trading/
│   ├── SKILL.md
│   ├── scripts/
│   │   ├── fund.mjs      # 行情 / 净值 / 检索
│   │   ├── news.mjs      # 雷点热点：档案、搜索词、分类打分、结论
│   │   ├── order.mjs     # 模拟指令：新建/列表/回报/取消/过期
│   │   ├── paper.mjs     # 纸面账户：记账、持仓、流水、快照
│   │   ├── risk.mjs      # 风控：限额、集中度、止损止盈、回撤、调仓
│   │   └── lib/
│   │       ├── paths.mjs      # 状态目录与数据库路径
│   │       ├── sqlite.mjs     # SQLite 存储层
│   │       ├── config.mjs     # 默认规则 + SQLite 规则读取
│   │       ├── portfolio.mjs  trade.mjs    riskcore.mjs
│   │       ├── orders.mjs     news.mjs     data.mjs
│   │       ├── http.mjs       store.mjs    cli.mjs  format.mjs
│   ├── references/
│   └── runner/               # 14:30 / 15:30 自动任务
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
- 宿主提供网页搜索工具（如 `web_search`、`search`、`browser`；脚本只做分类）
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
- **实时行情**：默认展示上证 / 深证 / 创业板指数，并展示关注列表中的产品；场内 ETF 实时行情与分时 / 日 / 周 / 月 K 线，场外基金显示最新净值
- **产品库**：全市场基金与 ETF 产品表，支持搜索、分页、按当前页刷新行情和加入关注；点击「查看」打开对应产品的分时 / K 线
- **持仓管理**：新增/编辑/删除，区分场外/场内，维护份额、成本、首次买入日、最新净值
- **交易限制**：场外/场内分别配置最短持有天数、买入费率、赎回费分档；组合层面配置单只上限、总仓位、现金底线、单笔上限
- **关注列表**：从产品库选择场外 / 场内产品，维护板块、搜索词、启用状态和排序
- **定时任务**：查看 14:30 / 15:30 的 Windows 计划任务状态、下次运行、上次结果，支持改时间、启停、立即运行，以及场外 / 场内关注列表切换
- **系统设置**：策略参数、运行参数、推送通道与密钥
- **交易记录**：自动/手动成交、费用、实现盈亏、结算状态

后台写入直接落 `fund.db`，定时任务读同一份规则，不需要导入导出。实时行情使用东方财富公开接口、腾讯兜底；免费源没有 SLA，仅作参考。

局域网访问：开发用 `npm run dev -- --host 0.0.0.0`，生产用 `npm start -- --host 0.0.0.0`。防火墙和注意事项见 `admin/README.md`。

## 定时任务

Windows 计划任务：

- `FundDailyReport`：默认每天 14:30，生成操作并自动记账
- `FundDailyClose`：默认每天 15:30，生成收盘盈亏

首次安装后可以直接用 skill 命令注册，不需要先启动后台：

```powershell
node skills/fund-trading/scripts/fund.mjs setup
```

可指定时间、市场和项目目录：

```powershell
node skills/fund-trading/scripts/fund.mjs setup --daily 14:30 --close 15:30 --market otc --project-root D:\MS-PRG\trade_skill
```

`--dry-run` 只预览，`--uninstall` 删除这两个任务并在 `scheduled_tasks` 中标记停用，`--no-daily` / `--no-close` 只注册其中一个。注册目前只支持 Windows；runner 已包含在 skill 内，但自动任务仍需要项目根目录下的 `.fund-trading` 数据和 Node.js/Command Code 或自定义 Agent 适配器。

如果使用 Claude Code、Codex 或其他 Agent，可以写一个 PowerShell 适配器，接收 `-PromptFile`、`-OutputFile`、`-MaxTurns`、`-Model` 并把最终文本写入 `-OutputFile`，然后注册时传入：

```powershell
node skills/fund-trading/scripts/fund.mjs setup --agent-adapter "C:\path\agent-adapter.ps1"
```

示例见 `skills/fund-trading/runner/agent-adapter.example.ps1`。后台同步 action 时读取 `FUND_TRADE_AGENT_ADAPTER`，用后台管理任务时请给后台进程设置同一个变量。

管理台支持新增、编辑、删除定时任务；日报任务可以单独选择场外 / 场内，任务配置保存在 `scheduled_tasks`，Windows 计划任务由管理台同步注册和删除。

任务只在开机且已登录时运行；睡眠会尝试唤醒，关机不会补跑。

手动重跑当天任务（复用已抓新闻、不重复推送）：

```powershell
powershell -ExecutionPolicy Bypass -File skills\fund-trading\runner\run-daily.ps1 -ReuseNews -NoPush
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
| `watchlist` | 场外 / 场内候选基金、搜索词、启用和排序 |
| `products` | 全市场基金 / ETF 产品主表，按市场和代码唯一 |
| `scheduled_tasks` | 定时任务注册表：名称、类型、时间、市场、启用状态 |
| `meta` | 当前市场模式 `market_mode` 等键值 |
| `app_settings` | 自动记账、搜索词数、轮数、模型等运行参数 |
| `advice_settings` | 买入/卖出立场、阈值、仓位、止损止盈 |
| `notify_settings` | 推送通道、Webhook / Key、标题前缀 |

运行时还会产生 `cache/`（行情缓存）、`collect/`、`reports/`、`logs/`，这些是可删除的缓存和产物，不是交易数据的副本。

`fund.db` 使用 WAL 模式，`fund.db-wal` 是数据库的一部分。不要在服务运行或未 checkpoint 时删除它，否则可能丢失已提交的交易；需要清理时先执行 `PRAGMA wal_checkpoint(TRUNCATE)`。管理后台总览每 30 秒自动刷新一次。

## 命令行

```bash
# 数据源连通性
node skills/fund-trading/scripts/fund.mjs doctor --json

# 行情 / 净值 / 检索
node skills/fund-trading/scripts/fund.mjs search 白酒 --json
node skills/fund-trading/scripts/fund.mjs quote 161725 --json

# 基金档案 + 建议搜索词
node skills/fund-trading/scripts/news.mjs profile 161725 --json

# 账户与持仓
node skills/fund-trading/scripts/paper.mjs init --cash 10000 --json
node skills/fund-trading/scripts/paper.mjs status --json

# 风控
node skills/fund-trading/scripts/risk.mjs alerts --json
node skills/fund-trading/scripts/risk.mjs drawdown --json
```

手动指令模式仍保留：`order.mjs new` 生成指令单，用户执行后 `order.mjs fill` 回报成交。自动模式则直接由 `execute.mjs` 写入 SQLite。

## 资讯结论怎么来

1. `news.mjs profile <code>` 抓基金档案、重仓股、申赎状态，并生成建议搜索词。
2. 宿主用网页搜索工具逐条搜索，记录 `title/url/snippet/date`。
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
