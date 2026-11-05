import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasProjectMarker(dir) {
  return fs.existsSync(path.join(dir, ".commandcode")) || fs.existsSync(path.join(dir, ".git"));
}

function findProjectRoot(start) {
  if (process.env.FUND_TRADE_PROJECT_ROOT) {
    return path.resolve(process.env.FUND_TRADE_PROJECT_ROOT);
  }
  const cwd = process.cwd();
  const startInsideCwd = start === cwd || start.startsWith(cwd + path.sep);
  const searchFrom = startInsideCwd ? start : cwd;

  let dir = searchFrom;
  for (let i = 0; i < 12; i++) {
    if (hasProjectMarker(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export const PROJECT_ROOT = findProjectRoot(__dirname);

export const STATE_DIR = process.env.FUND_TRADE_HOME
  ? path.resolve(process.env.FUND_TRADE_HOME)
  : path.join(PROJECT_ROOT, ".fund-trading");

export const DB_FILE = process.env.FUND_TRADE_DB
  ? path.resolve(process.env.FUND_TRADE_DB)
  : path.join(STATE_DIR, "fund.db");

export const CACHE_DIR = path.join(STATE_DIR, "cache");
