import { marked } from "marked";
import DOMPurify from "dompurify";
import renderMathInElement from "katex/contrib/auto-render";
import { api, state, $, el, toast, renderWelcome, renderChips } from "./app.js";

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
    const r = await api.createSession(state.currentPaper?.id || null);
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
    }, "＋ 新会话（绑定当前论文）")
  );
  for (const s of state.sessions) {
    menu.append(
      el("div", { class: "dd-item", onclick: () => { menu.classList.remove("open"); openSession(s.id); } },
        el("div", { class: "t" }, s.title || "(未命名会话)"),
        el("div", { class: "s" }, [s.paperId ? (state.papers.find((p) => p.id === s.paperId)?.title || s.paperId) : "未绑定论文", s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""].join(" · "))
      )
    );
  }
}

// ---------------- message rendering ----------------
function assistantSkeleton() {
  const mdDiv = el("div", { class: "md-body" });
  const bubble = el("div", { class: "bubble md" }, mdDiv);
  const root = el("div", { class: "msg assistant" }, bubble);
  return { root, bubble, mdDiv, toolCards: new Map(), textAcc: "", thinkAcc: "", thinkEl: null, thinkBody: null, renderTimer: null };
}

function addMessageEl(role, text) {
  const node = el("div", { class: "msg " + role }, el("div", { class: "bubble" }, text));
  $("#messages").append(node);
  scrollBottom();
  return node;
}

function ensureThinking(node) {
  if (!node.thinkEl) {
    node.thinkBody = el("div", { class: "th-body" });
    node.thinkEl = el("details", { class: "thinking" }, el("summary", {}, "思考过程"), node.thinkBody);
    node.bubble.insertBefore(node.thinkEl, node.mdDiv);
  }
  return node.thinkBody;
}

function flushAssistant(node, text, thinking, streaming) {
  node.textAcc = text;
  // thinking
  if (thinking) {
    ensureThinking(node).textContent = thinking;
    node.thinkEl.open = streaming ? false : node.thinkEl.open;
  }
  // text (throttled markdown render into the dedicated md body)
  if (!node.renderTimer) {
    node.renderTimer = setTimeout(() => {
      node.renderTimer = null;
      renderMd(node.textAcc, node.mdDiv);
      if (streaming) node.mdDiv.append(el("span", { class: "cursor-blink" }));
      scrollBottom();
    }, 90);
  }
}

function addToolCard(node, id, name, args) {
  const card = el("div", { class: "tool-card" },
    el("div", { class: "th" },
      el("span", { class: "spin" }),
      el("span", { class: "tname" }, toolLabel(name)),
      el("span", { class: "targs" }, argsPreview(args))
    )
  );
  node.toolCards.set(id, card);
  node.bubble.append(card);
  scrollBottom();
  return card;
}

function fillToolCard(id, name, text, isError) {
  for (const node of liveNodes) {
    const card = node.toolCards.get(id);
    if (card) {
      card.classList.toggle("err", !!isError);
      const spin = card.querySelector(".spin");
      if (spin) spin.remove();
      if (text) {
        card.append(el("div", { class: "tout" }, text.slice(0, 800)));
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
function buildPromptParts() {
  // returns {text, images}
  const chips = [...state.chips];
  if (!chips.length) return { text: null, images: [] };
  const lines = ["--- 用户在阅读器中添加的上下文 ---"];
  const images = [];
  chips.forEach((c, i) => {
    if (c.kind === "text") {
      lines.push(`【选中${c.page ? ` · 第${c.page}页` : ""}】\n"""\n${c.body}\n"""`);
    } else if (c.kind === "image") {
      const data = (c.dataUrl || "").split(",")[1];
      if (!data || data.length < 50) return; // skip broken crops
      lines.push(`【截图${c.page ? ` · 第${c.page}页` : ""}】（见第 ${images.length + 1} 张附图）`);
      images.push({ mimeType: c.mimeType || "image/png", data });
    } else if (c.kind === "block") {
      if (c.dataUrl) {
        const data = c.dataUrl.split(",")[1];
        if (!data || data.length < 50) return;
        lines.push(`【${c.label}】（见第 ${images.length + 1} 张附图）`);
        images.push({ mimeType: c.mimeType || "image/png", data });
      } else if (c.body) {
        lines.push(`【${c.label}】\n${c.body}`);
      }
    }
  });
  lines.push("--- 上下文结束 ---");
  return { text: lines.join("\n\n"), images };
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
  const { text: ctxText, images } = buildPromptParts();
  if (!text && !ctxText) return;
  if (state.streaming) return;

  if (!state.sessionId) {
    try {
      const r = await api.createSession(state.currentPaper?.id || null);
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

  addMessageEl("user", text + (images.length ? `\n[🖼 截图 ×${images.length}]` : "") + (ctxText ? "\n＋已附上阅读器上下文" : ""));
  const node = assistantSkeleton();
  $("#messages").append(node.root);
  liveNodes.length = 0;
  liveNodes.push(node);
  scrollBottom(true);

  // stream over fetch
  state.streaming = true;
  setStreamingUI(true);
  sendAbortController = new AbortController();
  let acc = "";
  let think = "";
  const pendingToolCards = new Map();

  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: fullText, images, paperId: state.currentPaper?.id || null }),
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
            const card = addToolCard(node, ev.id, ev.name, ev.args);
            pendingToolCards.set(ev.id, card);
            break;
          }
          case "tool_end": {
            const card = pendingToolCards.get(ev.id) || node.toolCards.get(ev.id);
            if (card) {
              card.classList.toggle("err", !!ev.isError);
              const spin = card.querySelector(".spin");
              if (spin) spin.remove();
              if (ev.preview) card.append(el("div", { class: "tout" }, ev.preview));
            }
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
  input.addEventListener("input", autoSizeInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
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
