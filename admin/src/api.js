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
  updateAccount: (body) => request("/account", { method: "PUT", body: JSON.stringify(body) }),
  savePosition: (body) => request("/positions", { method: "POST", body: JSON.stringify(body) }),
  deletePosition: (code) => request(`/positions/${encodeURIComponent(code)}`, { method: "DELETE" }),
  trades: (query = "") => request(`/trades${query}`),
  saveRules: (body) => request("/rules", { method: "PUT", body: JSON.stringify(body) }),
  tasks: () => request("/tasks"),
  setTradeMode: (mode) => request("/trade-mode", { method: "PUT", body: JSON.stringify({ mode }) }),
  updateTask: (name, body) => request(`/tasks/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) }),
  runTask: (name) => request(`/tasks/${encodeURIComponent(name)}/run`, { method: "POST" }),
};
