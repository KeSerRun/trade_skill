<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { store, loadState, money, pct, signed } from "../store";
import { api } from "../api";

const palette = ["#4f6ef7", "#0ea5a4", "#8b5cf6", "#f59e0b", "#ef4444", "#14b8a6"];

const otcCount = computed(() => store.positions.filter((item) => item.market === "otc").length);
const exchangeCount = computed(() => store.positions.filter((item) => item.market === "exchange").length);

const segments = computed(() => {
  const items = (store.positions ?? []).map((position, index) => ({
    name: position.name || position.code,
    value: position.weight || 0,
    color: palette[index % palette.length],
  }));
  const cash = store.summary?.cashPct || 0;
  if (cash > 0.0001) items.push({ name: "现金", value: cash, color: "#e2e8f0" });
  let acc = 0;
  const stops = items.map((item) => {
    const start = acc * 100;
    acc += item.value;
    return `${item.color} ${start}% ${Math.min(100, acc * 100)}%`;
  });
  return { items, background: stops.length ? `conic-gradient(${stops.join(", ")})` : "#eef1f7" };
});

const stats = computed(() => {
  const summary = store.summary;
  return [
    {
      label: "总资产",
      value: `¥${money(summary?.equity)}`,
      sub: `累计 ${signed(summary?.totalPnl ?? 0)}`,
      icon: "TrendCharts",
      tone: "indigo",
    },
    {
      label: "可用现金",
      value: `¥${money(summary?.cash)}`,
      sub: `占比 ${pct(summary?.cashPct)}`,
      icon: "Wallet",
      tone: "teal",
    },
    {
      label: "持仓市值",
      value: `¥${money(summary?.positionValue)}`,
      sub: `仓位 ${pct(summary?.investedPct)}`,
      icon: "PieChart",
      tone: "violet",
    },
    {
      label: "累计盈亏",
      value: signed(summary?.totalPnl ?? 0),
      sub: pct(summary?.totalPnlPct),
      icon: "DataLine",
      tone: (summary?.totalPnl ?? 0) >= 0 ? "green" : "red",
    },
  ];
});

const periodStats = computed(() => {
  const summary = store.summary;
  return [
    {
      label: "日盈亏",
      key: "day",
      value: signed(summary?.dayPnl ?? 0),
      pct: pct(summary?.dayPnlPct),
      base: summary?.dayBaseDate ? `较 ${summary.dayBaseDate}` : "较初始资金",
      tone: (summary?.dayPnl ?? 0) >= 0 ? "positive" : "negative",
    },
    {
      label: "月盈亏",
      key: "month",
      value: signed(summary?.monthPnl ?? 0),
      pct: pct(summary?.monthPnlPct),
      base: summary?.monthBaseDate ? `较 ${summary.monthBaseDate}` : "较初始资金",
      tone: (summary?.monthPnl ?? 0) >= 0 ? "positive" : "negative",
    },
    {
      label: "年盈亏",
      key: "year",
      value: signed(summary?.yearPnl ?? 0),
      pct: pct(summary?.yearPnlPct),
      base: summary?.yearBaseDate ? `较 ${summary.yearBaseDate}` : "较初始资金",
      tone: (summary?.yearPnl ?? 0) >= 0 ? "positive" : "negative",
    },
  ];
});

const pnlDialogVisible = ref(false);
const pnlLoading = ref(false);
const pnlPeriod = ref("daily");
const pnlData = ref({ daily: [], monthly: [], yearly: [] });
const pnlTabs = [
  { key: "daily", label: "日" },
  { key: "monthly", label: "月" },
  { key: "yearly", label: "年" },
];
const pnlItems = computed(() => pnlData.value[pnlPeriod.value] ?? []);
const pnlMax = computed(() => Math.max(1, ...pnlItems.value.map((item) => Math.abs(item.value))));
const pnlPeriodLabel = computed(() => ({ daily: "每日盈亏", monthly: "每月盈亏", yearly: "每年盈亏" })[pnlPeriod.value]);

function barStyle(item) {
  const height = Math.max(1, (Math.abs(item.value) / pnlMax.value) * 48);
  return {
    height: `${height}%`,
    [item.value >= 0 ? "bottom" : "top"]: "50%",
  };
}

async function openPnlDetail(period) {
  pnlPeriod.value = ({ day: "daily", month: "monthly", year: "yearly" })[period] ?? "daily";
  pnlDialogVisible.value = true;
  pnlLoading.value = true;
  try {
    pnlData.value = await api.pnl();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    pnlLoading.value = false;
  }
}

let refreshTimer = null;

onMounted(() => {
  loadState();
  window.addEventListener("focus", loadState);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !store.loading) loadState();
  }, 30000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  window.removeEventListener("focus", loadState);
});
</script>

