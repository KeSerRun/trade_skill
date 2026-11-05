import { spawnSync } from "node:child_process";

export function ensureUtf8Console() {
  if (process.platform === "win32" && process.stdout.isTTY) {
    try {
      spawnSync("chcp", ["65001"], { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

export function parseArgs(argv, valueFlags = []) {
  const positional = [];
  const flags = {};
  const valueSet = new Set(valueFlags);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    if (valueSet.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

export function numberFlag(flags, name, fallback = null) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) throw new Error(`参数 --${name} 必须是数字，收到: ${flags[name]}`);
  return value;
}

export function requireFlag(flags, name) {
  if (flags[name] === undefined || flags[name] === true) {
    throw new Error(`缺少必需参数 --${name}`);
  }
  return flags[name];
}

export function isJsonMode(flags) {
  if (flags.table) return false;
  if (flags.json) return true;
  return !process.stdout.isTTY;
}

export function fail(message, extra) {
  const payload = { ok: false, error: message, ...(extra ? { detail: extra } : {}) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}
