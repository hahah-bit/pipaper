import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { gunzip, inflate, brotliDecompress } from "node:zlib";
import { promisify } from "node:util";

const decompressors = { gzip: promisify(gunzip), "x-gzip": promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) };
export async function decodeResponse(buffer, encoding, maxBytes) {
  const encodings = String(encoding || "identity").toLowerCase().split(",").map(s => s.trim()).reverse();
  for (const type of encodings) {
    if (type === "identity") continue;
    if (!decompressors[type]) throw new Error(`来源使用了不支持的内容压缩格式：${type}`);
    buffer = await decompressors[type](buffer, { maxOutputLength: maxBytes });
  }
  // Some publisher/CDN responses contain gzip bytes but omit Content-Encoding.
  // Recognize the gzip magic rather than turning binary data into UTF-8 text.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b && buffer[2] === 0x08) buffer = await decompressors.gzip(buffer, { maxOutputLength: maxBytes });
  if (buffer.length > maxBytes) throw new Error("解压后的资料超过大小上限");
  return buffer;
}

export function readableCachedText(text) {
  // Old requests saved gzip bytes as UTF-8 even when servers ignored identity.
  // Such artifacts must be fetched again, never used as publication evidence.
  return typeof text === "string" && !/[\u0000-\u0008\u000e-\u001f]|\ufffd{2}/.test(text.slice(0, 2000));
}

let windowsProxy, checkedAt = 0;
export function systemProxy() {
  if (process.platform !== "win32") return "";
  if (Date.now() - checkedAt < 60000) return windowsProxy;
  checkedAt = Date.now(); windowsProxy = "";
  try {
    const result = execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", timeout: 2000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(result)) windowsProxy = result.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || "";
  } catch { /* No static Windows proxy configured. */ }
  return windowsProxy;
}
export function proxyFor(url, { env = process.env, system = systemProxy } = {}) {
  const u = new URL(url);
  const bypass = String(env.NO_PROXY || env.no_proxy || "").split(",").some(value => {
    const entry = value.trim().toLowerCase(); if (entry === "*") return true;
    const [host, port] = entry.replace(/^\*?\./, "").split(":");
    return host && (!port || port === (u.port || "443")) && (u.hostname === host || u.hostname.endsWith(`.${host}`));
  });
  if (bypass) return null;
  let value = env.PIPAPER_HTTPS_PROXY || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!value) {
    value = system();
    if (value?.includes("=")) value = value.split(";").find(s => s.trim().startsWith("https="))?.split("=").slice(1).join("=") || "";
  }
  if (!value || value === "direct") return null;
  const proxy = new URL(value.includes("://") ? value : `http://${value}`);
  if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("检索代理仅支持 HTTP/HTTPS CONNECT，请配置 PIPAPER_HTTPS_PROXY");
  return proxy;
}

// Only fixed, built-in scholarly endpoints may use the trusted proxy's DNS.
// Arbitrary document hosts still connect to locally validated public IPs.
export const proxyDNSHosts = new Set(["api.openalex.org", "api.semanticscholar.org", "eutils.ncbi.nlm.nih.gov", "api.crossref.org", "export.arxiv.org", "arxiv.org", "api.github.com", "api2.openreview.net"]);

export function tunnelAgent(proxy, target, signal) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const headers = { Host: `${target}:443` };
    if (proxy.username || proxy.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const connect = (proxy.protocol === "https:" ? https : http).request(proxy, { method: "CONNECT", path: `${target}:443`, headers, signal, agent: false });
    let socket, settled = false;
    const done = (error, value) => { if (!settled) { settled = true; callback(error, value); } };
    const abort = () => { connect.destroy(); socket?.destroy(); done(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    connect.once("error", error => { signal.removeEventListener("abort", abort); done(error); });
    connect.once("connect", (res, raw, head) => {
      socket = raw;
      if (res.statusCode !== 200) { raw.destroy(); signal.removeEventListener("abort", abort); done(Object.assign(new Error(`检索代理 CONNECT 返回 HTTP ${res.statusCode}`), { code: "EPROXY" })); return; }
      if (head.length) raw.unshift(head);
      const host = options.servername || options.host;
      socket = tls.connect({ socket: raw, host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true });
      socket.once("error", error => done(error));
      socket.once("close", () => signal.removeEventListener("abort", abort));
      socket.once("secureConnect", () => done(null, socket));
    });
    connect.end();
  };
  return agent;
}

export function createResilientRequest(request, { threshold = 3 } = {}) {
  const failures = new Map();
  return async (url, options = {}) => {
    options.signal?.throwIfAborted();
    const host = new URL(url).hostname, state = failures.get(host);
    if (state?.count >= threshold) throw Object.assign(new Error(`${host} 连续请求失败，本轮已暂停该来源：${state.message}`), { code: "ESOURCEPAUSED", sourcePaused: true });
    try { const result = await request(url, options); failures.delete(host); return result; }
    catch (e) {
      options.signal?.throwIfAborted();
      if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPROXY|CERT|TLS|ABORT_ERR/.test(e.code || "") || /超时|certificate|socket hang up|operation was aborted/i.test(e.message) || e.remoteStatus >= 500 || [403, 406, 407, 451].includes(e.remoteStatus)) {
        failures.set(host, { count: (failures.get(host)?.count || 0) + 1, message: e.message });
      } else if (e.remoteStatus) failures.delete(host);
      throw e;
    }
  };
}
