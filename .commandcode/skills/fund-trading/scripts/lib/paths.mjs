import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".commandcode")) || fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot(__dirname);

export const STATE_DIR = process.env.FUND_TRADE_HOME
  ? path.resolve(process.env.FUND_TRADE_HOME)
  : path.join(PROJECT_ROOT, ".fund-trading");

export const DB_FILE = process.env.FUND_TRADE_DB
  ? path.resolve(process.env.FUND_TRADE_DB)
  : path.join(STATE_DIR, "fund.db");

export const CACHE_DIR = path.join(STATE_DIR, "cache");
