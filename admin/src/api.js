const BASE = "/api";

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = { ok: false, error: `HTTP ${response.status}` };
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

export const api = {
  state: () => request("/state"),
  marketSnapshot: () => request("/market/snapshot"),
  marketTrend: (code) => request(`/market/trend?code=${encodeURIComponent(code)}`),
  marketCandles: (code, period = "day") =>
    request(`/market/candles?code=${encodeURIComponent(code)}&period=${encodeURIComponent(period)}`),
  marketQuotes: (items) => request(`/market/quotes?items=${encodeURIComponent(items.join(","))}`),
  marketNavs: (items) => request(`/market/navs?items=${encodeURIComponent(items.join(","))}`),
  products: (params = {}) => request(`/products?${new URLSearchParams(params)}`),
  syncProducts: () => request("/products/sync", { method: "POST" }),
  updateAccount: (body) => request("/account", { method: "PUT", body: JSON.stringify(body) }),
  savePosition: (body) => request("/positions", { method: "POST", body: JSON.stringify(body) }),
  deletePosition: (code) => request(`/positions/${encodeURIComponent(code)}`, { method: "DELETE" }),
  trades: (query = "") => request(`/trades${query}`),
  saveRules: (body) => request("/rules", { method: "PUT", body: JSON.stringify(body) }),
  tasks: () => request("/tasks"),
  createTask: (body) => request("/tasks", { method: "POST", body: JSON.stringify(body) }),
  deleteTask: (id) => request(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  watchlist: () => request("/watchlist"),
  saveWatchlist: (body) => request("/watchlist", { method: "POST", body: JSON.stringify(body) }),
  deleteWatchlist: (market, code) => request(`/watchlist/${encodeURIComponent(market)}/${encodeURIComponent(code)}`, { method: "DELETE" }),
  settings: () => request("/settings"),
  saveRuntime: (body) => request("/settings/runtime", { method: "PUT", body: JSON.stringify(body) }),
  saveAdvice: (body) => request("/settings/advice", { method: "PUT", body: JSON.stringify(body) }),
  saveNotify: (body) => request("/settings/notify", { method: "PUT", body: JSON.stringify(body) }),
  setTradeMode: (mode) => request("/trade-mode", { method: "PUT", body: JSON.stringify({ mode }) }),
  updateTask: (name, body) => request(`/tasks/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) }),
  runTask: (name) => request(`/tasks/${encodeURIComponent(name)}/run`, { method: "POST" }),
};
