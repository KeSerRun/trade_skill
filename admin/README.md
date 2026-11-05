# 基金交易台（管理后台）

本地管理台，Vue 3 + Element Plus 界面，所有交易数据只存在一个 SQLite 文件里，不再维护 JSON 副本。

## 功能

- 总览：总资产、现金、持仓市值、累计盈亏、仓位分布
- 实时行情：场内 ETF 与指数免费行情，分时 + 日 / 周 / 月 K 线，3 秒 SSE 刷新；场外基金用对标 ETF 展示
- 产品库：全市场基金与 ETF 产品表，支持搜索、分页、按当前页刷新行情和加入关注
- 持仓管理：新增/编辑/删除持仓，区分场外/场内，维护份额、成本、首次买入日、最新净值
- 交易限制：分别配置场外/场内的最短持有天数、买入费率、赎回费分档，以及组合层面的单只上限、总仓位上限、现金底线、单笔上限
- 关注列表：从产品库选择场外/场内产品，维护对标 ETF、搜索词、启用状态和排序
- 系统设置：策略参数、运行参数、推送通道与密钥
- 定时任务：查看 14:30 / 15:30 的 Windows 计划任务状态、下次运行、上次结果，支持改时间、启停和立即运行；可在场外 / 场内之间切换下一次任务的关注列表
- 交易记录：查看自动/手动成交，含结算状态

## 实时行情

- 数据源：东方财富公开行情，腾讯行情兜底
- 产品库数据来自东方财富基金代码表，点击「同步产品库」更新；搜索和分页在服务端完成
- 关注列表只能从产品库添加，后端会校验产品是否存在；产品库的「加入关注」走同一套校验
- 交易时段每 3 秒通过 SSE 推送，非交易时段降频
- 场内 ETF 显示实时价格、分时走势和日 / 周 / 月 K 线；产品库的场外基金显示最新净值，实时行情页的场外基金用对标 ETF 展示，不代表实时净值
- 免费公开接口没有 SLA，仅作参考，不构成投资建议

## 单一数据源

- SQLite：`../.fund-trading/fund.db`
- 账户、持仓、成交、指令、交易规则、净值快照、资讯结论、候选基金池、市场模式、运行参数、策略参数、推送配置全部在这个文件里
- 14:30 / 15:30 的定时任务和管理后台读写同一个数据库，不需要导入导出

## 运行

```bash
cd admin
npm install
npm run dev
```

- 前端默认：http://localhost:5173
- 局域网：`npm run dev -- --host 0.0.0.0`，然后访问 `http://<本机IP>:5173`
- API 默认：http://127.0.0.1:8787

生产模式：

```bash
npm run build
npm start                    # 默认只监听 127.0.0.1
npm start -- --host 0.0.0.0  # 局域网
```

## 局域网访问

开发模式：

```bash
npm run dev -- --host 0.0.0.0
```

Vite 监听 `0.0.0.0:5173`；API 仍只监听 `127.0.0.1:8787`，由 Vite 的 `/api` 代理转发，不需要把 API 单独暴露到局域网。

生产模式：

```bash
npm run build
npm start -- --host 0.0.0.0
```

`-- --host` 是 npm 的参数透传，后面的参数会原样交给 Vite 或 Node 服务；只给本机用时不加参数即可。

查看本机局域网 IP：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
```

放行防火墙（需要管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "Fund Admin Dev 5173" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 -Profile Private
New-NetFirewallRule -DisplayName "Fund Admin Prod 8787" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -Profile Private
```

> 后台没有登录鉴权，只建议在可信局域网开放，不要直接映射到公网。如果确实需要公网访问，请在前面加一层带认证的反向代理。

## 环境变量

- `PORT`：API 端口，默认 8787
- `HOST`：监听地址，默认 127.0.0.1
- `FUND_TRADE_DB`：SQLite 文件路径，默认 `../.fund-trading/fund.db`
- `FUND_TRADE_HOME`：状态目录，默认项目根 `.fund-trading`

## 注意

- 默认只监听本机（开发模式仅 Vite 监听 0.0.0.0）；没有登录鉴权，不要直接暴露到公网
- 管理台只管理模拟盘数据，不会连接真实账户或下单
- 交易脚本同样读取 `fund.db` 里的规则，场内/场外费率会分别生效
