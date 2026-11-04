<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { money, signed } from "../store";

const trades = ref([]);
const loading = ref(false);
const filters = reactive({ code: "", type: "" });

const buyCount = computed(() => trades.value.filter((item) => item.type === "BUY").length);
const sellCount = computed(() => trades.value.filter((item) => item.type === "SELL").length);
const totalFee = computed(() => trades.value.reduce((sum, item) => sum + (item.fee || 0), 0));
const realized = computed(() => trades.value.reduce((sum, item) => sum + (item.realized_pnl || 0), 0));

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (filters.code.trim()) params.set("code", filters.code.trim());
    if (filters.type) params.set("type", filters.type);
    params.set("limit", "500");
    const data = await api.trades(`?${params.toString()}`);
    trades.value = data.trades;
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="toolbar-row">
      <div class="chips">
        <div class="chip">
          <span class="chip-label">全部记录</span>
          <span class="chip-value">{{ trades.length }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">买入</span>
          <span class="chip-value">{{ buyCount }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">卖出</span>
          <span class="chip-value">{{ sellCount }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">总费用</span>
          <span class="chip-value">¥{{ money(totalFee) }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">已实现盈亏</span>
          <span class="chip-value" :class="realized >= 0 ? 'positive' : 'negative'">{{ signed(realized) }}</span>
        </div>
      </div>
      <div class="toolbar-actions">
        <el-input v-model="filters.code" class="search-input" placeholder="按基金代码筛选" clearable @keyup.enter="load">
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select v-model="filters.type" placeholder="全部方向" clearable style="width: 130px">
          <el-option label="买入" value="BUY" />
          <el-option label="卖出" value="SELL" />
        </el-select>
        <el-button type="primary" :loading="loading" @click="load">查询</el-button>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>成交明细</h3>
          <p>自动记账与手动成交，按日期倒序</p>
        </div>
        <span class="pill">共 {{ trades.length }} 条</span>
      </div>
      <div class="panel-body no-pad">
        <el-table v-loading="loading" :data="trades" size="small" stripe>
          <el-table-column prop="date" label="日期" width="110" />
          <el-table-column label="方向" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.type === 'BUY' ? 'danger' : 'success'">
                {{ row.type === "BUY" ? "买入" : "卖出" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="代码" width="90" />
          <el-table-column prop="name" label="名称" min-width="170" show-overflow-tooltip />
          <el-table-column label="份额" width="110" align="right">
            <template #default="{ row }">{{ money(row.shares) }}</template>
          </el-table-column>
          <el-table-column label="净值" width="100" align="right">
            <template #default="{ row }">{{ row.nav }}</template>
          </el-table-column>
          <el-table-column label="金额" width="120" align="right">
            <template #default="{ row }">¥{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column label="费用" width="100" align="right">
            <template #default="{ row }">¥{{ money(row.fee) }}</template>
          </el-table-column>
          <el-table-column label="实现盈亏" width="120" align="right">
            <template #default="{ row }">
              <span
                v-if="row.realized_pnl !== null && row.realized_pnl !== undefined"
                :class="row.realized_pnl >= 0 ? 'positive' : 'negative'"
              >
                {{ signed(row.realized_pnl) }}
              </span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="结算" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.settled === 1 ? 'success' : 'warning'">
                {{ row.settled === 1 ? "已结算" : "待结算" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="source" label="来源" width="80" />
          <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip />
        </el-table>
        <el-empty v-if="!loading && !trades.length" description="暂无交易记录" :image-size="90" />
      </div>
    </section>
  </div>
</template>
