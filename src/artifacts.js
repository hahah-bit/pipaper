// 产出物：会话中 agent 通过 write/edit 写出的文件。登记来源有二：
// 1) 历史快照（renderHistory 传入的 messages，含 assistant 消息的 toolCall parts）
// 2) 实时事件（tool_start / tool_end）
// 展示在阅读器「产出物」tab：左列表、右查看器（Markdown 渲染 / 图片 / 文本）。
import { api, $, el, toast } from "./app.js";

const WRITER_TOOLS = new Set(["write", "edit"]);
const TOOL_CHIP = { write: "写文件", edit: "编辑" };

// path -> { path, name, dir, tool, error, missing }；Map 保持插入序，最新写在最后
const registry = new Map();
const callPath = new Map(); // toolCallId -> path（实时事件回填错误状态用）
let currentSession;         // undefined = 未初始化，避免与「无会话(null)」混淆
let activePath = null;
let viewerSeq = 0;
let listEl, listBodyEl, listCountEl, railLabelEl, viewerEl;
let collapsed = false;
const COLLAPSE_KEY = "pipaper.artifacts.collapsed";

const normalizePath = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
function splitPath(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? { dir: p.slice(0, i), name: p.slice(i + 1) } : { dir: "", name: p };
}
function fileIcon(name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "🖼";
  if (["md", "markdown", "txt"].includes(ext)) return "📝";
  if (["csv", "tsv", "xlsx"].includes(ext)) return "📊";
  if (["json", "mjs", "js", "ts", "py", "tex", "bib", "html", "css"].includes(ext)) return "🧾";
  return "📄";
}

function add(tool, rawPath, callId) {
  const path = normalizePath(rawPath);
  if (!path) return;
  if (callId) callPath.set(callId, path);
  const prev = registry.get(path);
  const { dir, name } = splitPath(path);
  const item = { path, dir, name, tool: prev?.tool || tool, error: prev?.error || false };
  registry.delete(path); // 重新插入使其排到最新
  registry.set(path, item);
}

function resetForSession(sessionId) {
  if (sessionId === currentSession) return;
  currentSession = sessionId;
  registry.clear();
  callPath.clear();
  activePath = null;
  if (viewerEl) viewerEl.replaceChildren();
  renderList();
}

// 历史快照是权威来源：每次全量重建（会话切换由 resetForSession 先行清理）
export function recordHistory(history) {
  if (!listEl) return;
  resetForSession(history?.id ?? null);
  registry.clear();
  for (const m of history?.messages || []) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts || []) {
      if (p.type === "toolCall" && WRITER_TOOLS.has(p.name)) add(p.name, p.args?.path ?? p.args?.file_path, p.id);
    }
  }
  renderList();
}

export function recordEvent(ev) {
  if (!listEl) return;
  if (ev.t === "tool_start" && WRITER_TOOLS.has(ev.name)) {
    add(ev.name, ev.args?.path ?? ev.args?.file_path, ev.id);
    renderList();
  } else if (ev.t === "tool_end") {
    const path = callPath.get(ev.id);
    if (path && registry.has(path)) {
      registry.get(path).error = !!ev.isError;
      renderList();
    }
  }
}

function renderList() {
  if (!listEl) return;
  const badge = $("#tab-artifacts-count");
  badge.hidden = !registry.size;
  badge.textContent = registry.size || "";
  const n = registry.size ? ` ${registry.size}` : "";
  listCountEl.textContent = n;
  railLabelEl.textContent = "产出物" + n;

  const items = [...registry.values()].reverse(); // 最新产出在最上
  listBodyEl.replaceChildren();
  if (!items.length) {
    listBodyEl.append(el("div", { class: "artifact-empty" },
      el("div", { class: "artifact-empty-icon" }, "📦"),
      el("p", {}, "本会话还没有产出物"),
      el("p", { class: "res-note" }, "对话中让 agent 写文件（笔记、代码、导出等），生成结果会出现在这里，点击即可查看。")));
    return;
  }
  for (const item of items) {
    const row = el("button", { class: "artifact-item" + (item.path === activePath ? " active" : "") + (item.error ? " err" : ""), type: "button", title: item.path },
      el("span", { class: "artifact-glyph" }, fileIcon(item.name)),
      el("span", { class: "artifact-text" },
        el("span", { class: "artifact-name" }, item.name),
        item.dir ? el("span", { class: "artifact-dir" }, item.dir) : null),
      el("span", { class: "artifact-tool" }, TOOL_CHIP[item.tool] || item.tool));
    row.addEventListener("click", () => openArtifact(item.path));
    listBodyEl.append(row);
  }
}

