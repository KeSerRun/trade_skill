<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const lists = ref({ otc: [], exchange: [] });
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editing = ref(false);
const filter = ref("");

const form = reactive({
  market: "otc",
  code: "",
  name: "",
  benchmark: "",
  sector: "",
  queriesText: "",
  enabled: true,
  sortOrder: 0,
});

const allItems = computed(() => [...(lists.value.otc ?? []), ...(lists.value.exchange ?? [])]);
const items = computed(() => allItems.value.filter((item) => !filter.value || item.market === filter.value));
const otcCount = computed(() => (lists.value.otc ?? []).length);
const exchangeCount = computed(() => (lists.value.exchange ?? []).length);
const enabledCount = computed(() => allItems.value.filter((item) => item.enabled).length);

async function load() {
  loading.value = true;
  try {
    const data = await api.watchlist();
    lists.value = data.watchlists;
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openCreate(market = "otc") {
  Object.assign(form, {
    market,
    code: "",
    name: "",
    benchmark: "",
    sector: "",
    queriesText: "",
    enabled: true,
    sortOrder: 0,
  });
  editing.value = false;
  dialogVisible.value = true;
}

function openEdit(row) {
  Object.assign(form, {
    market: row.market,
    code: row.code,
    name: row.name ?? "",
    benchmark: row.benchmark ?? "",
    sector: row.sector ?? "",
    queriesText: (row.queries ?? []).join("\n"),
    enabled: row.enabled,
    sortOrder: row.sortOrder ?? 0,
  });
  editing.value = true;
  dialogVisible.value = true;
}

async function save() {
  if (!form.code.trim()) {
    ElMessage.warning("请填写基金代码");
    return;
  }
  saving.value = true;
  try {
    await api.saveWatchlist({
      market: form.market,
      code: form.code.trim(),
      name: form.name.trim(),
      benchmark: form.benchmark.trim(),
      sector: form.sector.trim(),
      queries: form.queriesText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      enabled: form.enabled,
      sortOrder: form.sortOrder,
    });
    await load();
    dialogVisible.value = false;
    ElMessage.success("已保存");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.value = false;
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `删除候选 ${row.name || row.code}（${row.market === "otc" ? "场外" : "场内"}）？`,
      "删除候选",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    await api.deleteWatchlist(row.market, row.code);
    await load();
    ElMessage.success("已删除");
  } catch (error) {
    if (error !== "cancel" && error?.message) ElMessage.error(error.message);
  }
}
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="toolbar-row">
      <div class="chips">
        <div class="chip">
          <span class="chip-label">候选总数</span>
          <span class="chip-value">{{ allItems.length }}</span>
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
          <span class="chip-label">已启用</span>
          <span class="chip-value">{{ enabledCount }}</span>
        </div>
      </div>
      <div class="toolbar-actions">
        <el-select v-model="filter" placeholder="全部市场" clearable style="width: 130px">
          <el-option label="场外" value="otc" />
          <el-option label="场内" value="exchange" />
        </el-select>
        <el-button @click="openCreate('otc')">新增场外</el-button>
        <el-button type="primary" @click="openCreate('exchange')">新增场内</el-button>
      </div>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>候选基金池</h3>
          <p>14:30 从当前市场的候选池选择买入；已持有基金会自动并入观察</p>
        </div>
        <span class="pill">{{ items.length }} 只</span>
      </div>
      <div class="panel-body no-pad">
        <el-table :data="items" size="small" stripe>
          <el-table-column label="市场" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.market === 'otc' ? 'warning' : 'success'">
                {{ row.market === "otc" ? "场外" : "场内" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="代码" width="90" />
          <el-table-column prop="name" label="名称" min-width="170" show-overflow-tooltip />
          <el-table-column prop="sector" label="板块" width="110" />
          <el-table-column prop="benchmark" label="对标 ETF" width="100" />
          <el-table-column label="搜索词" width="80" align="center">
            <template #default="{ row }">{{ (row.queries || []).length }}</template>
          </el-table-column>
          <el-table-column label="启用" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.enabled ? 'success' : 'info'">
                {{ row.enabled ? "启用" : "停用" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="sortOrder" label="排序" width="70" align="right" />
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!items.length" description="还没有候选基金" :image-size="90" />
      </div>
    </section>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑候选基金' : '新增候选基金'" width="640px">
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="市场">
              <el-radio-group v-model="form.market" :disabled="editing">
                <el-radio value="otc">场外</el-radio>
                <el-radio value="exchange">场内</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基金代码">
              <el-input v-model="form.code" :disabled="editing" placeholder="如 006697 / 512800" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="名称">
              <el-input v-model="form.name" placeholder="如 华宝银行ETF联接C" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="板块">
              <el-input v-model="form.sector" placeholder="如 银行/红利" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="对标 ETF">
              <el-input v-model="form.benchmark" placeholder="场外估值用，如 512800" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="排序">
              <el-input-number v-model="form.sortOrder" :min="0" :controls="false" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="搜索词（每行一条，无需日期）">
              <el-input
                v-model="form.queriesText"
                type="textarea"
                :rows="4"
                placeholder="银行板块 分红 资金"
              />
              <div class="rule-tip" style="margin-top: 6px">搜索时自动追加当前年月，例如 2026年11月，不需要手写日期。</div>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="状态">
              <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
