---
name: fund-trading
description: 获取中国公募基金与 ETF 的行情、净值与历史业绩；抓取基金档案、重仓股、申赎状态；对联网搜索到的新闻公告做雷点/热点分类打分并给出买入或卖出倾向；生成可手动执行的模拟买卖指令单，跟踪状态并在用户回报成交后同步纸面账户与仓位风控。用户提到基金行情、基金净值、基金新闻、雷点、热点、利空利好、模拟下单、买卖指令、跟单、仓位、风控、调仓时使用。适用于任何支持 Agent Skills 的宿主。
---

# 基金交易助手（行情 + 雷点热点 + 模拟下单跟单）

核心流程：**资讯扫描 → 生成操作 → 自动记账（或手动指令 → 回报成交）→ 纸面账户同步**。
**不连接真实账户，不自动下单，不涉及真实资金。**

常见请求：

- 查 161725 的雷点热点
- 生成买入指令 1 万 161725
- 回报成交
- 看持仓和风险

## 环境要求

- Node.js 22+（使用内置 `node:sqlite`）
- 可访问外网：东方财富 / 腾讯 / 新浪
- 宿主需提供网页搜索能力（如 `web_search`、`search`、`browser`）；脚本只负责分类，不负责搜索
- 技能本身无需安装 npm 包；管理后台需要 `npm install`
- 不需要特定 Agent 框架；只要宿主能执行 shell、读写文件和调用网页搜索即可

## 运行方式

脚本位于技能目录下。以下命令假设当前目录是项目根目录，技能目录是 `skills/fund-trading`；安装到其他宿主时，把 `skills/fund-trading` 换成实际技能目录：

```bash
node skills/fund-trading/scripts/fund.mjs
node skills/fund-trading/scripts/news.mjs
node skills/fund-trading/scripts/order.mjs
node skills/fund-trading/scripts/paper.mjs
node skills/fund-trading/scripts/risk.mjs
```

- 首次先跑 `fund.mjs doctor` 确认数据源连通。
- 账户、指令、资讯结论、交易规则、净值快照都存放在项目根目录的 `.fund-trading/fund.db`（SQLite）。
- 终端输出为表格；被管道捕获时自动 JSON。**调用方解析时显式加 `--json`。**

## 安装后注册定时任务

Windows 上首次安装后，用 skill 自带命令注册每日任务：

```powershell
node skills/fund-trading/scripts/fund.mjs setup
```

默认注册：

- `FundDailyReport`：每天 14:30，`-Market otc`
- `FundDailyClose`：每天 15:30

可调整时间或市场：

```powershell
node skills/fund-trading/scripts/fund.mjs setup --daily 14:30 --close 15:30 --market exchange
```

- `--dry-run`：只打印将要注册的任务，不改系统。
- `--uninstall`：删除这两个 Windows 计划任务，并把 `scheduled_tasks` 中对应任务标记为停用；不删除数据库和脚本。
- `--no-daily` / `--no-close`：只注册其中一个。
- `--project-root <目录>`：指定项目根目录；也可以用 `FUND_TRADE_PROJECT_ROOT`。
- 注册命令目前只支持 Windows；运行任务需要 `skills/fund-trading/runner`，只复制 skill 的核心脚本目录无法执行日报/收盘脚本。
- 日报/收盘的自动 Agent 调用默认自动识别 `command-code` / `cmdc`；其他宿主可以通过 `FUND_TRADE_AGENT_CMD` 或 `run-daily.ps1 -AgentAdapter` 接入适配器（见下方“宿主适配”）。
- 管理后台的「定时任务」页与这里注册的是同一组 Windows 任务。

## 宿主适配

`run-daily.ps1` 的自动搜索/写作阶段不绑定 Command Code：

1. 优先使用 `-AgentAdapter <ps1>`、`FUND_TRADE_AGENT_ADAPTER` 或环境变量 `FUND_TRADE_AGENT_CMD` 指向的 PowerShell 适配器。
2. 适配器接收 `-PromptFile`、`-OutputFile`、`-MaxTurns`、`-Model`，把最终纯文本写入 `-OutputFile`。
3. 未配置适配器时，自动尝试 `command-code`、`cmdc` 或本机旧版 Command Code 路径。
4. 都没有时跳过 Agent 阶段，使用确定性渲染降级，不影响账户和收盘脚本。

适配器示例见 `skills/fund-trading/runner/agent-adapter.example.ps1`。定时任务注册时可以用：

```powershell
node skills/fund-trading/scripts/fund.mjs setup --agent-adapter "C:\path\agent-adapter.ps1"
```

管理后台同步 Windows action 时也会读取 `FUND_TRADE_AGENT_ADAPTER`；如果通过后台管理定时任务，请给后台进程设置同一个环境变量，避免兼容修复时覆盖适配器参数。

## 核心概念

- **资讯结论（verdict）**：对某基金近期公开信息的雷点/热点打分，立场为
  `risk` / `hot` / `mixed` / `neutral`，默认 24 小时有效。
