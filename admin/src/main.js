import { createApp } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import { createRouter, createWebHistory } from "vue-router";
import "element-plus/dist/index.css";
import "./styles.css";
import App from "./App.vue";
import Dashboard from "./views/Dashboard.vue";
import Positions from "./views/Positions.vue";
import Rules from "./views/Rules.vue";
import Watchlist from "./views/Watchlist.vue";
import Tasks from "./views/Tasks.vue";
import Trades from "./views/Trades.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Dashboard, meta: { title: "总览", subtitle: "账户、仓位与当日概况" } },
    { path: "/positions", component: Positions, meta: { title: "持仓管理", subtitle: "维护场外 / 场内持仓与成本" } },
    { path: "/rules", component: Rules, meta: { title: "交易限制", subtitle: "按市场配置持有天数、费率与仓位上限" } },
    { path: "/watchlist", component: Watchlist, meta: { title: "关注列表", subtitle: "定时任务的场外 / 场内候选基金池" } },
    { path: "/tasks", component: Tasks, meta: { title: "定时任务", subtitle: "Windows 计划任务状态与执行时间" } },
    { path: "/trades", component: Trades, meta: { title: "交易记录", subtitle: "自动记账与手动成交明细" } },
  ],
});

const app = createApp(App);
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}
app.use(ElementPlus, { locale: zhCn });
app.use(router);
app.mount("#app");
