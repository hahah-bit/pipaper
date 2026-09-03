import { marked } from "marked";
import DOMPurify from "dompurify";
import renderMathInElement from "katex/contrib/auto-render";
import { api, state, $, el, toast, renderWelcome, renderChips, addChip } from "./app.js";

let sendAbortController = null;
let autoScroll = true;

// ---------------- markdown / math rendering ----------------
marked.setOptions({ gfm: true, breaks: false });

export function renderMd(mdText, container) {
  const html = marked.parse(mdText || "");
  container.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
    });
  } catch {}
}

// ---------------- sessions ----------------
export async function refreshSessions(keepCurrent = true) {
  const data = await api.sessions();
  state.sessions = data.sessions || [];
  if (!keepCurrent || !state.sessions.some((s) => s.id === state.sessionId)) {
    state.sessionId = state.sessions[0]?.id || null;
    if (state.sessionId) await openSession(state.sessionId);
    else renderWelcome();
  }
  renderSessionMenu();
  return state.sessions;
}

async function createSession() {
  try {
    const r = await api.createSession(state.currentPaper?.id || null, state.projectId || null);
    state.sessionId = r.id;
    state.model = r.model;
    await refreshSessions();
    await openSession(r.id);
    toast("新会话已创建");
  } catch (e) {
    toast("创建会话失败: " + e.message, true);
  }
}

export async function openSession(id) {
  state.sessionId = id;
  $("#messages").replaceChildren();
  liveNodes.length = 0;
  renderSessionMenu();
  try {
    const h = await api.history(id);
    if (h.error) throw new Error(h.error);
    state.model = h.model;
    syncModelSelect();
    if (h.thinkingLevel) $("#think-select").value = h.thinkingLevel;
    for (const m of h.messages || []) {
      if (m.role === "user") {
        const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        const nImgs = m.parts.filter((p) => p.type === "image").length;
        addMessageEl("user", text + (nImgs ? `\n[🖼 截图 ×${nImgs}]` : ""));
      } else if (m.role === "assistant") {
        const node = assistantSkeleton();
        $("#messages").append(node.root);
        liveNodes.push(node);
        let textAcc = "";
        let thinkingAcc = "";
        for (const p of m.parts || []) {
          if (p.type === "text") textAcc += p.text;
          else if (p.type === "thinking") thinkingAcc += p.text;
          else if (p.type === "toolCall") addToolCard(node, p.id, p.name, p.args);
        }
        flushAssistant(node, textAcc, thinkingAcc, false);
        collapseThinking(node);
        addMeta(node, m.usage, m.model);
        if (m.error) markError(node, m.error);
      } else if (m.role === "toolResult") {
        fillToolCard(m.toolCallId, m.toolName, m.text, m.isError);
      }
    }
    scrollBottom(true);
    if (!($("#messages").children.length)) renderWelcome();
  } catch (e) {
    toast("打开会话失败: " + e.message, true);
  }
}

function renderSessionMenu() {
  const menu = $("#session-menu");
  menu.replaceChildren();
  const cur = state.sessions.find((s) => s.id === state.sessionId);
  $("#session-title").textContent = cur ? cur.title || "(未命名会话)" : "发送消息时自动创建";
  menu.append(
    el("div", {
      class: "dd-item dd-new",
      onclick: () => { menu.classList.remove("open"); createSession(); },
    }, "＋ 新会话" + (state.projectId ? "（当前项目）" : "（绑定当前论文）"))
  );
  const proj = state.projects.find((p) => p.id === state.projectId);
  const inProject = state.sessions.filter((s) => state.projectId && s.projectId === state.projectId);
  const others = state.sessions.filter((s) => !state.projectId || s.projectId !== state.projectId);
  if (state.projectId && inProject.length) {
    menu.append(el("div", { class: "dd-group" }, `项目「${proj?.name || ""}」`));
    for (const s of inProject) menu.append(sessionRow(s, menu));
  }
  if (others.length) {
    menu.append(el("div", { class: "dd-group" }, inProject.length || state.projectId ? "其他会话" : ""));
    for (const s of others) menu.append(sessionRow(s, menu));
  }
  if (!state.sessions.length) menu.append(el("div", { class: "dd-item", style: { color: "var(--fg2)" } }, "暂无会话"));
}

