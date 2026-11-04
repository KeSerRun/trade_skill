<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const tasks = ref([]);
const loading = ref(false);
const saving = ref("");
const running = ref("");
const mode = ref("otc");
const watchlists = ref({ otc: [], exchange: [] });
const forms = reactive({});

const enabledCount = computed(() => tasks.value.filter((task) => task.enabled).length);
const modeLabel = computed(() => (mode.value === "otc" ? "场外" : "场内"));

const nextRunAt = computed(() => {
  const times = tasks.value
    .map((task) => task.nextRun)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b);
  return times[0] ?? null;
});

const summaryItems = computed(() => [
  {
    label: "当前市场",
    value: modeLabel.value,
    tone: mode.value === "otc" ? "indigo" : "teal",
    icon: "Wallet",
  },
  {
    label: "已启用任务",
    value: `${enabledCount.value}/${tasks.value.length}`,
    tone: !tasks.value.length ? "muted" : enabledCount.value === tasks.value.length ? "green" : "amber",
    icon: "CircleCheck",
  },
  {
    label: "调度方式",
    value: "Windows 计划任务",
    tone: "violet",
    icon: "Timer",
  },
  {
    label: "下次运行",
    value: nextRunAt.value ? formatDate(nextRunAt.value) : "—",
    tone: nextRunAt.value ? "green" : "muted",
    icon: "AlarmClock",
  },
]);

