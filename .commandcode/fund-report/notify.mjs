#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const stateDir = process.env.FUND_TRADE_HOME ? path.resolve(process.env.FUND_TRADE_HOME) : path.join(root, ".fund-trading");
const configPath = path.join(stateDir, "notify.json");

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    return { channel: "none" };
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function chunkByBytes(text, limit) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    let candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate, "utf8") > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
    while (Buffer.byteLength(current, "utf8") > limit) {
      let cut = current.length;
      while (cut > 1 && Buffer.byteLength(current.slice(0, cut), "utf8") > limit) cut -= 1;
      chunks.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function post(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  return body;
}

function assertOk(body, label, okCodes) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }
  const code = data.code ?? data.errcode;
  if (code !== undefined && !okCodes.includes(Number(code))) {
    throw new Error(`${label} 返回错误 code=${code}: ${data.message ?? data.errmsg ?? data.msg ?? body.slice(0, 160)}`);
  }
  return body;
}

async function sendWecom(config, title, content) {
  if (!config.wecomWebhook) throw new Error("notify.json 缺少 wecomWebhook");
  const parts = chunkByBytes(`## ${title}\n${content}`, 3800);
  for (const part of parts) {
    const body = await post(config.wecomWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: part } }),
    });
    assertOk(body, "企业微信", [0]);
  }
  return parts.length;
}

async function sendServerChan(config, title, content) {
  if (!config.serverChanKey) throw new Error("notify.json 缺少 serverChanKey");
  const body = await post(`https://sctapi.ftqq.com/${config.serverChanKey}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title, desp: content }).toString(),
  });
  assertOk(body, "Server酱", [0]);
  return 1;
}

async function sendPushplus(config, title, content) {
  if (!config.pushplusToken) throw new Error("notify.json 缺少 pushplusToken");
  const body = await post("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: config.pushplusToken, title, content, template: "markdown" }),
  });
  assertOk(body, "PushPlus", [200]);
  return 1;
}

async function main() {
  const config = loadConfig();
  const test = process.argv.includes("--test");
  const file = arg("file");
  const date = arg("date", new Date().toISOString().slice(0, 10));
  const title = arg("title", `${config.titlePrefix ?? "基金日报"} ${date}`);

  let content;
  if (test) {
    content = "推送通道测试：如果你看到这条消息，说明基金日报可以正常送达。";
  } else {
    if (!file) throw new Error("需要 --file <报告路径>");
    content = fs.readFileSync(file, "utf8");
  }

  const channel = config.channel ?? "none";
  if (channel === "none") {
    process.stdout.write(`${JSON.stringify({ ok: true, channel, sent: false, note: "channel=none，仅落盘未推送" }, null, 2)}\n`);
    return;
  }

  const senders = { wecom: sendWecom, serverchan: sendServerChan, pushplus: sendPushplus };
  const sender = senders[channel];
  if (!sender) throw new Error(`未知推送通道: ${channel}`);
  const parts = await sender(config, title, content);
  process.stdout.write(`${JSON.stringify({ ok: true, channel, sent: true, parts }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
