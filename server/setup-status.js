// 统一环境自检：能力注册表 + 状态探测（首次使用引导的数据源）
// 能力分四组：core（内置必选）/ docker（可选增强 sidecar）/ download（本地安装应用）/ keys（可选凭证）
// 状态：ok 已就绪 · todo 未配置（附安装指引）· down 已配置但探测失败 · off 未启用（无需动作）
// 所有探测只回报状态与计数，绝不回传密钥明文。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DATA_DIR, getConfig } from "./config.js";
import { detectDataDir, syncZotero } from "./zotero.js";
import * as h from "./harness.js";

const LINKS = {
  pi: { label: "pi 安装与登录（pi-mono）", url: "https://github.com/badlogic/pi-mono" },
  docker: { label: "下载 Docker Desktop", url: "https://www.docker.com/products/docker-desktop/" },
  zotero: { label: "下载 Zotero", url: "https://www.zotero.org/download/" },
  mineru: { label: "申请 MinerU API Token", url: "https://mineru.net/" },
  mineruLocal: { label: "MinerU 本地部署（GitHub）", url: "https://github.com/opendatalab/MinerU" },
  unstructured: { label: "unstructured 官网", url: "https://unstructured.io/" },
  s2: { label: "申请 Semantic Scholar API Key", url: "https://www.semanticscholar.org/product-api" },
};

async function probeHttp(url, timeoutMs = 2500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.cause?.code || e.message || e).slice(0, 120) };
  }
}

function probeCommand(cmd, args = ["--version"], timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: true, stdio: "ignore" });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e) });
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "命令无响应" });
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code }); });
  });
}

function searchSources() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "search-sources.json"), "utf8")) || [];
  } catch {
    return [];
  }
}

// modelList 有一定开销（ModelRuntime），缓存 30 秒供状态轮询复用
let chatCache = { at: 0, value: null };
async function chatProbe() {
  if (chatCache.value && Date.now() - chatCache.at < 30000) return chatCache.value;
  let value;
  try {
    const { models } = await h.modelList();
    value = { count: models.length, providers: [...new Set(models.map((m) => m.provider))].slice(0, 4) };
  } catch {
    value = { count: 0, providers: [] };
  }
  chatCache = { at: Date.now(), value };
  return value;
}

// ---- 能力注册表：probe() 返回 { status, detail }，setup 是未就绪时的指引 ----
const REGISTRY = [
  {
    id: "chat",
    group: "core",
    label: "模型对话内核（pi）",
    why: "复用 pi CLI 的已登录模型（~/.pi/agent），无需在本应用里填模型密钥",
    async probe() {
      const hasAuth = fs.existsSync(path.join(getAgentDir(), "auth.json"));
      const { count, providers } = await chatProbe();
      if (!hasAuth) return { status: "todo", detail: "未找到 ~/.pi/agent/auth.json — 尚未登录过 pi" };
      if (!count) return { status: "todo", detail: "auth.json 存在，但没有可用模型 — 请在 pi CLI 里完成登录" };
      return { status: "ok", detail: `${count} 个可用模型（${providers.join(" / ") || "pi"}）` };
    },
    setup: {
      command: "npm install -g @earendil-works/pi-coding-agent  # 安装后运行 pi 完成一次登录",
      links: [LINKS.pi],
    },
  },
  {
    id: "unstructured",
    group: "docker",
    label: "unstructured 本地解析",
    why: "元素级 PDF 解析（表格 HTML / 图片 / 坐标），Docker sidecar，无需密钥",
    async probe() {
      const mode = getConfig().parse?.unstructured?.mode || "off";
      const r = await probeHttp("http://localhost:8000/healthcheck");
      if (r.ok) return { status: "ok", detail: `本地服务可用（localhost:8000，当前模式：${mode}）` };
      if (mode === "off") return { status: "off", detail: "未启用（可选增强；内置 pdf.js 兜底始终可用）" };
      return { status: mode === "local" ? "down" : "todo", detail: `本地服务未启动（localhost:8000 无响应）${r.error ? "：" + r.error : ""}` };
    },
    setup: {
      command: "docker compose up -d",
      links: [LINKS.docker, LINKS.unstructured],
    },
  },
  {
    id: "libretranslate",
    group: "docker",
    label: "LibreTranslate 翻译",
    why: "阅读器段落悬停「译」的即时翻译，Docker sidecar，无需密钥",
    async probe() {
      const url = getConfig().translate?.url || "http://localhost:5001";
      const r = await probeHttp(url.replace(/\/$/, "") + "/languages");
      if (r.ok) return { status: "ok", detail: `翻译服务可用（${url}）` };
      return { status: "todo", detail: `翻译服务未启动（${url} 无响应）${r.error ? "：" + r.error : ""}` };
    },
    setup: {
      command: "docker compose up -d",
      links: [LINKS.docker],
    },
  },
  {
    id: "zotero",
    group: "download",
    label: "Zotero 文献库",
    why: "读取 zotero.sqlite 快照同步文献库；Zotero 装好后自动探测，无需填路径",
    async probe() {
      const cfg = getConfig().zotero || {};
      const dir = detectDataDir(cfg.dataDir);
      if (dir) return { status: "ok", detail: `已检测到数据目录：${dir}` };
      return { status: "todo", detail: "未检测到 zotero.sqlite（安装 Zotero 并建库后自动识别）" };
    },
    setup: {
      links: [LINKS.zotero],
    },
  },
  {
    id: "mineru",
    group: "keys",
    label: "MinerU 精排解析（可选）",
    why: "公式/表格/图片精排；云端 API 需 token，本地部署需 CLI，不启用则走兜底",
    async probe() {
      const m = getConfig().parse?.mineru || {};
      if (m.mode === "api") {
        return m.token
          ? { status: "ok", detail: "云端 API 模式，token 已配置" }
          : { status: "todo", detail: "云端 API 模式需要 token（mineru.net 申请）" };
      }
      if (m.mode === "local") {
        const r = await probeCommand(m.cmd || "mineru");
        return r.ok
          ? { status: "ok", detail: `本地 CLI 可用（${m.cmd || "mineru"}）` }
          : { status: "todo", detail: `本地模式但未找到命令「${m.cmd || "mineru"}」（pip install "mineru[core]"）` };
      }
      return { status: "off", detail: "未启用（内置 pdf.js 兜底可解析纯文本）" };
    },
    setup: {
      links: [LINKS.mineru, LINKS.mineruLocal],
    },
  },
  {
    id: "unstructured-key",
    group: "keys",
    label: "unstructured 云端 Key（可选）",
    why: "仅云端 API 模式需要；本地 Docker 模式无需密钥",
    async probe() {
      const u = getConfig().parse?.unstructured || {};
      if (u.mode === "api") {
        return u.apiKey
          ? { status: "ok", detail: "云端 API 模式，key 已配置" }
          : { status: "todo", detail: "云端 API 模式需要 API Key" };
      }
      return { status: "off", detail: "未使用云端模式，无需密钥" };
    },
    setup: {
      links: [LINKS.unstructured],
    },
  },
  {
    id: "search-keys",
    group: "keys",
    label: "检索源密钥（可选增强）",
    why: "Semantic Scholar 有 key 解除限速；学术镜像可粘贴浏览器 Cookie",
    async probe() {
      const sources = searchSources();
      const s2 = sources.some((s) => s.id === "semanticscholar" && s.apiKey);
      const scholar = sources.some((s) => s.type === "scholar-mirror" && s.cookie);
      if (s2 && scholar) return { status: "ok", detail: "Semantic Scholar key 与镜像 Cookie 均已配置" };
      if (s2 || scholar) return { status: "ok", detail: s2 ? "Semantic Scholar key 已配置" : "学术镜像 Cookie 已配置" };
      return { status: "todo", detail: "均未配置（可选项；无 key 时 S2 走限速开放通道）" };
    },
    setup: {
      links: [LINKS.s2],
    },
  },
];

