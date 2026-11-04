<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";

const loading = ref(false);
const saving = reactive({ runtime: false, advice: false, notify: false });

const runtime = reactive({
  autoExecute: true,
  queriesPerFund: 3,
  maxTurns: 60,
  reportMaxTurns: 20,
  model: "",
});

const advice = reactive({
  enabled: true,
  maxBuysPerDay: 1,
  maxSellsPerDay: 1,
  buyPct: 30,
  minBuyAmount: 500,
  buyStances: ["hot"],
  minD20: 0,
  maxDistanceFromHigh: 8,
  minConfidence: "medium",
  sellStances: ["risk"],
  stopLossPct: -15,
  takeProfitPct: 30,
  exitIfD20Below: -5,
});

const notify = reactive({
  channel: "none",
  wecomWebhook: "",
  serverChanKey: "",
  pushplusToken: "",
  titlePrefix: "基金日报",
  hasWecomWebhook: false,
  hasServerChanKey: false,
  hasPushplusToken: false,
});

const stances = [
  { label: "雷点", value: "risk" },
  { label: "热点", value: "hot" },
  { label: "多空交织", value: "mixed" },
  { label: "中性", value: "neutral" },
];
const confidenceOptions = [
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
];
const channels = [
  { label: "不推送", value: "none" },
  { label: "Server酱", value: "serverchan" },
  { label: "企业微信", value: "wecom" },
  { label: "PushPlus", value: "pushplus" },
];

const stanceLabels = Object.fromEntries(stances.map((item) => [item.value, item.label]));
const confidenceLabels = Object.fromEntries(confidenceOptions.map((item) => [item.value, item.label]));
const channelLabels = Object.fromEntries(channels.map((item) => [item.value, item.label]));

function stanceText(values) {
  const labels = (values ?? []).map((value) => stanceLabels[value]).filter(Boolean);
  return labels.length ? labels.join(" / ") : "未设置";
}

function signedPct(value) {
  const number = Number(value ?? 0);
  return `${number > 0 ? "+" : ""}${number}%`;
}

const statusItems = computed(() => [
  {
    label: "规则引擎",
    value: advice.enabled ? "启用" : "停用",
    tone: advice.enabled ? "green" : "muted",
    icon: "SetUp",
  },
  {
    label: "自动记账",
    value: runtime.autoExecute ? "写入账户" : "只出建议",
    tone: runtime.autoExecute ? "green" : "amber",
    icon: "EditPen",
  },
  {
    label: "推送通道",
    value: channelLabels[notify.channel] ?? "不推送",
    tone: notify.channel === "none" ? "muted" : "indigo",
    icon: "Bell",
  },
  {
    label: "运行模型",
    value: runtime.model || "跟随默认",
    tone: "violet",
    icon: "Cpu",
  },
]);

const advicePreview = computed(() => {
  if (!advice.enabled) return "规则引擎已停用，14:30 不会生成买入或卖出操作。";
  const buy = stanceText(advice.buyStances);
  const sell = stanceText(advice.sellStances);
  return [
    `买入 ${buy}，置信度 ${confidenceLabels[advice.minConfidence] ?? "中"} 以上；20 日涨幅 ≥ ${advice.minD20}%，距 60 日高 ≤ ${advice.maxDistanceFromHigh}%。`,
    `单笔使用总资产 ${advice.buyPct}%，最低 ¥${Number(advice.minBuyAmount ?? 0).toLocaleString("zh-CN")}。`,
    `卖出 ${sell}；止损 ${signedPct(advice.stopLossPct)}，止盈 ${signedPct(advice.takeProfitPct)}，20 日低于 ${signedPct(advice.exitIfD20Below)} 退出。`,
  ].join(" ");
});

