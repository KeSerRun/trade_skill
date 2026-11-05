<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const snapshot = ref({ quotes: [], session: "closed", at: null, error: null });
const loading = ref(false);
const selectedCode = ref("");
const trend = ref(null);
const trendLoading = ref(false);
const filter = ref("all");

let source = null;
let trendTimer = null;

const filters = [
  { label: "全部", value: "all" },
  { label: "指数", value: "index" },
  { label: "场内 ETF", value: "exchange" },
  { label: "场外对标", value: "otc" },
];

const sessionLabels = {
  trading: "交易中",
  preopen: "集合竞价",
  lunch: "午休",
  closed: "已收盘",
};
const sourceLabels = {
  eastmoney: "东方财富",
  tencent: "腾讯行情",
};

const quotes = computed(() => snapshot.value.quotes ?? []);
const selectedQuote = computed(() => quotes.value.find((item) => item.code === selectedCode.value) ?? null);
const sessionLabel = computed(() => sessionLabels[snapshot.value.session] ?? "已收盘");
const sessionActive = computed(() => snapshot.value.session === "trading");
const updatedLabel = computed(() => formatTime(snapshot.value.at));
const sourceLabel = computed(() => {
  const names = [...new Set(quotes.value.map((item) => sourceLabels[item.source] ?? item.source))];
  return names.length ? names.join(" / ") : "东方财富";
});
const filterCounts = computed(() => ({
  all: quotes.value.length,
  index: quotes.value.filter((item) => (item.groups ?? [item.group]).includes("index")).length,
  exchange: quotes.value.filter((item) => (item.groups ?? [item.group]).includes("exchange")).length,
  otc: quotes.value.filter((item) => (item.groups ?? [item.group]).includes("otc")).length,
}));
const visibleQuotes = computed(() =>
  filter.value === "all"
    ? quotes.value
    : quotes.value.filter((item) => (item.groups ?? [item.group]).includes(filter.value)),
);

const chart = computed(() => {
  const data = trend.value;
  const points = data?.points ?? [];
  const empty = {
    W: 860,
    H: 280,
    P: 18,
    points: [],
    line: "",
    area: "",
    ticks: [],
    preY: null,
    lastX: 0,
    lastY: 0,
    color: "#ef4444",
  };
  if (!points.length) return empty;

  const width = 860;
  const height = 280;
  const pad = 18;
  const preClose = data.preClose ?? points[0].price;
  const prices = points.map((point) => point.price);
  const high = Math.max(...prices, preClose);
  const low = Math.min(...prices, preClose);
  const spread = Math.max((high - low) * 0.12, Math.abs(high) * 0.001, 0.0001);
  const min = low - spread;
  const max = high + spread;
  const x = (index) =>
    pad + (points.length === 1 ? 0 : (index / (points.length - 1)) * (width - pad * 2));
  const y = (value) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.price).toFixed(1)}`)
    .join(" ");
  const last = points.at(-1);
  const lastX = x(points.length - 1);
  const lastY = y(last.price);
  const area = `${line} L${lastX.toFixed(1)},${height - pad} L${pad},${height - pad} Z`;

  return {
    W: width,
    H: height,
    P: pad,
    points,
    line,
    area,
    ticks: [0, 0.5, 1].map((ratio) => ({ y: pad + ratio * (height - pad * 2) })),
    preY: y(preClose),
    lastX,
    lastY,
    color: last.price >= preClose ? "#ef4444" : "#16a34a",
  };
});

const trendStats = computed(() => {
  const data = trend.value;
  const points = data?.points ?? [];
  if (!points.length) return [];
  const last = points.at(-1);
  const high = Math.max(...points.map((point) => point.high ?? point.price));
  const low = Math.min(...points.map((point) => point.low ?? point.price));
  const decimals = data.decimals ?? 3;
  return [
    { label: "最高", value: formatPriceValue(high, decimals) },
    { label: "最低", value: formatPriceValue(low, decimals) },
    { label: "均价", value: formatPriceValue(last.avg, decimals) },
    { label: "成交额", value: formatAmount(last.amount) },
  ];
});

function parseDate(value) {
  if (!value) return null;
  if (/^\d{14}$/.test(String(value))) {
    const text = String(value);
    const date = new Date(
      `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = parseDate(value);
  if (!date) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatPriceValue(value, decimals = 3) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(decimals);
}