async function load() {
  loading.value = true;
  try {
    const data = await api.tasks();
    tasks.value = data.tasks;
    mode.value = data.mode ?? "otc";
    watchlists.value = data.watchlists ?? { otc: [], exchange: [] };
    for (const task of data.tasks) {
      forms[task.name] = {
        time: task.time ?? "14:30",
        enabled: Boolean(task.enabled),
      };
    }
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function taskTone(task) {
  return task.name === "FundDailyClose" ? "teal" : "indigo";
}

function taskIcon(task) {
  return task.name === "FundDailyClose" ? "TrendCharts" : "AlarmClock";
}

function resultTone(task) {
  if (!task.exists || task.lastResult === null || task.lastResult === undefined) return "muted";
  const code = Number(task.lastResult);
  if (code === 0) return "positive";
  if ([267004, 267009, 267011].includes(code)) return "muted";
  return "negative";
}

function missedTone(task) {
  return Number(task.missed ?? 0) > 0 ? "negative" : "muted";
}

async function save(task) {
  saving.value = task.name;
  try {
    await api.updateTask(task.name, {
      time: forms[task.name].time,
      enabled: forms[task.name].enabled,
    });
    await load();
    ElMessage.success("任务已更新");
  } catch (error) {
    ElMessage.error(error.message);
    await load();
  } finally {
    saving.value = "";
  }
}

async function toggle(task) {
  await save(task);
}

async function switchMode(next) {
  if (!next || next === mode.value) return;
  const label = next === "otc" ? "场外" : "场内";
  try {
    await ElMessageBox.confirm(
      `切换为${label}后，下一次 14:30 会使用对应的关注列表和交易规则。已持仓不受影响，确定切换？`,
      "切换交易市场",
      { type: "warning", confirmButtonText: "切换", cancelButtonText: "取消" },
    );
    await api.setTradeMode(next);
    await load();
    ElMessage.success(`已切换为${label}`);
  } catch (error) {
    if (error !== "cancel" && error?.message) ElMessage.error(error.message);
  }
}

async function runNow(task) {
  try {
    await ElMessageBox.confirm(
      `立即运行「${task.label}」会执行对应脚本，可能推送消息，确定继续？`,
      "立即运行",
      { type: "warning", confirmButtonText: "运行", cancelButtonText: "取消" },
    );
    running.value = task.name;
    await api.runTask(task.name);
    await load();
    ElMessage.success("已触发运行");
  } catch (error) {
    if (error !== "cancel" && error?.message) ElMessage.error(error.message);
  } finally {
    running.value = "";
  }
}
</script>

<template>
  <div class="page tasks-page" v-loading="loading">
    <section class="tasks-overview">
      <div class="tasks-overview-copy">
        <span class="tasks-eyebrow">调度状态</span>
        <h2>每天 14:30 操作，15:30 收盘</h2>
        <p>由 Windows 计划任务触发，管理台只读取和修改系统任务，不维护独立定时器。</p>
      </div>
      <div class="tasks-status">
        <div v-for="item in summaryItems" :key="item.label" class="status-chip" :class="`is-${item.tone}`">
          <el-icon><component :is="item.icon" /></el-icon>
          <div>
            <span>{{ item.label }}</span>
            <strong :title="item.value">{{ item.value }}</strong>
          </div>
        </div>
      </div>
    </section>

    <div class="tasks-layout">
      <div class="tasks-main">
        <div class="tasks-list-head">
          <div>
            <h3>执行任务</h3>
            <p>修改时间或启停会直接写入 Windows 计划任务</p>
          </div>
          <el-button plain :loading="loading" @click="load">刷新状态</el-button>
        </div>

        <div v-if="tasks.length" class="task-list">
          <section
            v-for="task in tasks"
            :key="task.name"
            class="panel task-card"
            :class="`tone-${taskTone(task)}`"
          >
            <div class="panel-head task-head">
              <div class="task-title">
                <span class="task-icon">
                  <el-icon><component :is="taskIcon(task)" /></el-icon>
                </span>
                <div>
                  <div class="task-title-row">
                    <h3>{{ task.label }}</h3>
                    <el-tag :type="task.enabled ? 'success' : 'info'" effect="light" round>
                      {{ task.enabled ? "已启用" : "已停用" }}
                    </el-tag>
                  </div>
                  <p>{{ task.description }}</p>
                </div>
              </div>
              <span class="task-code mono">{{ task.name }}</span>
            </div>

            <div v-if="task.exists" class="panel-body task-body">
              <div class="task-time-block">
                <span class="task-time">{{ forms[task.name]?.time || task.time || "—" }}</span>
                <span class="task-time-label">每日执行</span>
                <span class="task-running" :class="{ on: task.enabled }">
                  {{ task.enabled ? "自动运行中" : "已暂停" }}
                </span>
              </div>

              <div class="task-main">
                <div class="task-controls">
                  <el-time-select
                    v-model="forms[task.name].time"
                    class="task-time-select"
                    start="00:00"
                    end="23:30"
                    step="00:30"
                    placeholder="选择时间"
                  />
                  <el-switch
                    v-model="forms[task.name].enabled"
                    inline-prompt
                    active-text="开"
                    inactive-text="关"
                    @change="toggle(task)"
                  />
                  <el-button type="primary" :loading="saving === task.name" @click="save(task)">
                    保存时间
                  </el-button>
                  <el-button plain :loading="running === task.name" @click="runNow(task)">立即运行</el-button>
                </div>

                <div class="task-metrics">
                  <div>
                    <span>下次运行</span>
                    <strong>{{ formatDate(task.nextRun) }}</strong>
                  </div>
                  <div>
                    <span>上次运行</span>
                    <strong>{{ formatDate(task.lastRun) }}</strong>
                  </div>
                  <div>
                    <span>上次结果</span>
                    <strong :class="resultTone(task)">{{ task.lastResultText }}</strong>
                  </div>
                  <div>
                    <span>错过次数</span>
                    <strong :class="missedTone(task)">{{ task.missed ?? 0 }}</strong>
                  </div>
                </div>
              </div>
            </div>

            <div v-else class="panel-body">
              <el-alert
                type="error"
                :closable="false"
                show-icon
                title="计划任务未注册"
                description="请先在系统中重新创建该任务，或联系我重新注册。"
              />
            </div>
          </section>
        </div>

        <el-empty v-else description="没有读取到计划任务" :image-size="90" />
      </div>

      <aside class="tasks-side">
        <section class="panel market-panel">
          <div class="panel-head">
            <div>
              <h3>交易市场</h3>
              <p>切换下一次 14:30 的候选池与规则</p>
            </div>
            <el-tag :type="mode === 'otc' ? 'primary' : 'success'" effect="light" round>{{ modeLabel }}</el-tag>
          </div>
          <div class="panel-body">
            <el-radio-group
              class="market-switch"
              :model-value="mode"
              @change="switchMode"
            >
              <el-radio-button value="otc">场外 T+2</el-radio-button>
              <el-radio-button value="exchange">场内 T+1</el-radio-button>
            </el-radio-group>

            <div class="market-rule">
              <span class="market-rule-label">当前规则</span>
              <strong>{{ mode === "otc" ? "场外 T+2" : "场内 T+1" }}</strong>
              <span class="market-rule-note">候选 {{ (watchlists[mode] || []).length }} 只</span>
            </div>

            <div class="mode-funds">
              <el-tag v-for="fund in watchlists[mode] || []" :key="fund.code" size="large" effect="plain">
                {{ fund.code }} {{ fund.name || fund.sector || "" }}
              </el-tag>
            </div>

            <p class="tasks-note">
              当前使用{{ mode === "otc" ? "场外 T+2" : "场内 T+1" }}规则；切换只影响下一次买入候选，已持仓按自身市场规则卖出。
            </p>
          </div>
        </section>
      </aside>
    </div>

    <section class="panel tasks-help">
      <div class="panel-head">
        <div>
          <h3>运行说明</h3>
          <p>后台只调用 Windows 计划任务接口，不维护独立定时器</p>
        </div>
      </div>
      <div class="panel-body">
        <div class="help-grid">
          <div class="help-item">
            <el-icon><AlarmClock /></el-icon>
            <div>
              <strong>14:30 操作</strong>
              <span>生成买入、卖出或不动操作，自动记账并推送报告。</span>
            </div>
          </div>
          <div class="help-item">
            <el-icon><TrendCharts /></el-icon>
            <div>
              <strong>15:30 收盘</strong>
              <span>用对标 ETF 收盘价估算当日盈亏，并推送收盘摘要。</span>
            </div>
          </div>
          <div class="help-item">
            <el-icon><Monitor /></el-icon>
            <div>
              <strong>运行条件</strong>
              <span>电脑开机且当前用户已登录；睡眠会尝试唤醒，关机不会补跑。</span>
            </div>
          </div>
          <div class="help-item">
            <el-icon><VideoPlay /></el-icon>
            <div>
              <strong>修改与运行</strong>
              <span>改时间立即生效；停用只暂停触发；“立即运行”会真实执行脚本。</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tasks-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tasks-overview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 22px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background:
    linear-gradient(120deg, rgba(79, 110, 247, 0.1), rgba(14, 165, 164, 0.06) 46%, rgba(255, 255, 255, 0) 76%),
    var(--surface);
  box-shadow: var(--shadow);
}

.tasks-overview-copy {
  max-width: 560px;
}

.tasks-eyebrow {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: #4f6ef7;
}

.tasks-overview h2 {
  margin: 6px 0 4px;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.tasks-overview p {
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
}

.tasks-status {
  display: grid;
  grid-template-columns: repeat(2, minmax(160px, 1fr));
  gap: 10px;
  min-width: 380px;
}

.status-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.78);
}