- **指令（order）**：待执行的买卖计划，状态 `PENDING` → `FILLED` / `CANCELLED` / `EXPIRED`。
- **纸面账户**：由 `execute.mjs` 自动记账、`order fill` 回报成交，或 `paper buy/sell` 直接补记时变动；数据都在 SQLite。
- **买入硬门槛**：必须有新鲜资讯结论，且结论不能是 `risk`。

## 命令速查

### fund.mjs — 行情与数据

| 命令 | 说明 |
| --- | --- |
| `fund.mjs doctor` | 检测数据源连通性 |
| `fund.mjs search <关键词>` | 按代码 / 名称 / 拼音检索基金 |
| `fund.mjs quote <代码> [--exchange]` | 最新净值或场内实时价 |
| `fund.mjs nav <代码> --pages 3` | 历史净值 |

### news.mjs — 雷点 / 热点

| 命令 | 说明 |
| --- | --- |
| `news.mjs profile <代码>` | 基金档案、重仓股、申赎状态，并返回建议搜索词 |
| `news.mjs queries <代码>` | 只输出建议搜索词 |
| `news.mjs scan <代码> --input <结果JSON>` | 对搜索结果分类打分并保存结论 |
| `news.mjs verdict <代码>` | 查看结论、证据与新鲜度 |
| `news.mjs report <代码> [--input <结果JSON>]` | 档案 + 结论一次输出 |

### order.mjs — 模拟指令与跟单

| 命令 | 说明 |
| --- | --- |
| `order.mjs new --side buy --code <代码> --amount <金额> [--skip-news]` | 生成买入指令（风控 + 资讯双重校验） |
| `order.mjs new --side sell --code <代码> --shares <份额> [--all]` | 生成卖出指令 |
| `order.mjs list [--status pending]` | 指令列表 |
| `order.mjs show <指令ID>` | 指令单全文 |
| `order.mjs fill <指令ID> [--nav 实际净值] [--shares 实际份额] [--fee 实际费用]` | 回报成交并记账 |
| `order.mjs cancel <指令ID> [--reason]` | 取消 |
| `order.mjs expire [--days 1]` | 过期逾期指令 |

### paper.mjs — 直接记账

| 命令 | 说明 |
| --- | --- |
| `paper.mjs init --cash 100000` | 初始化账户 |
| `paper.mjs buy --code <代码> --amount <金额> [--nav] [--dry-run]` | 直接补记申购 |
| `paper.mjs sell --code <代码> --shares <份额> [--all] [--dry-run]` | 直接补记赎回 |
| `paper.mjs status [--offline]` | 持仓、盈亏、占比 |
| `paper.mjs history --limit 20` | 交易流水 |
| `paper.mjs snapshot` | 记录当日总资产 |
| `paper.mjs reset --confirm` | 清空账户与指令 |

### risk.mjs — 仓位与风控

| 命令 | 说明 |
| --- | --- |
| `risk.mjs check --code <代码> --side buy --amount <金额> [--refresh]` | 风控校验 |
| `risk.mjs size --price <净值> [--pct 0.2]` | 建议买入金额与份额 |
| `risk.mjs exposure` | 仓位分布 |
| `risk.mjs alerts` | 止损 / 止盈提示 |
| `risk.mjs drawdown` | 最大回撤 |
| `risk.mjs rebalance --targets "510300:0.4,161725:0.3"` | 目标权重调仓 |

## 标准工作流

### 0. 资讯扫描（买入前必做）

**步骤 1** 取建议搜索词：

```bash
node skills/fund-trading/scripts/news.mjs profile 161725 --json
```

**步骤 2** 用宿主提供的网页搜索工具逐条搜索返回的 `queries`（每条 5–8 个结果），
把每条结果的 `title` / `url` / `snippet` / `date` 原样记录，保存为 JSON 数组：

```json
[{ "title": "...", "url": "https://...", "snippet": "...", "date": "2026-10-29" }]
```

**步骤 3** 分类打分：

```bash
node skills/fund-trading/scripts/news.mjs scan 161725 --input <结果JSON> --json
```

**步骤 4** 向用户汇报：

- 立场（risk / hot / mixed / neutral）、置信度、雷点分与热点分
- 命中的证据标题 + 链接（至少列 3 条）
- 结构性问题（规模、申赎状态、经理任职、成立时间）
- 明确说明这是**关键词启发式结论，不构成投资建议**

搜索无结果或失败时：如实说明，不要编造标题、链接或日期；此时买入会被脚本拦截（退出码 3）。

### 1. 查询行情

```bash
node skills/fund-trading/scripts/fund.mjs search 白酒 --json
node skills/fund-trading/scripts/fund.mjs quote 161725 --json
node skills/fund-trading/scripts/fund.mjs nav 161725 --pages 2 --json
```

### 2. 买入跟单（主流程）

