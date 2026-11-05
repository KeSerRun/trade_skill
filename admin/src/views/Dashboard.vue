<script setup>
import { computed, onMounted, onUnmounted } from "vue";
import { store, loadState, money, pct, signed } from "../store";

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
  </div>
</template>