.status-chip .el-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 9px;
  font-size: 15px;
}

.status-chip span {
  display: block;
  color: var(--text-3);
  font-size: 10px;
}

.status-chip strong {
  display: block;
  overflow: hidden;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-chip.is-green .el-icon {
  color: var(--green);
  background: #e9fbf0;
}

.status-chip.is-amber .el-icon {
  color: var(--amber);
  background: #fff7e6;
}

.status-chip.is-indigo .el-icon {
  color: var(--primary);
  background: #eef1ff;
}

.status-chip.is-teal .el-icon {
  color: var(--teal);
  background: #e6fbfa;
}

.status-chip.is-violet .el-icon {
  color: var(--violet);
  background: #f3edff;
}

.status-chip.is-muted .el-icon {
  color: var(--text-3);
  background: #f1f5f9;
}

.tasks-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(340px, 0.85fr);
  align-items: start;
  gap: 16px;
}

.tasks-main {
  min-width: 0;
}

.tasks-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tasks-list-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin: 0 2px 10px;
}

.tasks-list-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.tasks-list-head p {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 11px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.task-card {
  position: relative;
}

.task-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--tone, var(--primary));
}

.task-head {
  align-items: flex-start;
  padding: 16px 20px;
}

.task-title {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.task-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: var(--tone, var(--primary));
  background: var(--tone-bg, #eef1ff);
  font-size: 18px;
}

.task-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-title-row h3 {
  margin: 0;
}

.task-title p {
  margin: 4px 0 0;
}

.task-code {
  flex-shrink: 0;
  margin-top: 4px;
  color: var(--text-3);
  font-size: 10px;
}

.task-body {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 20px;
  padding: 18px 20px 20px;
}

.task-time-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding-right: 18px;
  border-right: 1px dashed #edf0f6;
}

