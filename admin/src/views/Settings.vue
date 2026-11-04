<script setup>
import { onMounted, reactive, ref } from "vue";
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
  <div class="page" v-loading="loading">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>策略参数</h3>
          <p>14:30 的买入 / 卖出规则，保存后下一次运行生效</p>
        </div>
        <el-button type="primary" :loading="saving.advice" @click="saveAdvice">保存策略</el-button>
      </div>
      <div class="panel-body">
        <div class="limit-grid">
          <label class="field">
            <span>规则引擎</span>
            <el-switch v-model="advice.enabled" active-text="启用" inactive-text="停用" />
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
        <div class="rule-tip">止损/止盈按百分比填写，例如 -15 表示亏损 15% 触发止损，30 表示盈利 30% 触发止盈。</div>
      </div>
    </section>

    <section class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <div>
          <h3>运行参数</h3>
          <p>资讯采集与两阶段无头 agent 的运行限制</p>
        </div>
        <el-button type="primary" :loading="saving.runtime" @click="saveRuntime">保存运行参数</el-button>
      </div>
      <div class="panel-body">
        <div class="limit-grid">
          <label class="field">
            <span>自动记账</span>
            <el-switch v-model="runtime.autoExecute" active-text="开启" inactive-text="关闭" />
          </label>
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
          <label class="field" style="grid-column: span 2">
            <span>模型（留空跟随默认）</span>
            <el-input v-model="runtime.model" placeholder="如 deepseek/deepseek-v4-flash" />
          </label>
        </div>
        <div class="rule-tip">自动记账关闭后，14:30 只生成建议并推送，不写入纸面账户。</div>
      </div>
    </section>

    <section class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <div>
          <h3>推送设置</h3>
          <p>日报与收盘盈亏的微信推送</p>
        </div>
        <el-button type="primary" :loading="saving.notify" @click="saveNotify">保存推送</el-button>
      </div>
      <div class="panel-body">
        <div class="limit-grid">
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

        <div v-if="notify.channel === 'serverchan'" class="limit-grid" style="margin-top: 16px">
          <label class="field" style="grid-column: span 2">
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

        <div v-if="notify.channel === 'wecom'" class="limit-grid" style="margin-top: 16px">
          <label class="field" style="grid-column: span 2">
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

        <div v-if="notify.channel === 'pushplus'" class="limit-grid" style="margin-top: 16px">
          <label class="field" style="grid-column: span 2">
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

        <div class="rule-tip">密钥只显示“已配置”，留空保存不会覆盖原值；填写新值才会更新。</div>
      </div>
    </section>
  </div>
</template>
