const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function request(url, options = {}) {
  const { headers = {}, encoding = "utf8", retries = 2, timeoutMs = 15000 } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": DEFAULT_UA, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (encoding === "gbk") return new TextDecoder("gbk").decode(buffer);
      return buffer.toString("utf8");
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`请求失败 ${url}: ${lastError?.message ?? "unknown error"}`);
}

export function stripJsonp(text) {
  const trimmed = text.trim();
  const start = trimmed.search(/[[{]/);
  if (start === -1) return trimmed;
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  return trimmed.slice(start, end + 1);
}

export async function requestJson(url, options = {}) {
  const text = await request(url, options);
  return JSON.parse(stripJsonp(text));
}

export async function probe(urls, options = {}) {
  const results = [];
  for (const [name, url, extra] of urls) {
    const started = Date.now();
    try {
      await request(url, { ...options, ...extra, retries: 0, timeoutMs: 8000 });
      results.push({ name, ok: true, latencyMs: Date.now() - started });
    } catch (error) {
      results.push({ name, ok: false, latencyMs: Date.now() - started, error: error.message });
    }
  }
  return results;
}