function sessionRow(s, menu) {
  const projName = s.projectId ? (state.projects.find((p) => p.id === s.projectId)?.name || "") : "";
  return el("div", { class: "dd-item", onclick: () => { menu.classList.remove("open"); openSession(s.id); } },
    el("div", { class: "t" }, (projName ? `[${projName}] ` : "") + (s.title || "(未命名会话)")),
    el("div", { class: "s" }, [s.paperId ? (state.papers.find((p) => p.id === s.paperId)?.title || s.paperId) : "未绑定论文", s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""].join(" · "))
  );
}

// ---------------- message rendering ----------------
// Unified "agent activity" block: thinking + tool calls collapse into ONE
// line (ZCode style) and expand into a timeline. Assistant text renders flat.

function assistantSkeleton() {
  const mdDiv = el("div", { class: "md-body" });
  const bubble = el("div", { class: "bubble md" }, mdDiv);
  const root = el("div", { class: "msg assistant" }, bubble);
  return { root, bubble, mdDiv, toolCards: new Map(), textAcc: "", activity: null, renderTimer: null };
}

function addMessageEl(role, text) {
  const node = el("div", { class: "msg " + role }, el("div", { class: "bubble" }, text));
  $("#messages").append(node);
  scrollBottom();
  return node;
}

function makeActivity() {
  const thinkText = el("div", { class: "act-think" });
  const tail = el("div", { class: "act-tail" });
  const status = el("span", { class: "act-status" }, "思考中");
  const time = el("span", { class: "act-time" });
  const body = el("div", { class: "act-body" }, thinkText);
  const root = el(
    "div",
    {
      class: "activity streaming",
      onclick: () => {
        if (root.classList.contains("streaming")) return;
        const open = root.classList.toggle("open");
        root.querySelector(".t-toggle").textContent = open ? "▾" : "▸";
        body.style.display = open ? "block" : "none";
      },
    },
    el("div", { class: "act-head" }, el("span", { class: "t-glyph" }, "✻"), status, time, el("span", { class: "t-toggle" })),
    tail,
    body
  );
  body.style.display = "none";
  return { root, status, time, tail, thinkText, body, startedAt: Date.now(), collapsed: false, timer: null, steps: 0, thinkShown: false };
}

function ensureActivity(node) {
  if (!node.activity) {
    node.activity = makeActivity();
    node.bubble.insertBefore(node.activity.root, node.mdDiv);
  }
  return node.activity;
}

function thinkTail(t) {
  t = t.replace(/\s+/g, " ").trim();
  return t.length > 100 ? "…" + t.slice(-100) : t;
}

function setThinking(node, text, streaming) {
  const act = ensureActivity(node);
  act.thinkText.textContent = text;
  act.thinkShown = true;
  act.tail.textContent = " " + thinkTail(text);
  act.tail.style.display = "block";
  if (streaming && !act.collapsed && !act.timer) {
    act.status.textContent = "深度思考中";
    act.timer = setInterval(() => {
      act.time.textContent = " " + ((Date.now() - act.startedAt) / 1000).toFixed(0) + "s";
    }, 500);
    node.bubble.classList.add("thinking-active");
  }
}

function collapseActivity(node) {
  if (!node.activity || node.activity.collapsed) return;
  const act = node.activity;
  act.collapsed = true;
  clearInterval(act.timer);
  act.timer = null;
  const secs = ((Date.now() - act.startedAt) / 1000).toFixed(0);
  act.root.classList.remove("streaming");
  const bits = [];
  if (act.thinkShown) bits.push("深度思考");
  if (act.steps) bits.push(`${act.steps} 次工具调用`);
  act.status.textContent = bits.length ? bits.join(" · ") : "已分析";
  act.time.textContent = Number(secs) > 0 ? ` ${secs}s` : "";
  act.tail.style.display = "none";
  act.root.querySelector(".t-toggle").textContent = "▸";
  node.bubble.classList.remove("thinking-active");
}

const collapseThinking = collapseActivity; // history renderer alias

function flushAssistant(node, text, thinking, streaming) {
  node.textAcc = text;
  if (thinking) setThinking(node, thinking, streaming);
  if (text && node.activity && !node.activity.collapsed) collapseActivity(node);
  if (!node.renderTimer) {
    node.renderTimer = setTimeout(() => {
      node.renderTimer = null;
      renderMd(node.textAcc, node.mdDiv);
      if (streaming) node.mdDiv.append(el("span", { class: "cursor-blink" }));
      scrollBottom();
    }, 90);
  }
}

