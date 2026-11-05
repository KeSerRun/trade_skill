<script setup>
import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { store, loadState, money } from "./store";

const route = useRoute();
const pageTitle = computed(() => route.meta.title ?? "总览");
const pageSubtitle = computed(() => route.meta.subtitle ?? "");
const today = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

onMounted(loadState);

async function refresh() {
  await loadState();
  ElMessage.success("已刷新");
}
</script>

<template>
  <el-container class="layout">
    <el-aside class="aside" width="232px">
      <div class="brand">
        <div class="brand-logo">基</div>
        <div class="brand-text">
          <strong>基金交易台</strong>
          <span>SQLite 单库</span>
        </div>
      </div>

      <el-menu :default-active="route.path" router class="side-menu">
        <el-menu-item index="/">
          <el-icon><DataAnalysis /></el-icon>
          <span>总览</span>
        </el-menu-item>
        <el-menu-item index="/market">
          <el-icon><TrendCharts /></el-icon>
          <span>实时行情</span>
        </el-menu-item>
        <el-menu-item index="/positions">
          <el-icon><Wallet /></el-icon>
          <span>持仓管理</span>
        </el-menu-item>
        <el-menu-item index="/rules">
          <el-icon><SetUp /></el-icon>
          <span>交易限制</span>
        </el-menu-item>
        <el-menu-item index="/watchlist">
          <el-icon><Collection /></el-icon>
          <span>关注列表</span>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon><Setting /></el-icon>
          <span>系统设置</span>
        </el-menu-item>
        <el-menu-item index="/tasks">
          <el-icon><Timer /></el-icon>
          <span>定时任务</span>
        </el-menu-item>
        <el-menu-item index="/trades">
          <el-icon><Tickets /></el-icon>
          <span>交易记录</span>
        </el-menu-item>
      </el-menu>

      <div class="side-footer">
        <span class="dot-online"></span>
        <div>
          <strong>数据已连接</strong>
          <span class="mono">.fund-trading/fund.db</span>
        </div>
      </div>
    </el-aside>

    <el-container>
      <el-header class="topbar" height="76px">
        <div class="topbar-title">
          <h1>{{ pageTitle }}</h1>
          <p>{{ pageSubtitle }}</p>
        </div>
        <div class="topbar-right">
          <div class="equity-pill">
            <span>总资产</span>
            <strong>¥{{ money(store.summary?.equity) }}</strong>
          </div>
          <span class="topbar-date">{{ today }}</span>
          <el-tooltip :content="store.meta?.dbPath || 'SQLite 单库'" placement="bottom">
            <span class="db-chip">SQLite 单库</span>
          </el-tooltip>
          <el-button :loading="store.loading" type="primary" plain @click="refresh">刷新</el-button>
        </div>
      </el-header>

      <el-main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" :key="route.path" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>