.task-time {
  color: var(--text);
  font-size: 40px;
  font-weight: 700;
  letter-spacing: -0.05em;
  line-height: 1;
}

.task-time-label {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.task-running {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  color: var(--text-3);
  font-size: 11px;
}

.task-running::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #cbd5e1;
}

.task-running.on {
  color: var(--green);
}

.task-running.on::before {
  background: var(--green);
  box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.12);
}

.task-main {
  min-width: 0;
}

.task-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.task-time-select {
  width: 132px;
}

.task-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed #edf0f6;
}

.task-metrics div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.task-metrics span {
  color: var(--text-3);
  font-size: 10px;
}

.task-metrics strong {
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-metrics .positive {
  color: var(--green);
}

.task-metrics .negative {
  color: var(--red);
}

.task-metrics .muted {
  color: var(--text-3);
  font-weight: 500;
}

.market-switch {
  display: flex;
  width: 100%;
}

.market-switch :deep(.el-radio-button) {
  flex: 1;
}

.market-switch :deep(.el-radio-button__inner) {
  width: 100%;
}

.market-rule {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 16px 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-soft);
}

.market-rule-label {
  color: var(--text-3);
  font-size: 10px;
}

.market-rule strong {
  font-size: 13px;
}

.market-rule-note {
  margin-left: auto;
  color: var(--text-3);
  font-size: 11px;
}

.market-panel .mode-funds {
  margin-bottom: 4px;
}

.tasks-note {
  margin: 12px 0 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
}

.tasks-help .panel-body {
  padding: 16px 20px 20px;
}

.help-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 28px;
}

.help-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.help-item > .el-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: var(--primary);
  background: #eef1ff;
  font-size: 15px;
}

.help-item strong {
  display: block;
  font-size: 12px;
}

.help-item span {
  display: block;
  margin-top: 3px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 1200px) {
  .tasks-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 1080px) {
  .tasks-overview {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }

  .tasks-status {
    min-width: 0;
  }
}

@media (max-width: 760px) {
  .task-body {
    grid-template-columns: 1fr;
    gap: 14px;
  }

  .task-time-block {
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
    padding-right: 0;
    padding-bottom: 14px;
    border-right: none;
    border-bottom: 1px dashed #edf0f6;
  }

  .task-time {
    font-size: 34px;
  }

  .task-time-label {
    margin-top: 0;
  }

  .task-running {
    margin-top: 0;
    margin-left: auto;
  }

  .task-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .tasks-overview {
    padding: 18px;
  }

  .tasks-status {
    grid-template-columns: 1fr;
  }

  .task-code {
    display: none;
  }

  .tasks-list-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .tasks-list-head .el-button {
    width: 100%;
  }

  .task-controls {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
  }

  .task-time-select {
    grid-column: 1 / -1;
    width: 100%;
  }

  .task-controls .el-button {
    width: 100%;
  }

  .help-grid {
    grid-template-columns: 1fr;
  }
}
</style>