async function load() {
  loading.value = true;
  try {
    const data = await api.settings();
    Object.assign(runtime, data.runtime);
    Object.assign(advice, {
      ...data.advice,
      buyPct: Number((data.advice.buyPct * 100).toFixed(2)),
      minD20: Number((data.advice.minD20 * 100).toFixed(2)),
      maxDistanceFromHigh: Number((data.advice.maxDistanceFromHigh * 100).toFixed(2)),
      stopLossPct: Number((data.advice.stopLossPct * 100).toFixed(2)),
      takeProfitPct: Number((data.advice.takeProfitPct * 100).toFixed(2)),
      exitIfD20Below: Number((data.advice.exitIfD20Below * 100).toFixed(2)),
    });
    Object.assign(notify, {
      channel: data.notify.channel,
      titlePrefix: data.notify.titlePrefix,
      wecomWebhook: "",
      serverChanKey: "",
      pushplusToken: "",
      hasWecomWebhook: data.notify.hasWecomWebhook,
      hasServerChanKey: data.notify.hasServerChanKey,
      hasPushplusToken: data.notify.hasPushplusToken,
    });
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function saveRuntime() {
  saving.runtime = true;
  try {
    await api.saveRuntime({ ...runtime });
    await load();
    ElMessage.success("运行参数已保存");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.runtime = false;
  }
}

async function saveAdvice() {
  saving.advice = true;
  try {
    await api.saveAdvice({
      ...advice,
      buyPct: advice.buyPct / 100,
      minD20: advice.minD20 / 100,
      maxDistanceFromHigh: advice.maxDistanceFromHigh / 100,
      stopLossPct: advice.stopLossPct / 100,
      takeProfitPct: advice.takeProfitPct / 100,
      exitIfD20Below: advice.exitIfD20Below / 100,
    });
    await load();
    ElMessage.success("策略参数已保存");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.advice = false;
  }
}

async function saveNotify() {
  saving.notify = true;
  try {
    await api.saveNotify({
      channel: notify.channel,
      titlePrefix: notify.titlePrefix,
      wecomWebhook: notify.wecomWebhook,
      serverChanKey: notify.serverChanKey,
      pushplusToken: notify.pushplusToken,
    });
    await load();
    ElMessage.success("推送设置已保存");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    saving.notify = false;
  }
}
</script>

<template>
  <div class="page settings-page" v-loading="loading">
    <section class="settings-overview">
      <div class="settings-overview-copy">
        <span class="settings-eyebrow">运行配置</span>
        <h2>下一轮 14:30 按这套规则执行</h2>
        <p>策略、运行与推送配置统一保存在 fund.db，保存后下一轮任务生效。</p>
      </div>
      <div class="settings-status">
        <div v-for="item in statusItems" :key="item.label" class="status-chip" :class="`is-${item.tone}`">
          <el-icon><component :is="item.icon" /></el-icon>
          <div>
            <span>{{ item.label }}</span>
            <strong :title="item.value">{{ item.value }}</strong>
          </div>
        </div>
      </div>
    </section>

    <div class="settings-layout">
      <section class="panel settings-panel">
        <div class="panel-head settings-head">
          <div>
            <div class="settings-title-row">
              <h3>策略参数</h3>
              <el-tag :type="advice.enabled ? 'success' : 'info'" effect="light" round>
                {{ advice.enabled ? "启用" : "停用" }}
              </el-tag>
            </div>
            <p>决定 14:30 生成买入、卖出还是不动</p>
          </div>
          <el-button type="primary" :loading="saving.advice" @click="saveAdvice">保存策略</el-button>
        </div>
        <div class="panel-body">
          <div class="settings-block">
            <div class="settings-block-head">
              <span>01</span>
              <div>
                <h4>交易节奏</h4>
                <p>每日操作次数、单笔仓位与最小金额</p>
              </div>
            </div>
            <div class="settings-grid three">
              <label class="field">
                <span>规则引擎</span>
                <el-switch v-model="advice.enabled" inline-prompt active-text="开" inactive-text="关" />
              </label>
              <label class="field">
                <span>每日最多买入</span>
                <el-input-number v-model="advice.maxBuysPerDay" :min="0" :max="10" :controls="false" />
              </label>
              <label class="field">
                <span>每日最多卖出</span>
                <el-input-number v-model="advice.maxSellsPerDay" :min="0" :max="10" :controls="false" />
              </label>
              <label class="field">
                <span>单次买入占总资产（%）</span>
                <el-input-number v-model="advice.buyPct" :min="0" :max="100" :precision="1" :controls="false" />
              </label>
              <label class="field">
                <span>最小买入金额（元）</span>
                <el-input-number v-model="advice.minBuyAmount" :min="0" :precision="2" :controls="false" />
              </label>
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-block-head">
              <span>02</span>
              <div>
                <h4>买入条件</h4>
                <p>什么资讯与走势会触发买入</p>
              </div>
            </div>
            <div class="settings-grid two">
              <label class="field">
                <span>买入立场</span>
                <el-select v-model="advice.buyStances" multiple collapse-tags>
                  <el-option v-for="item in stances" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </label>
              <label class="field">
                <span>最低置信度</span>
                <el-select v-model="advice.minConfidence">
                  <el-option v-for="item in confidenceOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </label>
              <label class="field">
                <span>20 日涨幅下限（%）</span>
                <el-input-number v-model="advice.minD20" :min="-100" :max="100" :precision="2" :controls="false" />
              </label>
              <label class="field">
                <span>距 60 日高上限（%）</span>
                <el-input-number v-model="advice.maxDistanceFromHigh" :min="0" :max="100" :precision="2" :controls="false" />
              </label>
            </div>
          </div>

          <div class="settings-block">
            <div class="settings-block-head">
              <span>03</span>
              <div>
                <h4>卖出条件</h4>
                <p>风控、止盈与趋势退出</p>
              </div>
            </div>
            <div class="settings-grid two">
              <label class="field">
                <span>卖出立场</span>
                <el-select v-model="advice.sellStances" multiple collapse-tags>
                  <el-option v-for="item in stances" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </label>
              <label class="field">
                <span>止损线（%）</span>
                <el-input-number v-model="advice.stopLossPct" :min="-100" :max="0" :precision="2" :controls="false" />
              </label>
              <label class="field">
                <span>止盈线（%）</span>
                <el-input-number v-model="advice.takeProfitPct" :min="0" :max="100" :precision="2" :controls="false" />
              </label>
              <label class="field">
                <span>20 日退出阈值（%）</span>
                <el-input-number v-model="advice.exitIfD20Below" :min="-100" :max="0" :precision="2" :controls="false" />
              </label>
            </div>
          </div>

          <div class="strategy-preview">
            <div class="strategy-preview-head">
              <el-icon><MagicStick /></el-icon>
              <span>当前策略预览</span>
            </div>
            <p>{{ advicePreview }}</p>
          </div>

          <p class="settings-note">止损/止盈按百分比填写：-15 表示亏损 15% 触发止损，30 表示盈利 30% 触发止盈。</p>
        </div>
      </section>

      <aside class="settings-side">
        <section class="panel settings-panel">
          <div class="panel-head settings-head">
            <div>
              <div class="settings-title-row">
                <h3>运行参数</h3>
              </div>
              <p>资讯采集与两阶段无头 agent</p>
            </div>
            <el-button type="primary" plain :loading="saving.runtime" @click="saveRuntime">保存</el-button>
          </div>
          <div class="panel-body">
            <div class="runtime-switch">
              <div>
                <strong>自动记账</strong>
                <span>{{ runtime.autoExecute ? "建议直接写入纸面账户" : "只生成建议，不写入账户" }}</span>
              </div>
              <el-switch v-model="runtime.autoExecute" />
            </div>

            <div class="settings-grid compact">
              <label class="field">
                <span>每只基金搜索词数</span>
                <el-input-number v-model="runtime.queriesPerFund" :min="1" :max="10" :controls="false" />
              </label>
              <label class="field">
                <span>阶段 A 最大轮数</span>
                <el-input-number v-model="runtime.maxTurns" :min="5" :max="300" :controls="false" />
              </label>
              <label class="field">
                <span>阶段 B 最大轮数</span>
                <el-input-number v-model="runtime.reportMaxTurns" :min="5" :max="200" :controls="false" />
              </label>
            </div>

            <label class="field settings-model">
              <span>模型（留空跟随默认）</span>
              <el-input v-model="runtime.model" placeholder="如 deepseek/deepseek-v4-flash" />
            </label>

            <p class="settings-note">自动记账关闭后，14:30 只生成建议并推送，不写入纸面账户。</p>
          </div>
        </section>

        <section class="panel settings-panel">
          <div class="panel-head settings-head">
            <div>
              <div class="settings-title-row">
                <h3>推送设置</h3>
              </div>
              <p>日报与收盘盈亏的微信推送</p>
            </div>
            <el-button type="primary" plain :loading="saving.notify" @click="saveNotify">保存</el-button>
          </div>
          <div class="panel-body">
            <div class="settings-grid compact">
              <label class="field">
                <span>通道</span>
                <el-select v-model="notify.channel">
                  <el-option v-for="item in channels" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </label>
              <label class="field">
                <span>标题前缀</span>
                <el-input v-model="notify.titlePrefix" />
              </label>
            </div>

            <div v-if="notify.channel === 'serverchan'" class="secret-field">
              <label class="field">
                <span>
                  Server酱 SCKEY
                  <el-tag v-if="notify.hasServerChanKey" size="small" type="success" style="margin-left: 6px">已配置</el-tag>
                </span>
                <el-input
                  v-model="notify.serverChanKey"
                  type="password"
                  show-password
                  :placeholder="notify.hasServerChanKey ? '已配置，留空不修改' : 'SCT...'"
                />
              </label>
            </div>

            <div v-if="notify.channel === 'wecom'" class="secret-field">
              <label class="field">
                <span>
                  企业微信 Webhook
                  <el-tag v-if="notify.hasWecomWebhook" size="small" type="success" style="margin-left: 6px">已配置</el-tag>
                </span>
                <el-input
                  v-model="notify.wecomWebhook"
                  type="password"
                  show-password
                  :placeholder="notify.hasWecomWebhook ? '已配置，留空不修改' : 'https://qyapi.weixin.qq.com/...'"
                />
              </label>
            </div>

            <div v-if="notify.channel === 'pushplus'" class="secret-field">
              <label class="field">
                <span>
                  PushPlus Token
                  <el-tag v-if="notify.hasPushplusToken" size="small" type="success" style="margin-left: 6px">已配置</el-tag>
                </span>
                <el-input
                  v-model="notify.pushplusToken"
                  type="password"
                  show-password
                  :placeholder="notify.hasPushplusToken ? '已配置，留空不修改' : 'token...'"
                />
              </label>
            </div>

            <div class="push-status">
              <span class="push-dot" :class="{ on: notify.channel !== 'none' }"></span>
              <span>{{ notify.channel === "none" ? "当前不发送推送" : `通过${channelLabels[notify.channel]}推送` }}</span>
            </div>

            <p class="settings-note">密钥只显示“已配置”，留空保存不会覆盖原值；填写新值才会更新。</p>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-overview {
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

.settings-overview-copy {
  max-width: 560px;
}

.settings-eyebrow {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: #4f6ef7;
}

.settings-overview h2 {
  margin: 6px 0 4px;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.settings-overview p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}

.settings-status {
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
  font-size: 10px;
  color: var(--text-3);
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

.status-chip.is-violet .el-icon {
  color: var(--violet);
  background: #f3edff;
}

.status-chip.is-muted .el-icon {
  color: var(--text-3);
  background: #f1f5f9;
}

.settings-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(340px, 0.85fr);
  align-items: start;
  gap: 16px;
}

.settings-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-head {
  align-items: flex-start;
}

.settings-head .el-button {
  flex-shrink: 0;
}

.settings-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-title-row h3 {
  margin: 0;
}

.settings-block {
  margin-bottom: 18px;
  padding-bottom: 18px;
  border-bottom: 1px dashed #edf0f6;
}

.settings-block:last-of-type {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.settings-block-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 14px;
}

.settings-block-head > span {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #4f6ef7;
  background: #eef1ff;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.settings-block-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}

.settings-block-head p {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-3);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
}

.settings-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.settings-grid.compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.settings-model {
  margin-top: 14px;
}

.strategy-preview {
  margin-top: 18px;
  padding: 14px 16px;
  border: 1px solid #e6ebff;
  border-radius: 13px;
  background: linear-gradient(135deg, #f7f9ff, #fbfcff);
}

.strategy-preview-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #4f6ef7;
  font-size: 11px;
  font-weight: 650;
}

.strategy-preview p {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.7;
}

.settings-note {
  margin: 12px 0 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
}

.runtime-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-soft);
}

.runtime-switch strong {
  display: block;
  font-size: 13px;
}

.runtime-switch span {
  display: block;
  margin-top: 2px;
  color: var(--text-3);
  font-size: 11px;
}

.secret-field {
  margin-top: 14px;
}

.push-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-2);
  font-size: 12px;
}

.push-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #cbd5e1;
}

.push-dot.on {
  background: var(--green);
  box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.12);
}

@media (max-width: 1080px) {
  .settings-overview {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }

  .settings-status {
    min-width: 0;
  }
}

@media (max-width: 1200px) {
  .settings-layout {
    grid-template-columns: 1fr;
  }

  .settings-grid.three {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .settings-overview {
    padding: 18px;
  }

  .settings-status,
  .settings-grid,
  .settings-grid.three,
  .settings-grid.compact {
    grid-template-columns: 1fr;
  }

  .settings-head {
    flex-direction: column;
  }

  .settings-head .el-button {
    width: 100%;
  }
}
</style>
