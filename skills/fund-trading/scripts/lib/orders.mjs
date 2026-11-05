import { loadOrdersFromDb, saveOrdersToDb } from "./sqlite.mjs";
import { nowIso } from "./store.mjs";

export const ORDER_STATUS = {
  PENDING: "PENDING",
  FILLED: "FILLED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
};

export function loadOrders() {
  return loadOrdersFromDb();
}

export function saveOrders(orders) {
  saveOrdersToDb(orders);
}

export function findOrder(id) {
  return loadOrders().find((order) => order.id === id) ?? null;
}

export function createOrder(order) {
  const orders = loadOrders();
  const record = {
    id: `o${Date.now().toString(36)}`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: ORDER_STATUS.PENDING,
    ...order,
  };
  orders.push(record);
  saveOrders(orders);
  return record;
}

export function updateOrder(id, patch) {
  const orders = loadOrders();
  const index = orders.findIndex((order) => order.id === id);
  if (index === -1) throw new Error(`未找到指令 ${id}`);
  orders[index] = { ...orders[index], ...patch, updatedAt: nowIso() };
  saveOrders(orders);
  return orders[index];
}
