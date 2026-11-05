<script setup>
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const syncing = ref(false);
const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const search = ref("");
const marketFilter = ref("all");
const watchedOnly = ref(false);
const quotes = ref({});
const counts = reactive({ all: 0, index: 0, exchange: 0, otc: 0 });

let quoteTimer = null;

const marketOptions = [
  { label: "全部", value: "all" },
  { label: "指数", value: "index" },
  { label: "场内", value: "exchange" },
  { label: "场外", value: "otc" },
];
const typeLabels = {
  index: "指数",
  etf: "ETF",
  lof: "LOF",
  exchange: "场内",
  otc: "场外",
};
const marketLabels = {
  index: "指数",
  exchange: "场内",
  otc: "场外",
};

async function load() {
  loading.value = true;
  try {
    const params = {
      market: marketFilter.value,
      watched: watchedOnly.value ? "1" : "0",
      page: page.value,
      pageSize: pageSize.value,
    };
    if (search.value.trim()) params.search = search.value.trim();
    const data = await api.products(params);
    items.value = data.items;
    total.value = data.total;
    Object.assign(counts, data.counts);
    await loadQuotes();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function loadQuotes() {
  const keys = items.value.filter((item) => item.market !== "otc").map((item) => item.key);
  if (keys.length === 0) {
    quotes.value = {};
    return;
  }
  try {
    const data = await api.marketQuotes(keys);
    quotes.value = Object.fromEntries((data.quotes ?? []).map((quote) => [quote.id ?? quote.key, quote]));
  } catch {
    // 行情失败不影响产品列表
  }
}

function quoteFor(row) {
  return quotes.value[row.key];
}

function formatPrice(quote, row) {
  if (!quote || quote.price === null || quote.price === undefined) return "—";
  const decimals = quote.decimals ?? (row.market === "index" ? 2 : 3);
  return Number(quote.price).toFixed(decimals);
}

function formatPct(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function trendClass(value) {
  if (value === null || value === undefined) return "muted";
  return Number(value) >= 0 ? "up" : "down";
}

function applySearch() {
  page.value = 1;
  load();
}

function resetFilters() {
  search.value = "";
  marketFilter.value = "all";
  watchedOnly.value = false;
  page.value = 1;
  load();
}

function onFilterChange() {
  page.value = 1;
  load();
}

async function syncProducts() {
  syncing.value = true;
  try {
    const data = await api.syncProducts();
    ElMessage.success(`已同步 ${data.changed} 个产品`);
    page.value = 1;
    await load();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    syncing.value = false;
  }
}

async function toggleWatch(row) {
  if (row.market === "index") return;
  try {
    if (row.watched) {
      await api.deleteWatchlist(row.market, row.code);
      row.watched = false;
      ElMessage.success("已取消关注");
      if (watchedOnly.value) await load();
    } else {
      await api.saveWatchlist({
        market: row.market,
        code: row.code,
        name: row.name,
        benchmark: row.benchmark ?? null,
        sector: row.sector ?? null,
        queries: [],
        enabled: true,
        sortOrder: 0,
      });
      row.watched = true;
      ElMessage.success("已加入关注");
    }
  } catch (error) {
    ElMessage.error(error.message);
  }
}

onMounted(() => {
  load();
  quoteTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadQuotes();
  }, 5000);
});

onUnmounted(() => {
  if (quoteTimer) clearInterval(quoteTimer);
});
</script>

<template>
  <div class="page products-page" v-loading="loading">
    <section class="products-overview">
      <div>
        <span class="products-eyebrow">全量产品</span>
        <h2>基金与 ETF 产品库</h2>
        <p>全市场产品元数据 · 当前页行情按需刷新 · 场外基金不显示实时价格</p>
      </div>
      <el-button plain :loading="syncing" @click="syncProducts">同步产品库</el-button>
    </section>

    <div class="product-counts">
      <div v-for="item in [
        { label: '全部', value: counts.all, key: 'all' },
        { label: '指数', value: counts.index, key: 'index' },
        { label: '场内', value: counts.exchange, key: 'exchange' },
        { label: '场外', value: counts.otc, key: 'otc' },
      ]" :key="item.key" class="product-count">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </div>
    </div>

    <section class="panel">
      <div class="panel-body">
        <div class="product-toolbar">
          <el-input
            v-model="search"
            class="product-search"
            clearable
            placeholder="搜索代码或名称"
            @keyup.enter="applySearch"
            @clear="applySearch"
          />
          <el-select v-model="marketFilter" class="product-market" @change="onFilterChange">
            <el-option v-for="item in marketOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-switch v-model="watchedOnly" active-text="只看已关注" @change="onFilterChange" />
          <el-button type="primary" @click="applySearch">搜索</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </div>

        <el-empty
          v-if="!items.length && !loading"
          :description="counts.all ? '没有匹配的产品' : '产品库为空，先点击右上角同步产品库'"
          :image-size="80"
        />
        <template v-else>
          <el-table :data="items" row-key="key" max-height="640">
            <el-table-column prop="code" label="代码" width="100" />
            <el-table-column prop="name" label="名称" min-width="220" show-overflow-tooltip />
            <el-table-column label="基金类型" width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.category || typeLabels[row.type] || row.type }}</template>
            </el-table-column>
            <el-table-column label="市场" width="80">
              <template #default="{ row }">{{ marketLabels[row.market] ?? row.market }}</template>
            </el-table-column>
            <el-table-column label="最新价" width="100">
              <template #default="{ row }">
                <span v-if="quoteFor(row)?.price != null" :class="trendClass(quoteFor(row)?.changePct)">
                  {{ formatPrice(quoteFor(row), row) }}
                </span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="涨跌幅" width="100">
              <template #default="{ row }">
                <span v-if="quoteFor(row)?.changePct != null" :class="trendClass(quoteFor(row)?.changePct)">
                  {{ formatPct(quoteFor(row)?.changePct) }}
                </span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="关注" width="80">
              <template #default="{ row }">
                <el-tag v-if="row.watched" size="small" type="success">已关注</el-tag>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.market !== 'index'"
                  link
                  :type="row.watched ? 'danger' : 'primary'"
                  @click="toggleWatch(row)"
                >
                  {{ row.watched ? "取消关注" : "加入关注" }}
                </el-button>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="product-pagination">
            <el-pagination
              v-model:current-page="page"
              v-model:page-size="pageSize"
              :total="total"
              :page-sizes="[20, 50, 100]"
              layout="total, sizes, prev, pager, next"
              @current-change="load"
              @size-change="onFilterChange"
            />
          </div>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.products-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.products-overview {
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

.products-eyebrow {
  display: inline-block;
  color: #4f6ef7;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.products-overview h2 {
  margin: 6px 0 4px;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.products-overview p {
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
}

.product-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.product-count {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.product-count span {
  color: var(--text-3);
  font-size: 10px;
}

.product-count strong {
  font-size: 14px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.product-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}

.product-search {
  width: 240px;
}

.product-market {
  width: 110px;
}

.product-pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.up {
  color: #ef4444;
  font-weight: 600;
}

.down {
  color: #16a34a;
  font-weight: 600;
}

.muted {
  color: var(--text-3);
  font-size: 12px;
}

@media (max-width: 640px) {
  .products-overview {
    align-items: flex-start;
    flex-direction: column;
    padding: 18px;
  }

  .products-overview .el-button {
    width: 100%;
  }

  .product-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .product-search,
  .product-market {
    width: 100%;
  }

  .product-pagination {
    justify-content: center;
    overflow-x: auto;
  }
}
</style>