// Tool calls: one-line cards INSIDE the activity timeline
function addToolCard(node, id, name, args) {
  const act = ensureActivity(node);
  act.steps++;
  if (!act.thinkShown) act.status.textContent = "调用工具中";
  const status = el("span", { class: "tl-status" }, "…");
  const glyph = el("span", { class: "tl-glyph" }, "⚙");
  const card = el(
    "div",
    { class: "tool-card" },
    el("div", { class: "tool-line" }, glyph, el("span", { class: "tname" }, toolLabel(name)), el("span", { class: "targs" }, argsPreview(args)), status)
  );
  const tout = el("div", { class: "tout" });
  tout.style.display = "none";
  card.append(tout);
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!tout.dataset.has) return;
    const open = tout.style.display !== "none";
    tout.style.display = open ? "none" : "block";
  });
  node.toolCards.set(id, { card, tout, glyph, status, startedAt: Date.now() });
  act.body.append(card);
  scrollBottom();
  return card;
}

function fillToolCard(id, name, text, isError) {
  for (const node of liveNodes) {
    const tc = node.toolCards.get(id);
    if (tc) {
      tc.card.classList.toggle("err", !!isError);
      tc.glyph.textContent = isError ? "✕" : "✓";
      tc.status.textContent = ((Date.now() - tc.startedAt) / 1000).toFixed(1) + "s";
      if (text && text.trim()) {
        tc.tout.textContent = text.slice(0, 2500);
        tc.tout.dataset.has = "1";
        tc.card.classList.add("has-out");
      }
      return;
    }
  }
}

const TOOL_LABELS = { read_paper: "读论文", list_library: "文献库列表", search_library: "检索文献库", read: "读文件", grep: "搜索", ls: "列目录" };
const toolLabel = (n) => TOOL_LABELS[n] || n;

