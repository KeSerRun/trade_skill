# 数据源说明

所有接口均为公开页面数据，无需鉴权。脚本已内置重试、超时（15s）与 GBK 解码。

## 1. 基金列表与检索

- URL: `https://fund.eastmoney.com/js/fundcode_search.js`
- 返回 JS 变量 `var r = [["000001","HXCZHH","华夏成长混合","混合型-灵活","HUAXIACHENGZHANGHUNHE"], ...]`
- 字段: 代码 / 拼音缩写 / 名称 / 类型 / 全拼
- 缓存: `cache/fund-list.json`，1 天

## 2. 场外基金最新净值（腾讯）

- URL: `https://qt.gtimg.cn/q=jj<code>`
- 编码: GBK，`~` 分隔
- 字段索引: `0`代码 `1`名称 `5`单位净值 `6`累计净值 `7`日涨跌幅(%) `8`日期
- 注意: 净值 0 或缺失表示无数据

## 3. 场外基金最新净值（新浪，备用）

- URL: `https://hq.sinajs.cn/list=f_<code>`
- 需要 `Referer: https://finance.sina.com.cn`
- 编码: GBK，`,` 分隔
- 字段: `0`名称 `1`单位净值 `2`累计净值 `3`前一日净值 `4`日期

## 4. 场内 ETF / LOF 实时行情（东财 push2）

- URL: `https://push2.eastmoney.com/api/qt/stock/get?secid=<market>.<code>&fields=f43,f57,f58,f59,f60,f169,f170,f86`
- market: `1` 沪市（代码 5/6 开头），`0` 深市
- 字段:
  - `f43` 最新价（需除以 `10^f59`）
  - `f59` 小数位数
  - `f60` 昨收（同缩放）
  - `f57` 代码，`f58` 名称
  - `f169` 涨跌额（同缩放），`f170` 涨跌幅（除以 100）
  - `f86` 时间戳（秒）
- 停牌时数值可能为 `"-"`

## 5. 历史净值（东财）

- URL: `https://api.fund.eastmoney.com/f10/lsjz?fundCode=<code>&pageIndex=1&pageSize=20`
- 需要 `Referer: https://fundf10.eastmoney.com/jjjz_<code>.html`
- 字段: `Data.LSJZList[]` 内 `FSRQ` 日期 / `DWJZ` 单位净值 / `LJJZ` 累计净值 / `JZZZL` 日涨跌幅(%)
- 缓存: `cache/nav-<code>-<pages>-<pageSize>.json`，1 小时

## 已知限制

- 场外基金没有权威的盘中实时估值接口（东财 `fundgz` 端点已失效），因此：
  - 场外交易以「最新已公布净值」为成交价；
  - 盘中只能看到 T-1 净值与当日涨跌幅，不能当作实时估值。
- 数据以页面公开口径为准，可能与基金公司公告存在小幅差异。
- 接口可能变更；失效时先跑 `doctor` 定位是哪一路数据源。
