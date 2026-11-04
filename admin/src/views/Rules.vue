<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import { store, loadState } from "../store";

const saving = ref(false);
const markets = [
  {
    key: "otc",
    title: "场外基金",
    badge: "T+2",
    tagType: "warning",
    desc: "15:00 前提交按当日 15:00 净值确认；T+2 才可赎回；7 日内赎回费 1.5%",
  },
  {
    key: "exchange",
    title: "场内基金",
    badge: "T+1",
    tagType: "success",
    desc: "交易时段按实时价成交；T+1 可卖；默认无赎回费",
  },
];

const form = reactive({
  otc: {
    minHoldingDays: 2,
    buyFeeRate: 0.15,
    sellTiers: [
      { maxHoldingDays: 7, rate: 1.5 },
      { maxHoldingDays: 30, rate: 0.5 },
      { maxHoldingDays: 365, rate: 0.1 },
      { maxHoldingDays: null, rate: 0 },
    ],
  },
  exchange: {
    minHoldingDays: 1,
    buyFeeRate: 0.03,
    sellTiers: [{ maxHoldingDays: null, rate: 0 }],
  },
  portfolio: {
    maxSinglePositionPct: 30,
    maxTotalPositionPct: 95,
    minCashReservePct: 5,
    maxOrderAmount: 50000,
  },
});

function toUi(rules) {
  const mapMarket = (item) => ({
    minHoldingDays: item.minHoldingDays,
    buyFeeRate: Number((item.buyFeeRate * 100).toFixed(4)),
    sellTiers: item.sellTiers.map((tier) => ({
      maxHoldingDays: tier.maxHoldingDays,
      rate: Number((tier.rate * 100).toFixed(4)),
    })),
  });
  return {
    otc: mapMarket(rules.otc),
    exchange: mapMarket(rules.exchange),
    portfolio: {
      maxSinglePositionPct: Number((rules.portfolio.max_single_position_pct * 100).toFixed(2)),
      maxTotalPositionPct: Number((rules.portfolio.max_total_position_pct * 100).toFixed(2)),
      minCashReservePct: Number((rules.portfolio.min_cash_reserve_pct * 100).toFixed(2)),
      maxOrderAmount: rules.portfolio.max_order_amount,
    },
  };
}

function fromUi(input) {
  const mapMarket = (item) => ({
    minHoldingDays: item.minHoldingDays,
    buyFeeRate: item.buyFeeRate / 100,
    sellTiers: item.sellTiers.map((tier) => ({
      maxHoldingDays: tier.maxHoldingDays,
      rate: tier.rate / 100,
    })),
  });
  return {
    otc: mapMarket(input.otc),
    exchange: mapMarket(input.exchange),
    portfolio: {
      maxSinglePositionPct: input.portfolio.maxSinglePositionPct / 100,
      maxTotalPositionPct: input.portfolio.maxTotalPositionPct / 100,
      minCashReservePct: input.portfolio.minCashReservePct / 100,
      maxOrderAmount: input.portfolio.maxOrderAmount,
    },
  };
}

function loadFromStore() {
  if (store.rules) Object.assign(form, toUi(store.rules));
}

onMounted(async () => {
  await loadState();
  loadFromStore();
});

function addTier(market) {
  const tiers = form[market].sellTiers;
  const finite = tiers.filter((tier) => tier.maxHoldingDays !== null);
  const next = finite.length ? finite[finite.length - 1].maxHoldingDays + 30 : 7;
  tiers.splice(tiers.length - 1, 0, { maxHoldingDays: next, rate: 0 });
}

function removeTier(market, index) {
  const tiers = form[market].sellTiers;
  if (index >= tiers.length - 1) return;
  tiers.splice(index, 1);
}