function argsPreview(args) {
  try {
    const o = typeof args === "string" ? JSON.parse(args) : args || {};
    const bits = Object.entries(o).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)?.slice(0, 40)}`);
    return bits.join("  ");
  } catch {
    return String(args || "").slice(0, 60);
  }
}

function addMeta(node, usage, model) {
  if (!usage && !model) return;
  const bits = [];
  if (model) bits.push(model);
  if (usage) {
    bits.push(`↑${usage.input ?? "?"} ↓${usage.output ?? "?"}${usage.cost != null ? ` · $${Number(usage.cost).toFixed(4)}` : ""}`);
  }
  node.root.append(el("div", { class: "meta" }, bits.join(" · ")));
}

function markError(node, msg) {
  node.bubble.append(el("div", { style: { color: "var(--err)", marginTop: "8px", fontSize: "13px" } }, "⚠ " + msg));
}

const liveNodes = [];

function scrollBottom(force = false) {
  const box = $("#messages");
  if (force || autoScroll) box.scrollTop = box.scrollHeight;
}

// ---------------- send ----------------
// extract embedded paper images out of context text so the model gets the
// actual figure, not a link
async function extractInlineImages(text) {
  const images = [];
  let out = text;
  const paperId = state.currentPaper?.id;
  if (!paperId) return { text, images };
  const re = /(?:!\[[^\]]*\]\(|src=["']|>)\s*(?:\/api\/papers\/[^/)\s"']+\/)?(file\/assets\/[^)\s"']+)/g;
  const seen = new Set();
  const matches = [...text.matchAll(re)].map((m) => m[1]).filter((p) => !seen.has(p) && seen.add(p)).slice(0, 4);
  for (const rel of matches) {
    try {
      const res = await fetch(`/api/papers/${paperId}/${rel}`);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size > 6 * 1024 * 1024) continue;
      const dataUrl = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
      });
      const data = dataUrl.split(",")[1];
      if (!data || data.length < 50) continue;
      images.push({ mimeType: blob.type || "image/png", data });
      out = out.split(rel).join(`附图${images.length}`);
    } catch {}
  }
  return { text: out, images };
}

async function buildPromptParts(chipsIn) {
  const chips = chipsIn || [...state.chips];
  if (!chips.length) return { text: null, images: [] };
  const lines = ["--- 用户在阅读器中添加的上下文 ---"];
  const images = [];
  for (const c of chips) {
    if (c.kind === "text") {
      lines.push(`【选中${c.page ? ` · 第${c.page}页` : ""}】\n"""\n${c.body}\n"""`);
    } else if (c.kind === "image") {
      const data = (c.dataUrl || "").split(",")[1];
      if (!data || data.length < 50) continue; // skip broken crops
      lines.push(`【截图${c.page ? ` · 第${c.page}页` : ""}】（见第 ${images.length + 1} 张附图）`);
      images.push({ mimeType: c.mimeType || "image/png", data });
    } else if (c.kind === "block") {
      if (c.dataUrl) {
        const data = c.dataUrl.split(",")[1];
        if (!data || data.length < 50) continue;
        lines.push(`【${c.label}】（见第 ${images.length + 1} 张附图）`);
        images.push({ mimeType: c.mimeType || "image/png", data });
      } else if (c.body) {
        lines.push(`【${c.label}】\n${c.body}`);
      }
    }
  }
  lines.push("--- 上下文结束 ---");
  const base = lines.join("\n\n");
  const extracted = await extractInlineImages(base);
  return { text: extracted.text, images: [...images, ...extracted.images] };
}

export async function sendMessage() {
  try {
    await sendMessageInner();
  } catch (e) {
    toast("发送失败: " + (e.message || e), true);
  }
}

async function sendMessageInner() {
  const input = $("#composer-input");
  const text = input.value.trim();
  const { text: ctxText, images } = await buildPromptParts();
  if (!text && !ctxText) return;
  if (state.streaming) return;

  if (!state.sessionId) {
    try {
      const r = await api.createSession(state.currentPaper?.id || null, state.projectId || null);
      state.sessionId = r.id;
      state.model = r.model;
      $("#messages").replaceChildren();
    } catch (e) {
      toast("创建会话失败: " + e.message, true);
      return;
    }
  }

  const fullText = [text, ctxText].filter(Boolean).join("\n\n");
  input.value = "";
  autoSizeInput();
  state.chips = [];
  renderChips();

  await streamPrompt(fullText, images, text + (images.length ? `\n[🖼 截图 ×${images.length}]` : "") + (ctxText ? "\n＋已附上阅读器上下文" : ""));
}

// Shared streaming core: ensures a session, renders the exchange, streams SSE.
// Used by the composer and by the reader's box-annotation quick-ask.
export async function streamPrompt(fullText, images = [], userPreview) {
  if (state.streaming) {
    toast("上一条还在回复中，稍候", true);
    return;
  }
  if (!state.sessionId) {
    try {
      const r = await api.createSession(state.currentPaper?.id || null, state.projectId || null);
      state.sessionId = r.id;
      state.model = r.model;
      $("#messages").replaceChildren();
    } catch (e) {
      toast("创建会话失败: " + e.message, true);
      return;
    }
  }
  addMessageEl("user", userPreview || fullText);
  const node = assistantSkeleton();
  $("#messages").append(node.root);
  liveNodes.length = 0;
  liveNodes.push(node);
  scrollBottom(true);

  state.streaming = true;
  setStreamingUI(true);
  sendAbortController = new AbortController();
  let acc = "";
  let think = "";

  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: fullText, images, paperId: state.currentPaper?.id || null, projectId: state.projectId || null }),
      signal: sendAbortController.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        switch (ev.t) {
          case "delta":
            acc += ev.text;
            break;
          case "thinking":
            think += ev.text;
            break;
          case "tool_start": {
            addToolCard(node, ev.id, ev.name, ev.args);
            break;
          }
          case "tool_end": {
            fillToolCard(ev.id, ev.name, ev.preview, ev.isError);
            break;
          }
          case "usage":
            break;
          case "retry":
            toast(ev.note || "自动重试中…");
            break;
          case "notice":
            toast(ev.note);
            break;
          case "done":
            if (ev.errorMessage) markError(node, ev.errorMessage);
            addMeta(node, ev.usage, ev.model ? `${ev.model.provider}/${ev.model.id}` : null);
            break;
          case "error":
            markError(node, ev.message);
            break;
        }
        flushAssistant(node, acc, think, true);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      markError(node, "已停止");
    } else {
      markError(node, e.message);
    }
  } finally {
    flushAssistant(node, acc, think, false);
    state.streaming = false;
    setStreamingUI(false);
    sendAbortController = null;
    refreshSessions();
  }
}

function setStreamingUI(on) {
  $("#btn-send").hidden = on;
  $("#btn-stop").hidden = !on;
}

export function updateComposerHint() {
  const hint = $("#composer-hint");
  const qa = $("#quick-actions");
  qa.replaceChildren();
  if (state.currentPaper) {
    hint.textContent = `当前论文：《${(state.currentPaper.title || "").slice(0, 40)}》 — agent 可用 read_paper 直接阅读`;
    for (const [label, prompt] of [
      ["总结论文", "请通读当前论文，给出结构化总结：研究问题、方法、核心结果、局限。"],
      ["方法细读", "请精读当前论文的方法部分，逐步解释关键步骤、公式和设计动机。"],
      ["公式清单", "请列出当前论文中的关键公式，逐一给出编号、含义和各项的物理/数学意义。"],
      ["相关工作", "请梳理当前论文的相关工作部分，归纳主要流派及本文的差异化定位。"],
    ]) {
      qa.append(el("button", { class: "qa-btn", onclick: () => { const i = $("#composer-input"); i.value = prompt; i.focus(); autoSizeInput(); } }, label));
    }
  } else {
    hint.textContent = "未选择论文 — 仍可自由对话";
  }
}

export function autoSizeInput() {
  const i = $("#composer-input");
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight, 180) + "px";
}

// ---------------- init ----------------
export function initChat() {
  $("#btn-new-session").addEventListener("click", createSession);
  $("#btn-del-session").addEventListener("click", async () => {
    if (!state.sessionId) return;
    if (!confirm("删除当前会话（含 pi 会话文件）？")) return;
    try {
      await api.delSession(state.sessionId);
      state.sessionId = null;
      await refreshSessions(false);
      toast("已删除");
    } catch (e) {
      toast("删除失败: " + e.message, true);
    }
  });
  const dd = $("#session-dd");
  $("#session-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#session-menu").classList.toggle("open");
  });
  document.addEventListener("click", () => $("#session-menu").classList.remove("open"));

  $("#model-select").addEventListener("change", async (e) => {
    const [provider, id] = e.target.value.split("|");
    if (!state.sessionId || !id) return;
    try {
      const r = await api.setModel(state.sessionId, { provider, id, thinkingLevel: $("#think-select").value });
      state.model = r.model;
      toast(`已切换模型 ${provider}/${id}`);
    } catch (err) {
      toast("切换模型失败: " + err.message, true);
    }
  });
  $("#think-select").addEventListener("change", async () => {
    if (!state.sessionId) return;
    try {
      await api.setModel(state.sessionId, { thinkingLevel: $("#think-select").value });
    } catch {}
  });

  const input = $("#composer-input");
  input.addEventListener("input", () => {
    autoSizeInput();
    onComposerInput();
  });
  input.addEventListener("keydown", (e) => {
    if (handleComposerKeys(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (input.value.trim().startsWith("/")) closeMenu();
      sendMessage();
    }
  });
  input.addEventListener("click", () => {
    if (input.value.startsWith("/")) onComposerInput();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#cmd-menu") && !e.target.closest("#composer-input")) closeMenu();
  });
  $("#btn-send").addEventListener("click", sendMessage);
  $("#btn-stop").addEventListener("click", async () => {
    sendAbortController?.abort();
    try { if (state.sessionId) await api.abort(state.sessionId); } catch {}
  });

  const box = $("#messages");
  box.addEventListener("scroll", () => {
    autoScroll = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  });
}

export function syncModelSelect() {
  const sel = $("#model-select");
  const cur = state.model;
  const opts = [];
  const groups = new Map();
  for (const m of state.models.models || []) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  sel.replaceChildren();
  for (const [provider, models] of groups) {
    const g = el("optgroup", { label: provider });
    for (const m of models) {
      g.append(el("option", { value: `${provider}|${m.id}` }, m.name + (m.reasoning ? " 🧠" : "")));
    }
    sel.append(g);
  }
  if (cur) sel.value = `${cur.provider}|${cur.id}`;
}

// ================= / 命令 与 @ 文件 =================

let piCommands = { prompts: [], skills: [] };
let menuState = null; // {type:'slash'|'at', items, sel, anchorStart}

const BUILTIN_COMMANDS = [
  { name: "/model", desc: "切换模型（打开模型选择器）", builtin: true, run: () => $("#model-select").focus() },
  { name: "/thinking", desc: "切换思考深度", builtin: true, run: () => { const s = $("#think-select"); s.focus(); } },
  { name: "/new", desc: "新建会话", builtin: true, run: () => createSession() },
  { name: "/compact", desc: "压缩当前会话上下文", builtin: true, run: () => runCompact() },
  { name: "/paper", desc: "把当前论文绑定到本会话", builtin: true, run: () => { if (state.currentPaper) toast("发送消息时将绑定《" + state.currentPaper.title.slice(0, 30) + "》"); } },
];

export async function loadCommands() {
  try {
    piCommands = await api.commands();
  } catch {}
}
function slashItems(q) {
  const items = [
    ...BUILTIN_COMMANDS,
    ...piCommands.prompts.map((p) => ({ name: "/" + p.name, desc: p.description || "pi 提示模板", template: true })),
    ...piCommands.skills.map((s) => ({ name: "/skill:" + s.name, desc: s.description || "pi 技能", skill: true })),
  ];
  if (!q) return items.slice(0, 12);
  return items.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 12);
}

async function runCompact() {
  if (!state.sessionId) return toast("没有活动会话", true);
  toast("压缩上下文中…");
  try {
    await api.compact(state.sessionId);
    toast("上下文已压缩 ✓");
  } catch (e) {
    toast("压缩失败: " + e.message, true);
  }
}

function menuEl() {
  let m = $("#cmd-menu");
  if (!m) {
    m = el("div", { id: "cmd-menu" });
    $("#composer-wrap").prepend(m);
  }
  return m;
}

function closeMenu() {
  menuState = null;
  const m = $("#cmd-menu");
  if (m) {
    m.classList.remove("open");
    m.replaceChildren();
  }
}

function openMenu(type, items, anchorStart) {
  menuState = { type, items, sel: 0, anchorStart: anchorStart || 0 };
  const m = menuEl();
  m.replaceChildren();
  items.forEach((it, i) => {
    const row = el(
      "div",
      {
        class: "cmd-item" + (i === 0 ? " sel" : ""),
        "data-i": i,
        onclick: () => pickMenuItem(i),
      },
      el("span", { class: "ci-name" }, it.name || it.label),
      el("span", { class: "ci-desc" }, it.desc || "")
    );
    m.append(row);
  });
  m.classList.add("open");
  markSel();
}

function markSel() {
  if (!menuState) return;
  const m = $("#cmd-menu");
  [...m.children].forEach((c, i) => c.classList.toggle("sel", i === menuState.sel));
  m.children[menuState.sel]?.scrollIntoView({ block: "nearest" });
}

function pickMenuItem(i) {
  if (!menuState) return;
  const it = menuState.items[i];
  const input = $("#composer-input");
  if (menuState.type === "slash") {
    closeMenu();
    input.value = it.name + " ";
    input.focus();
    if (it.run) {
      it.run();
      input.value = "";
    }
  } else {
    // @ file
    closeMenu();
    input.value = input.value.replace(/@[^\s@]*$/, "");
    attachFile(it);
    input.focus();
  }
}

async function attachFile(f) {
  try {
    const r = await api.file(f.path);
    if (r.kind === "image") {
      addChip({ kind: "image", tag: "文件", body: r.label || f.label, dataUrl: r.dataUrl, mimeType: r.mimeType });
    } else if (r.kind === "text" || r.kind === "pdf") {
      addChip({ kind: "text", tag: "文件", body: `【文件:${r.label || f.label}】\n` + (r.content || "").slice(0, 12000) });
    }
    toast("已加入上下文");
  } catch (e) {
    toast("读取文件失败: " + e.message, true);
  }
}

function handleComposerKeys(e) {
  const m = $("#cmd-menu");
  if (menuState && m?.classList.contains("open")) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuState.sel = Math.min(menuState.items.length - 1, menuState.sel + 1);
      markSel();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      menuState.sel = Math.max(0, menuState.sel - 1);
      markSel();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickMenuItem(menuState.sel);
      return true;
    }
    if (e.key === "Escape") {
      closeMenu();
      return true;
    }
  }
  return false;
}

function onComposerInput() {
  const input = $("#composer-input");
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const before = v.slice(0, caret);
  // slash menu: text starts with '/' and has no space yet
  const sm = v.match(/^\/([\w:-]*)$/);
  if (sm) {
    openMenu("slash", slashItems(sm[1].toLowerCase()), 0);
    return;
  }
  // at menu: '@token' right before caret
  const am = before.match(/(^|\s)@([^\s@]*)$/);
  if (am) {
    const q = am[2].toLowerCase();
    fetch("/api/files?q=" + encodeURIComponent(q))
      .then((r) => r.json())
      .then((d) => {
        const items = (d.files || []).map((f) => ({ name: "@" + f.label, label: f.label, desc: f.kind, path: f.path }));
        if (items.length) openMenu("at", items.slice(0, 10), caret - am[2].length - 1);
        else closeMenu();
      })
      .catch(() => closeMenu());
    return;
  }
  closeMenu();
}
