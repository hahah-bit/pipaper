import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { fault } from "../errors.js";
import { withDeadline } from "../async/deadline.js";
import { proxyFor, proxyDNSHosts, tunnelAgent, createResilientRequest, decodeResponse } from "./network.js";

export function safeURL(value) {
  try { const u = new URL(String(value)); if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null; return u.href; } catch { return null; }
}
export function privateAddress(address) {
  const a = address.toLowerCase();
  if (net.isIP(a) === 4) return /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|192\.0\.0|198\.(1[89])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(a) || Number(a.split(".")[0]) >= 224;
  // Use public IPv4 DNS answers for document retrieval; IPv6 literals are rejected.
  return true;
}
export async function remote(url, options = {}) {
  return withDeadline(signal => remoteRequest(url, { ...options, signal }), {
    signal: options.signal, ms: options.timeoutMs || 35000, message: `${new URL(url).hostname} 请求超时（含 DNS、连接和下载）`,
  });
}
async function remoteRequest(url, { signal, maxBytes = 18000000, redirects = 0, method = "GET", headers = {} } = {}) {
  const clean = safeURL(url); if (!clean || redirects > 4) throw fault("仅支持公开 HTTPS 来源，或重定向过多");
  signal?.throwIfAborted(); const u = new URL(clean);
  const addresses = net.isIP(u.hostname) ? [{ address: u.hostname, family: 4 }] : await dns.lookup(u.hostname, { all: true, family: 4 });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw fault("资料来源不能指向本机或内部网络");
  const proxy = proxyFor(clean), agent = proxy ? tunnelAgent(proxy, proxyDNSHosts.has(u.hostname) ? u.hostname : addresses[0].address, signal) : null;
  // Direct connections can try every validated IPv4 address instead of pinning
  // the first failing address forever. Redirects receive the same validation.
  let result;
  try { result = await new Promise((resolve, reject) => {
    const req = https.request(u, { method, signal, ...(agent ? { agent } : { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1500 }),
      lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, 4),
      headers: { "User-Agent": "PiPaper-TopicAnalysis/1.0", Accept: "*/*", "Accept-Encoding": "gzip, deflate, br", ...headers } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.resume(); resolve({ redirect: new URL(res.headers.location, u).href }); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const error = fault(`${u.hostname} 返回 HTTP ${res.statusCode}`, 502);
        error.remoteStatus = res.statusCode;
        error.retryAfter = Number(res.headers["retry-after"] || res.headers["x-ratelimit-reset"] || 0);
        const chunks = []; let size = 0;
        res.on("data", c => { if ((size += c.length) < 8000) chunks.push(c); });
        res.on("end", async () => {
          try { const data = JSON.parse((await decodeResponse(Buffer.concat(chunks), res.headers["content-encoding"], 8000)).toString()); if (data.dailyRemainingUsd != null) { error.quota = true; error.retryAfter ||= Number(data.retryAfter || 0); error.message += "（当日匿名/账号配额已用尽，已暂停该来源；不代表零篇论文）"; } } catch {}
          reject(error);
        }); res.on("error", reject); return;
      }
      const chunks = []; let bytes = 0;
      res.on("data", c => { bytes += c.length; if (bytes > maxBytes) res.destroy(fault("资料超过大小上限")); else chunks.push(c); });
      res.on("end", async () => {
        try {
          const buffer = method === "HEAD" ? Buffer.alloc(0) : await decodeResponse(Buffer.concat(chunks), res.headers["content-encoding"], maxBytes);
          signal?.throwIfAborted(); resolve({ url: clean, buffer, contentType: String(res.headers["content-type"] || "") });
        } catch (e) { reject(e); }
      }); res.on("error", reject);
    }); req.on("error", reject); req.end();
  }); } finally { agent?.destroy(); }
  return result.redirect ? remoteRequest(result.redirect, { signal, maxBytes, redirects: redirects + 1, method, headers }) : result;
}