async function save() {
  for (const market of ["otc", "exchange"]) {
    const tiers = form[market].sellTiers;
    if (!tiers.length || tiers[tiers.length - 1].maxHoldingDays !== null) {
      ElMessage.warning("最后一段赎回费必须设置为“不限”");
      return;
    }
  }
  saving.value = true;
  try {
    await api.saveRules(fromUi(form));
    await loadState();
    loadFromStore();
    ElMessage.success("规则已保存到 SQLite");
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
          <span class="chip-label">场外最短持有</span>
          <span class="chip-value">{{ form.otc.minHoldingDays }} 天</span>
        </div>
        <div class="chip">
          <span class="chip-label">场外买入费</span>
          <span class="chip-value">{{ form.otc.buyFeeRate }}%</span>
        </div>
        <div class="chip">
          <span class="chip-label">单只上限</span>
          <span class="chip-value">{{ form.portfolio.maxSinglePositionPct }}%</span>
        </div>
        <div class="chip">
          <span class="chip-label">总仓位上限</span>
          <span class="chip-value">{{ form.portfolio.maxTotalPositionPct }}%</span>
        </div>
      </div>
      <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h3>组合限制</h3>
          <p>对所有场内 / 场外持仓生效</p>
        </div>
      </div>
      <div class="panel-body">
        <div class="limit-grid">
          <label class="field">
            <span>单只持仓上限（%）</span>
            <el-input-number v-model="form.portfolio.maxSinglePositionPct" :min="0" :max="100" :precision="1" :controls="false" />
          </label>
          <label class="field">
            <span>总仓位上限（%）</span>
            <el-input-number v-model="form.portfolio.maxTotalPositionPct" :min="0" :max="100" :precision="1" :controls="false" />
          </label>
          <label class="field">
            <span>现金底线（%）</span>
            <el-input-number v-model="form.portfolio.minCashReservePct" :min="0" :max="100" :precision="1" :controls="false" />
          </label>
          <label class="field">
            <span>单笔金额上限（元）</span>
            <el-input-number v-model="form.portfolio.maxOrderAmount" :min="0" :precision="2" :step="1000" :controls="false" />
          </label>
        </div>
      </div>
    </section>

    <div class="market-grid">
      <section v-for="market in markets" :key="market.key" class="panel">
        <div class="panel-head">
          <div>
            <h3>{{ market.title }}</h3>
            <p>{{ market.desc }}</p>
          </div>
          <el-tag :type="market.tagType">{{ market.badge }}</el-tag>
        </div>
        <div class="panel-body">
          <div class="limit-grid two">
            <label class="field">
              <span>最短持有天数</span>
              <el-input-number v-model="form[market.key].minHoldingDays" :min="0" :max="30" :controls="false" />
            </label>
            <label class="field">
              <span>买入费率（%）</span>
              <el-input-number v-model="form[market.key].buyFeeRate" :min="0" :max="10" :precision="4" :controls="false" />
            </label>
          </div>

          <div class="tier-head">
            <span>赎回费分档</span>
            <el-button link type="primary" @click="addTier(market.key)">+ 新增一档</el-button>
          </div>
          <el-table :data="form[market.key].sellTiers" size="small" border>
            <el-table-column label="持有天数上限">
              <template #default="{ row }">
                <el-tag v-if="row.maxHoldingDays === null" type="info">不限</el-tag>
                <el-input-number
                  v-else
                  v-model="row.maxHoldingDays"
                  :min="1"
                  :max="3650"
                  :controls="false"
                  style="width: 110px"
                />
              </template>
            </el-table-column>
            <el-table-column label="费率（%）" width="140">
              <template #default="{ row }">
                <el-input-number
                  v-model="row.rate"
                  :min="0"
                  :max="100"
                  :precision="3"
                  :controls="false"
                  style="width: 96px"
                />
              </template>
            </el-table-column>
            <el-table-column label="" width="72" align="right">
              <template #default="{ $index }">
                <el-button
                  link
                  type="danger"
                  :disabled="$index === form[market.key].sellTiers.length - 1"
                  @click="removeTier(market.key, $index)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>
    </div>

    <section class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <div>
          <h3>规则说明</h3>
          <p>保存后立即生效，14:30 / 15:30 的定时任务会读取同一份 SQLite 规则</p>
        </div>
      </div>
      <div class="panel-body">
        <ul class="muted" style="line-height: 1.9; margin: 0; padding-left: 18px">
          <li>场外赎回费率按“持有天数”分档，费用从赎回金额中扣除；买入费率从申购金额中扣除。</li>
          <li>最短持有天数用于拦截过早赎回：买入当天算第 1 天，填 2 表示第三个交易日才能卖。</li>
          <li>单只上限、总仓位上限、现金底线用于买入前风控校验；单笔上限限制一次买入金额。</li>
          <li>修改规则不会自动改写已有持仓或历史成交。</li>
        </ul>
      </div>
    </section>
  </div>
</template>
