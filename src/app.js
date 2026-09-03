// PiPaper frontend entry: shared state + api helpers + boot
import "./sidebar.js";
import "./chat.js";
import "./reader.js";
import { initSettings } from "./settings.js";
import { initSidebar, renderPapers, renderCollections, renderProjects } from "./sidebar.js";
import { initChat, refreshSessions, loadCommands } from "./chat.js";
import { initReader } from "./reader.js";

export const state = {
  papers: [],
  collections: [],
  zotero: null,
  currentPaper: null,       // selected paper (reader + composer binding)
  sessionId: null,          // active chat session
  sessions: [],
  models: { models: [], default: null },
  model: null,              // {provider,id} active for current session
  chips: [],                // context chips: {kind:'text'|'image'|'block', tag, body, dataUrl?, mimeType?, page?}
  streaming: false,
  projects: [],             // [{id,name,paperIds}]
  projectId: null,          // active project (null = 全部)
};

// ---------------- api ----------------
async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  getConfig: () => jfetch("/api/config"),
  saveConfig: (patch) => jfetch("/api/config", { method: "PUT", body: patch }),
  papers: (refresh) => jfetch("/api/papers" + (refresh ? "?refresh=1" : "")),
  importPdf: async (file) => {
    const res = await fetch("/api/papers/import", {
      method: "PUT",
      headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  parse: (id, engine) => jfetch(`/api/papers/${id}/parse`, { method: "POST", body: { engine } }),
  job: (id) => jfetch(`/api/jobs/${id}`),
  models: () => jfetch("/api/models"),
  commands: () => jfetch("/api/pi/commands"),
  files: (q) => jfetch("/api/files?q=" + encodeURIComponent(q || "")),
  file: (path) => jfetch("/api/file?path=" + encodeURIComponent(path)),
  projects: () => jfetch("/api/projects"),
  createProject: (name) => jfetch("/api/projects", { method: "POST", body: { name } }),
  updateProject: (id, body) => jfetch(`/api/projects/${id}`, { method: "PUT", body }),
  deleteProject: (id) => jfetch(`/api/projects/${id}`, { method: "DELETE" }),
  sessions: () => jfetch("/api/sessions"),
  createSession: (paperId, projectId, title) => jfetch("/api/sessions", { method: "POST", body: { paperId, projectId, title } }),
  history: (id) => jfetch(`/api/sessions/${id}`),
  delSession: (id) => jfetch(`/api/sessions/${id}`, { method: "DELETE" }),
  setModel: (id, body) => jfetch(`/api/sessions/${id}/model`, { method: "POST", body }),
  compact: (id) => jfetch(`/api/sessions/${id}/compact`, { method: "POST", body: {} }),
  abort: (id) => jfetch(`/api/sessions/${id}/abort`, { method: "POST" }),
};

// ---------------- tiny dom helpers ----------------
export const $ = (sel) => document.querySelector(sel);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function toast(msg, isErr = false) {
  let wrap = $(".toast-wrap");
  if (!wrap) {
    wrap = el("div", { class: "toast-wrap" });
    document.body.append(wrap);
  }
  const t = el("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  wrap.append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3200);
}

// ---------------- chips (context to attach to next message) ----------------
export function addChip(chip) {
  // dedupe identical text chips
  if (chip.kind === "text" && state.chips.some((c) => c.kind === "text" && c.body === chip.body)) {
    toast("该选区已在对话上下文中");
    return;
  }
  state.chips.push(chip);
  renderChips();
}

export function removeChip(i) {
  state.chips.splice(i, 1);
  renderChips();
}

export function renderChips() {
  const wrap = $("#chips");
  wrap.replaceChildren();
  state.chips.forEach((c, i) => {
    const body =
      c.kind === "image"
        ? el("img", { src: c.dataUrl, alt: "截图" })
        : el("span", { class: "c-body" }, c.body.slice(0, 80) || "(空)");
    wrap.append(
      el("span", { class: "chip" },
        el("span", { class: "c-tag" }, c.tag),
        body,
        el("button", { class: "c-x", title: "移除", onclick: () => removeChip(i) }, "✕")
      )
    );
  });
}

// ---------------- boot ----------------
async function boot() {
  initSidebar();
  initChat();
  initReader();
  initSettings();
  try {
    const [paperData, models, projects] = await Promise.all([api.papers(), api.models(), api.projects()]);
    state.papers = paperData.papers;
    state.collections = paperData.collections;
    state.zotero = paperData.zotero;
    state.models = models;
    state.projects = projects.projects || [];
    renderPapers();
    renderCollections();
    renderProjects();
    updateZoteroFoot();
    await loadCommands();
    await refreshSessions();
    if (!state.sessionId) {
      // show welcome state; session is created on first message
      renderWelcome();
    }
  } catch (e) {
    toast("初始化失败: " + (e.message || e), true);
  }
}

export function updateZoteroFoot() {
  const foot = $("#side-foot");
  foot.replaceChildren();
  const z = state.zotero;
  if (z?.syncedAt) {
    foot.append(`Zotero 已同步 ${new Date(z.syncedAt).toLocaleString()} · ${z.papers} 篇`);
  } else {
    foot.append("Zotero 未同步 — 点击 ⚙ 设置数据目录");
  }
}

export function renderWelcome() {
  const msgs = $("#messages");
  msgs.replaceChildren(
    el("div", { class: "welcome" },
      el("div", { class: "big" }), 
      el("h3"), 
      el("p", {},
        "左侧选择论文 → 右侧阅读；划选文字或框选截图加入对话；", el("br"),
        "支持 Zotero 文献库管理与 MinerU / unstructured 精细解析。", el("br"),
        "发送第一条消息时会自动创建会话（pi 内核，可随时回来继续）。"
      )
    )
  );
}

boot();
