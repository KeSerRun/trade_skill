import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extra = process.argv.slice(2);

const api = spawn(process.execPath, ["--no-warnings", path.join(root, "server", "index.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const web = spawn(process.execPath, [viteBin, ...extra], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [api, web]) {
    if (!child.killed) child.kill();
  }
  process.exitCode = code;
}

api.on("exit", (code) => {
  if (!stopping) {
    console.log(`[api] exited with ${code ?? 1}`);
    shutdown(code ?? 1);
  }
});

web.on("exit", (code) => {
  if (!stopping) {
    console.log(`[web] exited with ${code ?? 1}`);
    shutdown(code ?? 1);
  }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