```bash
# 前置：完成第 0 步的资讯扫描
node skills/fund-trading/scripts/order.mjs new --side buy --code 161725 --amount 10000 --json
# 把 instructions 指令单完整展示给用户，等用户去平台手动下单
# 用户回报后：
node skills/fund-trading/scripts/order.mjs fill <指令ID> --nav 0.5964 --json
node skills/fund-trading/scripts/paper.mjs status --json
```

- 资讯结论为 `risk` 时**不得买入**，向用户说明雷点证据，建议观望或减仓。
- 资讯结论过期（> 24h）时先重新扫描，不要用旧结论下单。
- `--skip-news` 仅在用户明确要求跳过时使用，并在回复中标注"未做资讯校验"。

### 3. 卖出跟单

```bash
node skills/fund-trading/scripts/order.mjs new --side sell --code 161725 --shares 5000 --json
node skills/fund-trading/scripts/order.mjs fill <指令ID> --nav 0.61 --json
```

- 卖出不强制资讯校验，但会附上结论；`hot` 时提示确认卖出是否必要。
- 最短持有：场外买入当日与次日不可赎回（默认 2 天），场内 T+1；不足会拦截。
- 赎回费按持有天数分档（<7 天 1.5%，<30 天 0.5%，<365 天 0.1%，否则 0），从确认日起算，要提醒。

### 4. 指令整理

```bash
node skills/fund-trading/scripts/order.mjs list --status pending --json
node skills/fund-trading/scripts/order.mjs expire --days 1 --json
```

场外基金 T 日 15:00 前提交按当日净值成交；过期指令先确认再取消。

### 5. 每日巡检

```bash
node skills/fund-trading/scripts/paper.mjs status --json
node skills/fund-trading/scripts/risk.mjs alerts --json
node skills/fund-trading/scripts/risk.mjs exposure --json
node skills/fund-trading/scripts/paper.mjs snapshot --json
```

按「总资产 → 持仓明细 → 风险提示 → 待执行指令 → 资讯变化 → 建议动作」组织回复。

### 6. 调仓跟单

```bash
node skills/fund-trading/scripts/risk.mjs rebalance --targets "510300:0.4,161725:0.3" --json
```

对每个结果逐条走「资讯扫描 → order new」，不要批量生成。

## 必须遵守的规则

1. **模拟盘身份**：始终说明指令是模拟计划，需用户自己到平台执行，不构成投资建议。
2. **不自动成交**：只有用户明确回报"已执行"后才 `order fill` / `paper buy/sell`。
3. **买入前必须有资讯结论**：先 `news.mjs profile → 网页搜索工具 → scan`，再 `order new`。
4. **不编造资讯**：搜索结果的标题、链接、日期必须来自真实返回；失败就报告失败。
5. **不绕过拦截**：风控（退出码 2）和资讯雷点（退出码 2）都不许强行下单。
6. **结论要标注局限**：关键词启发式、摘要级、未核实真伪、置信度低时提示风险。
7. **引用来源**：汇报资讯结论时附证据标题与链接。
8. **金额单位**：人民币元；份额 2 位小数；净值以接口返回为准。

## 数据源

| 数据 | 来源 |
| --- | --- |
| 场外净值/涨跌 | 腾讯 `qt.gtimg.cn`（备：新浪） |
| 场内 ETF 实时价 | 东财 push2 |
| 历史净值 | `api.fund.eastmoney.com/f10/lsjz` |
| 基金列表/检索 | `fundcode_search.js` |
| 基金档案/经理/规模/申赎状态 | `fundf10.eastmoney.com/jjjl_<code>.html` |
| 重仓股 | `FundArchivesDatas.aspx?type=jjcc` |
| 新闻公告 | 宿主提供的网页搜索工具 |

缓存：行情 30 秒、历史净值 1 小时、基金列表 1 天、基金档案 6 小时。

## 输出与错误约定

- 成功：JSON 含 `ok: true`。
- 失败：stderr 输出 `{"ok":false,"error":"..."}`。
- 退出码：
  - `2` — 风控拦截 / 资讯雷点占优
  - `3` — 缺少或过期的资讯扫描（买入）
  - `4` — `news.mjs verdict` 结论已过期
- 指令状态：`PENDING` / `FILLED` / `CANCELLED` / `EXPIRED`。

## 排障

- 行情全失败 → 跑 `doctor` 检查网络。
- 档案解析为空 → 换 `fund.mjs search` 确认代码；档案页改版会导致部分字段为 `-`（不会编造）。
- 搜索无结果 → 换更短的关键词（基金名 + 板块名），或加 `site:fund.eastmoney.com`。
- `order new` 退出码 3 → 先完成资讯扫描，或用户明确同意后加 `--skip-news`。
- `order new` 退出码 2 → 查看返回的违规项 / 雷点证据。
- 中文乱码 → 脚本已 `chcp 65001`；管道 JSON 不受影响。

详细说明见：

- `references/data-sources.md` — 行情接口字段与限制
- `references/news-classification.md` — 雷点/热点关键词、打分与局限
- `references/risk-rules.md` — 风控参数与规则