<template>
  <div class="page">
    <div class="stat-grid">
      <div v-for="stat in stats" :key="stat.label" class="stat-card" :class="`tone-${stat.tone}`">
        <div class="stat-icon">
          <el-icon><component :is="stat.icon" /></el-icon>
        </div>
        <div>
          <div class="stat-label">{{ stat.label }}</div>
          <div class="stat-value">{{ stat.value }}</div>
          <div class="stat-sub">{{ stat.sub }}</div>
        </div>
      </div>
    </div>

    <section class="panel period-panel">
      <div class="panel-head">
        <div>
          <h3>盈亏统计</h3>
          <p>按每日总资产快照计算；没有历史快照时以初始资金为基线</p>
        </div>
      </div>
      <div class="panel-body period-grid">
        <div v-for="item in periodStats" :key="item.label" class="period-card">
          <div class="period-card-head">
            <div class="period-label">{{ item.label }}</div>
            <button type="button" class="period-more" @click="openPnlDetail(item.key)">详情</button>
          </div>
          <strong class="period-value" :class="item.tone">{{ item.value }}</strong>
          <div class="period-meta">
            <span>{{ item.pct }}</span>
            <span>{{ item.base }}</span>
          </div>
        </div>
      </div>
    </section>

    <div class="main-grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>持仓概览</h3>
            <p>共 {{ store.positions.length }} 只 · 场外 {{ otcCount }} / 场内 {{ exchangeCount }}</p>
          </div>
          <span class="pill">{{ pct(store.summary?.investedPct) }} 仓位</span>
        </div>
        <div class="panel-body no-pad">
          <el-table :data="store.positions" size="small" stripe>
            <el-table-column prop="code" label="代码" width="90" />
            <el-table-column prop="name" label="名称" min-width="170" show-overflow-tooltip />
            <el-table-column label="市场" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.market === 'otc' ? 'warning' : 'success'">
                  {{ row.market === "otc" ? "场外" : "场内" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="份额" width="110" align="right">
              <template #default="{ row }">{{ money(row.shares) }}</template>
            </el-table-column>
            <el-table-column label="成本价" width="100" align="right">
              <template #default="{ row }">{{ row.avg_cost }}</template>
            </el-table-column>
            <el-table-column label="最新净值" width="100" align="right">
              <template #default="{ row }">{{ row.last_nav ?? "-" }}</template>
            </el-table-column>
            <el-table-column label="市值" width="120" align="right">
              <template #default="{ row }">¥{{ money(row.marketValue) }}</template>
            </el-table-column>
            <el-table-column label="浮盈" width="120" align="right">
              <template #default="{ row }">
                <span :class="row.pnl >= 0 ? 'positive' : 'negative'">{{ signed(row.pnl) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="占比" width="90" align="right">
              <template #default="{ row }">{{ pct(row.weight) }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!store.positions.length" description="当前空仓" :image-size="90" />
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h3>仓位分布</h3>
            <p>现金与各持仓占总资产比例</p>
          </div>
        </div>
        <div class="panel-body">
          <div class="donut-wrap">
            <div class="donut" :style="{ background: segments.background }">
              <div class="donut-center">
                <strong>{{ pct(store.summary?.investedPct) }}</strong>
                <span>仓位</span>
              </div>
            </div>
          </div>
          <div class="legend">
            <div v-for="item in segments.items" :key="item.name" class="legend-row">
              <span class="dot" :style="{ background: item.color }"></span>
              <span class="legend-name">{{ item.name }}</span>
              <span class="legend-value">{{ pct(item.value) }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div class="tip-row">
      <span class="tip-chip">场外 T+2 · 7 日内赎回 1.5%</span>
      <span class="tip-chip">14:30 操作 · 15:30 收盘更新</span>
      <span class="tip-chip">数据源 SQLite 单库</span>
    </div>

    <el-dialog
      v-model="pnlDialogVisible"
      title="盈亏详情"
      class="pnl-dialog"
      width="min(820px, 92vw)"
    >
      <div class="pnl-dialog-body" v-loading="pnlLoading">
        <div class="pnl-tabs">
          <button
            v-for="tab in pnlTabs"
            :key="tab.key"
            type="button"
            :class="{ active: pnlPeriod === tab.key }"
            @click="pnlPeriod = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>

        <div class="pnl-chart-head">
          <div>
            <strong>{{ pnlPeriodLabel }}</strong>
            <span>共 {{ pnlItems.length }} 个周期</span>
          </div>
          <span>当前总资产 ¥{{ money(pnlData.currentEquity) }}</span>
        </div>

        <div v-if="pnlItems.length" class="pnl-chart">
          <div class="pnl-bars">
            <div
              v-for="item in pnlItems"
              :key="item.key"
              class="pnl-bar-col"
              :title="`${item.label}  ${signed(item.value)}  ${pct(item.pct)}`"
            >
              <div class="pnl-bar-track">
                <div
                  class="pnl-bar"
                  :class="item.value >= 0 ? 'up' : 'down'"
                  :style="barStyle(item)"
                ></div>
              </div>
              <span class="pnl-bar-label">{{ item.label }}</span>
            </div>
          </div>
        </div>
        <el-empty v-else description="还没有盈亏快照" :image-size="80" />

        <el-table :data="pnlItems" size="small" max-height="220" class="pnl-table">
          <el-table-column prop="label" label="周期" width="110" />
          <el-table-column label="盈亏" width="120" align="right">
            <template #default="{ row }">
              <span :class="row.value >= 0 ? 'positive' : 'negative'">{{ signed(row.value) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="收益率" width="100" align="right">
            <template #default="{ row }">
              <span :class="row.value >= 0 ? 'positive' : 'negative'">{{ pct(row.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="期末总资产" min-width="120" align="right">
            <template #default="{ row }">¥{{ money(row.equity) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>
