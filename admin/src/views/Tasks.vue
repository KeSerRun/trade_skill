<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";

const tasks = ref([]);
const loading = ref(false);
const saving = ref("");
const forms = reactive({});

const enabledCount = computed(() => tasks.value.filter((task) => task.enabled).length);

async function load() {
  loading.value = true;
  try {
    const data = await api.tasks();
    tasks.value = data.tasks;
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

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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

async function runNow(task) {
  try {
    await ElMessageBox.confirm(
      `立即运行「${task.label}」会执行对应脚本，可能推送消息，确定继续？`,
      "立即运行",
      { type: "warning", confirmButtonText: "运行", cancelButtonText: "取消" },
    );
    await api.runTask(task.name);
    await load();
    ElMessage.success("已触发运行");
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
          <span class="chip-label">任务数量</span>
          <span class="chip-value">{{ tasks.length }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">已启用</span>
          <span class="chip-value">{{ enabledCount }}</span>
        </div>
        <div class="chip">
          <span class="chip-label">调度方式</span>
          <span class="chip-value">Windows 计划任务</span>
        </div>
      </div>
      <el-button @click="load">刷新状态</el-button>
    </div>

    <div v-if="tasks.length" class="task-grid">
      <section v-for="task in tasks" :key="task.name" class="panel task-card">
        <div class="panel-head">
          <div>
            <h3>{{ task.label }}</h3>
            <p>{{ task.description }}</p>
          </div>
          <el-tag :type="task.enabled ? 'success' : 'info'">
            {{ task.enabled ? "已启用" : "已停用" }}
          </el-tag>
        </div>
        <div class="panel-body">
          <div class="task-time-row">
            <div class="task-time">{{ forms[task.name]?.time || "—" }}</div>
            <div class="task-time-label">每日执行</div>
          </div>

          <template v-if="task.exists">
            <div class="task-controls">
              <el-time-select
                v-model="forms[task.name].time"
                start="00:00"
                end="23:30"
                step="00:30"
                placeholder="选择时间"
                style="width: 150px"
              />
              <el-switch
                v-model="forms[task.name].enabled"
                active-text="启用"
                inactive-text="停用"
                @change="toggle(task)"
              />
              <el-button type="primary" :loading="saving === task.name" @click="save(task)">
                保存时间
              </el-button>
            </div>

            <div class="task-details">
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
                <strong>{{ task.lastResultText }}</strong>
              </div>
              <div>
                <span>错过次数</span>
                <strong>{{ task.missed ?? 0 }}</strong>
              </div>
            </div>

            <div class="task-actions">
              <el-button @click="runNow(task)">立即运行</el-button>
              <span class="muted mono">{{ task.name }}</span>
            </div>
          </template>

          <el-alert
            v-else
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

    <section class="panel" style="margin-top: 16px">
      <div class="panel-head">
        <div>
          <h3>说明</h3>
          <p>后台只调用 Windows 计划任务接口，不维护独立定时器</p>
        </div>
      </div>
      <div class="panel-body">
        <ul class="muted" style="line-height: 1.9; margin: 0; padding-left: 18px">
          <li>14:30 任务会生成操作、自动记账并推送；15:30 任务会用 ETF 收盘价估算当日盈亏。</li>
          <li>任务只在电脑开机且当前用户已登录时运行；睡眠会尝试唤醒，关机不会补跑。</li>
          <li>修改时间后立即生效；停用只是暂停触发，不会删除任务。</li>
          <li>“立即运行”会真实执行脚本，可能生成并推送一份报告。</li>
        </ul>
      </div>
    </section>
  </div>
</template>