async function openArtifact(path) {
  activePath = path;
  for (const row of listEl.querySelectorAll(".artifact-item")) row.classList.toggle("active", row.title === path);
  const seq = ++viewerSeq;
  const item = registry.get(path);
  viewerEl.replaceChildren(el("div", { class: "artifact-loading" }, "加载中…"));
  let res;
  try {
    res = await api.file(path);
  } catch (e) {
    if (seq !== viewerSeq) return;
    if (registry.has(path)) { registry.get(path).missing = true; }
    viewerEl.replaceChildren(el("div", { class: "artifact-missing" },
      el("h3", {}, "无法读取该产出物"),
      el("p", {}, e.message + " · " + path)));
    return;
  }
  if (seq !== viewerSeq) return;
  if (registry.has(path)) registry.get(path).missing = false;

  const head = el("div", { class: "artifact-head" },
    el("span", { class: "artifact-head-icon" }, fileIcon(item?.name || path)),
    el("span", { class: "artifact-head-path", title: path }, path),
    item ? el("span", { class: "artifact-chip" }, TOOL_CHIP[item.tool] || item.tool) : null,
    el("span", { class: "spacer" }),
    el("button", { class: "tool-btn", onclick: async () => { await navigator.clipboard.writeText(path); toast("已复制路径"); } }, "复制路径"));
  const body = el("div", { class: "artifact-body" });
  viewerEl.replaceChildren(el("div", { class: "artifact-view" }, head, body));

  if (res.kind === "image") {
    body.append(el("img", { class: "artifact-image", src: res.dataUrl, alt: res.label || path }));
  } else if (/\.md$|\.markdown$/i.test(path)) {
    const doc = el("div", { class: "paper-doc artifact-doc" });
    body.append(doc);
    try {
      const { renderMd } = await import("./chat.js");
      renderMd(res.content || "", doc);
    } catch (e) {
      doc.replaceChildren(el("pre", {}, res.content || ""));
    }
  } else {
    body.append(el("pre", { class: "artifact-code" }, el("code", {}, res.content ?? res.label ?? "")));
  }
}

function applyCollapsed() {
  $("#artifacts-view").classList.toggle("list-collapsed", collapsed);
  const btn = listEl.querySelector(".artifact-list-toggle");
  btn.textContent = collapsed ? "»" : "«";
  btn.title = collapsed ? "展开产出物列表" : "折叠产出物列表";
}
function setCollapsed(v) {
  collapsed = v;
  try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch {}
  applyCollapsed();
}

export function initArtifacts() {
  listEl = $("#artifact-list");
  viewerEl = $("#artifact-viewer");
  listCountEl = el("span", { class: "artifact-list-count" });
  railLabelEl = el("span", { class: "artifact-rail-label", title: "展开产出物列表", onclick: () => setCollapsed(false) });
  listBodyEl = el("div", { class: "artifact-list-body" });
  listEl.append(
    el("div", { class: "artifact-list-head" },
      el("span", { class: "artifact-list-title" }, "产出物", listCountEl),
      el("button", { class: "icon-btn artifact-list-toggle", onclick: () => setCollapsed(!collapsed) }),
      railLabelEl),
    listBodyEl);
  collapsed = (() => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } })();
  applyCollapsed();
  $("#tab-artifacts").addEventListener("click", async () => {
    const { switchTab } = await import("./reader.js");
    switchTab("artifacts");
  });
  renderList();
}
