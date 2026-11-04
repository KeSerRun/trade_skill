<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import { store, loadState, money, pct, signed } from "../store";

const dialogVisible = ref(false);
const accountVisible = ref(false);
const saving = ref(false);
const keyword = ref("");
const marketFilter = ref("");

const form = reactive({
  code: "",
  name: "",
  market: "otc",
  shares: 0,
  cost: 0,
  firstBuyDate: "",
  lastNav: null,
  lastNavDate: "",
});

const accountForm = reactive({ initialCash: 10000, cash: 10000, realizedPnl: 0 });

const computedAvgCost = computed(() => (form.shares > 0 ? form.cost / form.shares : 0));
const otcCount = computed(() => store.positions.filter((item) => item.market === "otc").length);
const exchangeCount = computed(() => store.positions.filter((item) => item.market === "exchange").length);
const totalCost = computed(() => store.positions.reduce((sum, item) => sum + (item.cost || 0), 0));
const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase();
  return store.positions.filter((item) => {
    const matchKey =
      !key ||
      (item.name ?? "").toLowerCase().includes(key) ||
      String(item.code).toLowerCase().includes(key);
    const matchMarket = !marketFilter.value || item.market === marketFilter.value;
    return matchKey && matchMarket;
  });
});

onMounted(loadState);

function resetForm() {
  Object.assign(form, {
    code: "",
    name: "",
    market: "otc",
    shares: 0,
    cost: 0,
    firstBuyDate: "",
    lastNav: null,
    lastNavDate: "",
  });
}

function openCreate() {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row) {
  Object.assign(form, {
    code: row.code,
    name: row.name ?? "",
    market: row.market,
    shares: row.shares,
    cost: row.cost,
    firstBuyDate: row.first_buy_date ?? "",
    lastNav: row.last_nav,
    lastNavDate: row.last_nav_date ?? "",
  });
  dialogVisible.value = true;
}

function openAccount() {
  Object.assign(accountForm, {
    initialCash: store.account?.initialCash ?? 0,
    cash: store.account?.cash ?? 0,
    realizedPnl: store.account?.realizedPnl ?? 0,
  });
  accountVisible.value = true;
}

async function savePosition() {
  if (!form.code.trim()) {
    ElMessage.warning("请填写基金代码");
    return;
  }
  if (form.shares < 0 || form.cost < 0) {
    ElMessage.warning("份额和成本不能为负数");
    return;
  }
  saving.value = true;
  try {
    await api.savePosition({
      code: form.code.trim(),
      name: form.name.trim(),
      market: form.market,
      shares: form.shares,
      cost: form.cost,
      avgCost: null,
      firstBuyDate: form.firstBuyDate || null,
      lastNav: form.lastNav || null,
      lastNavDate: form.lastNavDate || null,
    });
    await loadState();
    dialogVisible.value = false;
    ElMessage.success("持仓已保存");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.value = false;
  }
}

async function removePosition(row) {
  try {
    await ElMessageBox.confirm(`确定删除持仓 ${row.name || row.code}（${row.code}）？`, "删除持仓", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
    await api.deletePosition(row.code);
    await loadState();
    ElMessage.success("已删除");
  } catch (error) {
    if (error !== "cancel" && error?.message) ElMessage.error(error.message);
  }
}

async function saveAccount() {
  saving.value = true;
  try {
    await api.updateAccount({
      initialCash: accountForm.initialCash,
      cash: accountForm.cash,
      realizedPnl: accountForm.realizedPnl,
    });
    await loadState();
    accountVisible.value = false;
    ElMessage.success("账户已更新");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page" v-loading="store.loading">
    <div class="toolbar-row">
      <div class="chips">
        <div class="chip">
          <span class="chip-label">持仓数量</span>
          <span class="chip-value">{{ store.positions.length }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">场外</span>
          <span class="chip-value">{{ otcCount }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">场内</span>
          <span class="chip-value">{{ exchangeCount }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">总成本</span>
          <span class="chip-value">¥{{ money(totalCost) }}</span>
        </div>
      </div>
      <div class="toolbar-actions">
        <el-input v-model="keyword" class="search-input" placeholder="搜索代码 / 名称" clearable>
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select v-model="marketFilter" placeholder="全部市场" clearable style="width: 130px">
          <el-option label="场外" value="otc" />
          <el-option label="场内" value="exchange" />
        </el-select>
        <el-button @click="openAccount">账户设置</el-button>
        <el-button type="primary" @click="openCreate">新增持仓</el-button>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>持仓明细</h3>
          <p>共 {{ filtered.length }} 只 · 场外 T+2，场内 T+1</p>
        </div>
        <span class="pill">总成本 ¥{{ money(totalCost) }}</span>
      </div>
      <div class="panel-body no-pad">
        <el-table :data="filtered" size="small" stripe>
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
          <el-table-column label="成本" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.cost) }}</template>
          </el-table-column>
          <el-table-column label="成本价" width="100" align="right">
            <template #default="{ row }">{{ row.avg_cost }}</template>
          </el-table-column>
          <el-table-column label="最新净值" width="100" align="right">
            <template #default="{ row }">{{ row.last_nav ?? "-" }}</template>
          </el-table-column>
          <el-table-column label="首次买入" width="110">
            <template #default="{ row }">{{ row.first_buy_date || "-" }}</template>
          </el-table-column>
          <el-table-column label="浮盈" width="120" align="right">
            <template #default="{ row }">
              <span :class="row.pnl >= 0 ? 'positive' : 'negative'">{{ signed(row.pnl) }}</span>
              <span class="muted"> · {{ pct(row.pnlPct) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" @click="removePosition(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!filtered.length" description="没有匹配的持仓" :image-size="90" />
      </div>
    </section>

    <el-dialog v-model="dialogVisible" :title="form.code ? '编辑持仓' : '新增持仓'" width="680px">
      <el-form label-position="top">
        <div class="form-section">基础信息</div>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="基金代码" required>
              <el-input v-model="form.code" placeholder="如 006697" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基金名称">
              <el-input v-model="form.name" placeholder="如 华宝银行ETF联接C" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="市场类型">
              <el-radio-group v-model="form.market">
                <el-radio value="otc">场外（T+2，7 日内 1.5%）</el-radio>
                <el-radio value="exchange">场内（T+1）</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
        </el-row>

        <div class="form-section">持仓与净值</div>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="持有份额">
              <el-input-number v-model="form.shares" :min="0" :precision="2" :step="100" :controls="false" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="成本金额">
              <el-input-number v-model="form.cost" :min="0" :precision="2" :step="100" :controls="false" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="成本价（自动）">
              <el-input :model-value="computedAvgCost.toFixed(4)" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="首次买入日">
              <el-date-picker
                v-model="form.firstBuyDate"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="用于计算 T+2 和赎回费"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="最新净值">
              <el-input-number v-model="form.lastNav" :min="0" :precision="4" :step="0.001" :controls="false" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="净值日期">
              <el-date-picker v-model="form.lastNavDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePosition">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="accountVisible" title="账户设置" width="480px">
      <el-form label-position="top">
        <el-form-item label="初始资金">
          <el-input-number v-model="accountForm.initialCash" :min="0" :precision="2" :controls="false" />
        </el-form-item>
        <el-form-item label="可用现金">
          <el-input-number v-model="accountForm.cash" :min="0" :precision="2" :controls="false" />
        </el-form-item>
        <el-form-item label="已实现盈亏">
          <el-input-number v-model="accountForm.realizedPnl" :precision="2" :controls="false" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="accountVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveAccount">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