function formatPrice(quote) {
  return formatPriceValue(quote?.price, quote?.decimals ?? (quote?.kind === "index" ? 2 : 3));
}

function formatChange(value, quote) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(quote?.decimals ?? 3)}`;
}

function formatPct(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatAmount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (number >= 1e8) return `${(number / 1e8).toFixed(2)} 亿`;
  if (number >= 1e4) return `${(number / 1e4).toFixed(1)} 万`;
  return number.toFixed(0);
}

function trendClass(value) {
  if (value === null || value === undefined) return "muted";
  return Number(value) >= 0 ? "up" : "down";
}

function groupLabel(quote) {
  if (quote.group === "index") return "指数";
  const labels = [];
  if ((quote.groups ?? [quote.group]).includes("exchange")) labels.push("场内 ETF");
  if ((quote.groups ?? [quote.group]).includes("otc")) labels.push("场外对标");
  return labels.join(" · ");
}

function applySnapshot(data) {
  if (!data) return;
  snapshot.value = { ...snapshot.value, ...data };
  const nextQuotes = data.quotes ?? [];
  if (nextQuotes.length === 0) return;
  const exists = nextQuotes.some((item) => item.code === selectedCode.value);
  if (!selectedCode.value || !exists) {
    selectedCode.value = nextQuotes[0].code;
    loadTrend(selectedCode.value);
  }
}

async function loadSnapshot() {
  loading.value = true;
  try {
    const data = await api.marketSnapshot();
    applySnapshot(data);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function loadTrend(code, silent = false) {
  if (!code) return;
  if (!silent) trendLoading.value = true;
  try {
    const data = await api.marketTrend(code);
    if (selectedCode.value === code) trend.value = data;
  } catch (error) {
    if (!silent) ElMessage.error(error.message);
  } finally {
    if (!silent) trendLoading.value = false;
  }
}

function selectQuote(quote) {
  if (selectedCode.value === quote.code) {
    loadTrend(quote.code);
    return;
  }
  selectedCode.value = quote.code;
  loadTrend(quote.code);
}

function connect() {
  if (source) source.close();
  source = new EventSource("/api/market/stream");
  source.addEventListener("snapshot", (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
    } catch {
      // ignore malformed frames
    }
  });
}

onMounted(() => {
  loadSnapshot();
  connect();
  trendTimer = setInterval(() => {
    if (selectedCode.value) loadTrend(selectedCode.value, true);
  }, 30000);
});

onUnmounted(() => {
  if (source) source.close();
  if (trendTimer) clearInterval(trendTimer);
});
</script>

<template>
  <div class="page market-page" v-loading="loading && quotes.length === 0">
    <section class="market-summary">
      <div>
        <span class="market-eyebrow">免费行情</span>
        <h2>场内 ETF 与指数</h2>
        <p>东方财富公开行情 · 交易时段每 3 秒刷新 · 场外为对标 ETF，不是实时净值</p>
      </div>
      <div class="market-summary-right">
        <span class="session-pill" :class="{ on: sessionActive }">
          <span class="session-dot"></span>
          {{ sessionLabel }}
        </span>
        <span class="market-updated">更新 {{ updatedLabel }}</span>
        <el-button plain :loading="loading" @click="loadSnapshot">刷新</el-button>
      </div>
    </section>

    <section class="panel trend-panel">
      <div class="panel-head trend-head">
        <div>
          <div class="trend-title">
            <h3>{{ selectedQuote?.name || "选择标的" }}</h3>
            <span class="mono">{{ selectedCode || "—" }}</span>
            <el-tag v-if="selectedQuote?.groups?.includes('otc')" size="small" effect="plain">场外对标</el-tag>
          </div>
          <p>{{ trend?.points?.length ? `分时走势 · ${trend.points.length} 个点` : "分时走势" }}</p>
        </div>
        <div v-if="selectedQuote" class="trend-price">
          <strong :class="trendClass(selectedQuote.changePct)">{{ formatPrice(selectedQuote) }}</strong>
          <span :class="trendClass(selectedQuote.changePct)">{{ formatPct(selectedQuote.changePct) }}</span>
          <span class="trend-change">{{ formatChange(selectedQuote.change, selectedQuote) }}</span>
        </div>
      </div>
      <div class="panel-body">
        <div v-if="trendLoading" class="trend-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
          加载分时数据
        </div>
        <template v-else-if="chart.points.length">
          <div class="trend-wrap">
            <svg class="trend-svg" :viewBox="`0 0 ${chart.W} ${chart.H}`" preserveAspectRatio="none">
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" :stop-color="chart.color" stop-opacity="0.18" />
                  <stop offset="100%" :stop-color="chart.color" stop-opacity="0" />
                </linearGradient>
              </defs>
              <line
                v-for="(tick, index) in chart.ticks"
                :key="index"
                :x1="chart.P"
                :x2="chart.W - chart.P"
                :y1="tick.y"
                :y2="tick.y"
                class="trend-grid"
              />
              <line
                v-if="chart.preY !== null"
                :x1="chart.P"
                :x2="chart.W - chart.P"
                :y1="chart.preY"
                :y2="chart.preY"
                class="trend-baseline"
              />
              <path :d="chart.area" fill="url(#trendFill)" />
              <path :d="chart.line" fill="none" :stroke="chart.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
              <circle :cx="chart.lastX" :cy="chart.lastY" r="3.5" :fill="chart.color" />
            </svg>
            <div class="trend-axis">
              <span>09:30</span>
              <span>11:30 / 13:00</span>
              <span>15:00</span>
            </div>
            <div class="trend-stats">
              <div v-for="item in trendStats" :key="item.label">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
            </div>
          </div>
        </template>
        <el-empty v-else description="暂无分时数据" :image-size="80" />
      </div>
    </section>

    <section class="market-list">
      <div class="market-list-head">
        <div>
          <h3>关注标的</h3>
          <p>{{ quotes.length }} 个标的 · {{ sourceLabel }}</p>
        </div>
        <div class="quote-filters">
          <button
            v-for="item in filters"
            :key="item.value"
            type="button"
            :class="{ active: filter === item.value }"
            @click="filter = item.value"
          >
            {{ item.label }}
            <span>{{ filterCounts[item.value] }}</span>
          </button>
        </div>
      </div>

      <div v-if="visibleQuotes.length" class="quote-grid">
        <button
          v-for="quote in visibleQuotes"
          :key="quote.code"
          type="button"
          class="quote-card"
          :class="{ active: selectedCode === quote.code }"
          @click="selectQuote(quote)"
        >
          <div class="quote-head">
            <strong>{{ quote.name }}</strong>
            <span class="mono">{{ quote.code }}</span>
          </div>
          <div class="quote-price" :class="trendClass(quote.changePct)">{{ formatPrice(quote) }}</div>
          <div class="quote-change" :class="trendClass(quote.changePct)">
            <span>{{ formatChange(quote.change, quote) }}</span>
            <span>{{ formatPct(quote.changePct) }}</span>
          </div>
          <div class="quote-meta">
            <span>高 {{ formatPriceValue(quote.high, quote.decimals) }}</span>
            <span>低 {{ formatPriceValue(quote.low, quote.decimals) }}</span>
          </div>
          <div class="quote-foot">
            <span>{{ formatAmount(quote.amount) }}</span>
            <span>{{ groupLabel(quote) }}</span>
          </div>
        </button>
      </div>
      <el-empty v-else description="没有行情数据" :image-size="80" />
    </section>
  </div>
</template>

<style scoped>
.market-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.market-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background:
    linear-gradient(120deg, rgba(79, 110, 247, 0.1), rgba(14, 165, 164, 0.06) 46%, rgba(255, 255, 255, 0) 76%),
    var(--surface);
  box-shadow: var(--shadow);
}

.market-eyebrow {
  display: inline-block;
  color: #4f6ef7;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.market-summary h2 {
  margin: 6px 0 4px;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.market-summary p {
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
}

.market-summary-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.session-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
}

.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #94a3b8;
}

.session-pill.on {
  background: #e9fbf0;
  color: var(--green);
}

.session-pill.on .session-dot {
  background: var(--green);
  box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.12);
}

.market-updated {
  color: var(--text-3);
  font-size: 11px;
}

.trend-head {
  align-items: flex-start;
}

.trend-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.trend-title h3 {
  margin: 0;
}

.trend-title .mono {
  color: var(--text-3);
  font-size: 10px;
}

.trend-price {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-shrink: 0;
}

.trend-price strong {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.trend-price span {
  font-size: 12px;
  font-weight: 600;
}

.trend-price .trend-change {
  color: var(--text-3);
  font-weight: 500;
}

.up {
  color: #ef4444;
}

.down {
  color: #16a34a;
}

.muted {
  color: var(--text-3);
}

.trend-wrap {
  padding: 10px 4px 4px;
}

.trend-svg {
  display: block;
  width: 100%;
  height: 300px;
}

.trend-grid {
  stroke: #eef1f7;
  stroke-width: 1;
}

.trend-baseline {
  stroke: #cbd5e1;
  stroke-width: 1;
  stroke-dasharray: 4 4;
}

.trend-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  color: var(--text-3);
  font-size: 10px;
}

.trend-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed #edf0f6;
}

.trend-stats div {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trend-stats span {
  color: var(--text-3);
  font-size: 10px;
}

.trend-stats strong {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.trend-loading {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-3);
  font-size: 12px;
}

.market-list-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin: 0 2px 10px;
}

.market-list-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.market-list-head p {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 11px;
}

.quote-filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.quote-filters button {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: #fff;
  color: var(--text-2);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.quote-filters button span {
  margin-left: 2px;
  color: var(--text-3);
}

.quote-filters button:hover {
  border-color: #cdd6fd;
}

.quote-filters button.active {
  border-color: #cdd6fd;
  background: #eef1ff;
  color: #3f58c6;
  font-weight: 600;
}

.quote-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}

.quote-card {
  appearance: none;
  display: block;
  width: 100%;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.quote-card:hover {
  transform: translateY(-2px);
  border-color: #cdd6fd;
}

.quote-card.active {
  border-color: #7d92f9;
  box-shadow: 0 0 0 3px rgba(79, 110, 247, 0.12);
}

.quote-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.quote-head strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quote-head span {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 10px;
}

.quote-price {
  margin-top: 10px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}

.quote-change {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.quote-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  color: var(--text-3);
  font-size: 10px;
}

.quote-foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed #edf0f6;
  color: var(--text-3);
  font-size: 10px;
}

@media (max-width: 1080px) {
  .market-summary {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }

  .market-summary-right {
    justify-content: flex-start;
  }
}

@media (max-width: 760px) {
  .trend-svg {
    height: 230px;
  }

  .trend-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .market-list-head {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .market-summary {
    padding: 18px;
  }

  .trend-price {
    flex-wrap: wrap;
  }

  .market-summary-right .el-button {
    width: 100%;
  }

  .quote-grid {
    grid-template-columns: 1fr;
  }
}
</style>