export async function setupStatus() {
  const items = [];
  for (const cap of REGISTRY) {
    let probeResult;
    try {
      probeResult = await cap.probe();
    } catch (e) {
      probeResult = { status: "down", detail: "探测失败：" + String(e.message || e).slice(0, 120) };
    }
    items.push({ id: cap.id, group: cap.group, label: cap.label, why: cap.why, ...probeResult, setup: cap.setup });
  }
  const summary = {
    ok: items.filter((i) => i.status === "ok").length,
    todo: items.filter((i) => i.status === "todo").length,
    down: items.filter((i) => i.status === "down").length,
    off: items.filter((i) => i.status === "off").length,
  };
  return { items, summary, onboardedAt: getConfig().setup?.onboardedAt || null };
}

// 单项实时连通性测试（比 status 更深：真实同步 / 更长超时）
export async function setupTest(id) {
  const cap = REGISTRY.find((c) => c.id === id);
  if (!cap) throw Object.assign(new Error("未知能力: " + id), { status: 404 });
  if (id === "zotero") {
    const dir = detectDataDir(getConfig().zotero?.dataDir);
    if (!dir) return { id, ok: false, detail: "未检测到 Zotero 数据目录" };
    const snap = syncZotero(getConfig().zotero);
    return { id, ok: true, detail: `同步成功：${snap.items.length} 篇（${snap.dataDir || dir}）` };
  }
  if (id === "unstructured" || id === "libretranslate") {
    const url = id === "unstructured" ? "http://localhost:8000/healthcheck" : (getConfig().translate?.url || "http://localhost:5001").replace(/\/$/, "") + "/languages";
    const r = await probeHttp(url, 8000);
    return { id, ok: r.ok, detail: r.ok ? `连通（${url}）` : `无响应：${url}${r.error ? " " + r.error : ""}` };
  }
  if (id === "mineru") {
    const m = getConfig().parse?.mineru || {};
    if (m.mode === "local") {
      const r = await probeCommand(m.cmd || "mineru");
      return { id, ok: r.ok, detail: r.ok ? `本地 CLI 可用（${m.cmd || "mineru"}）` : `命令不可用：${r.error || "exit " + r.code}` };
    }
  }
  const { status, detail } = await cap.probe();
  return { id, ok: status === "ok", detail };
}
