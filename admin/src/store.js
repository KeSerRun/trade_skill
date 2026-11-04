import { reactive } from "vue";
import { api } from "./api";

export const store = reactive({
  loading: false,
  account: null,
  positions: [],
  summary: null,
  rules: null,
  meta: null,
});

export async function loadState() {
  store.loading = true;
  try {
    const data = await api.state();
    store.account = data.account;
    store.positions = data.positions;
    store.summary = data.summary;
    store.rules = data.rules;
    store.meta = data.meta;
  } finally {
    store.loading = false;
  }
}

export function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function signed(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value) > 0 ? `+${money(value)}` : money(value);
}
