import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");
const configPath = path.join(projectRoot, ".commandcode", "fund-report", "config.json");
const MODES = ["otc", "exchange"];

export function readReportConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function getTradeMode() {
  const config = readReportConfig();
  return config.marketMode === "exchange" ? "exchange" : "otc";
}

export function getWatchlists() {
  const config = readReportConfig();
  const lists = config.watchlists ?? { otc: config.watchlist ?? [], exchange: [] };
  return Object.fromEntries(
    Object.entries(lists).map(([mode, items]) => [
      mode,
      items.map((item) => ({
        code: item.code,
        name: item.name ?? null,
        sector: item.sector ?? null,
        benchmark: item.benchmark ?? null,
      })),
    ]),
  );
}

export function getTradeSettings() {
  return { mode: getTradeMode(), watchlists: getWatchlists() };
}

export function setTradeMode(mode) {
  if (!MODES.includes(mode)) throw new Error("mode 只能是 otc 或 exchange");
  const config = readReportConfig();
  config.marketMode = mode;
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, configPath);
  return getTradeSettings();
}
