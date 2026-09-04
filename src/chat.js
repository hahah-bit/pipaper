import { marked } from "marked";
import DOMPurify from "dompurify";
import renderMathInElement from "katex/contrib/auto-render";
import { api, state, $, el, toast, renderWelcome, renderChips, addChip, askText, askConfirm } from "./app.js";
import { createUserInputUI } from "./userInput.js";
import { composerAction } from "./chatKeys.js";
import { connectSessionEvents, closeSessionEvents, waitOperation } from "./sessionTransport.js";
import { initSessionPanel, renderSessionState } from "./sessionPanel.js";


let autoScroll = true;
const userInputUI = createUserInputUI(
  (sessionId, requestId, answer) => api.answerUserInput(sessionId, requestId, answer),
  async (sessionId) => { await api.abort(sessionId); }
);
let streamSessionId = null;
let sendingQueuedMessage = false;
const pendingBranchJobs = [];
let drainingBranchJobs = false;
let pendingBinding = null, applyingBinding = false, restoreBindingOnSnapshot = false;

export async function syncSessionBinding() {
  if (!state.sessionId || !state.controlId) return;
  pendingBinding = { id: state.sessionId, paperId: state.currentPaper?.id || null, projectId: state.projectId || null };
  await settleSessionActions();
}
async function settleSessionActions() {
  if (state.streaming || applyingBinding) return;
  if (pendingBinding) {
    const binding = pendingBinding; pendingBinding = null;
    if (binding.id === state.sessionId && state.controlId) {
      applyingBinding = true;
      try { await api.sessionAction(binding.id, "binding", binding); await loadCommands(); }
      catch (e) { toast("绑定更新失败：" + e.message, true); }
      finally { applyingBinding = false; }
    }
  }
  if (pendingBinding) await settleSessionActions();
  else await drainBranchJobs();
}

// ---------------- markdown / math rendering ----------------
marked.setOptions({ gfm: true, breaks: false });

export function renderMd(mdText, container) {
  const { text, math } = protectMath(mdText || "");
  const html = marked.parse(text);
  container.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  restoreMath(container, math);
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
    });
  } catch {}
}

// Markdown treats underscores and dollar signs as formatting before KaTeX can
// see them. Replace complete math spans with inert ASCII tokens, then restore
// them as text nodes so the math renderer receives the original delimiters.
function protectMath(source) {
  const math = [];
  const text = String(source || "").replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$)/g, (part) => {
    const i = math.push(part) - 1;
    return `MATHTOKEN${i}END`;
  });
  return { text, math };
}

function restoreMath(container, math) {
  if (!math.length) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const value = node.nodeValue || "";
    if (!/MATHTOKEN\d+END/.test(value)) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    value.replace(/MATHTOKEN(\d+)END/g, (token, index, offset) => {
      frag.append(document.createTextNode(value.slice(cursor, offset)));
      frag.append(document.createTextNode(math[Number(index)] || token));
      cursor = offset + token.length;
      return token;
    });
    frag.append(document.createTextNode(value.slice(cursor)));
    node.replaceWith(frag);
  }
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
  if (state.streaming) return toast("请先停止当前回复，再新建会话");
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

export async function openSession(id, { force = false } = {}) {
  if (state.streaming && !force) return toast("请先停止当前回复，再切换会话");
  userInputUI.clear();
  state.sessionId = id;
  restoreBindingOnSnapshot = true; pendingBinding = null;
  try {
    await connectSessionEvents(id, handleSessionEvent);
    await loadCommands();
    state.models = await api.models(); syncModelSelect();
    renderSessionMenu();
  } catch (e) { toast("打开会话失败: " + e.message, true); }
}

function renderContent(parts, target) {
  for (const p of parts || []) {
    if (p.type === "image") target.append(el("img", { src: 'data:' + p.mimeType + ';base64,' + p.data, class: "native-result-image", alt: "对话图片" }));
    else if (p.type === "text") target.append(el("pre", { class: "native-result-text" }, p.text));
  }
}
function renderHistory(h) {
  for (const n of liveNodes) finalizeActivity(n);
  $("#messages").replaceChildren(); liveNodes.length = 0; activeStream = null;
  for (const m of h.messages || []) {
    let root;
    if (m.role === "user") {
      const text = m.parts.filter(p => p.type === "text").map(p => p.text).join("\n");
      const node = addMessageEl("user", text, m.parts.filter(p => p.type === "image").map(p => 'data:' + p.mimeType + ';base64,' + p.data));
      if (m.entryId) addReaskButton(node, m.entryId, text);
      root = node;
    } else if (m.role === "assistant") {
      const node = assistantSkeleton(); $("#messages").append(node.root); liveNodes.push(node);
      for (const p of m.parts || []) if (p.type === "toolCall") addToolCard(node, p.id, p.name, p.args, true);
      flushAssistant(node, m.parts.filter(p => p.type === "text").map(p => p.text).join(""), m.parts.filter(p => p.type === "thinking").map(p => p.text).join(""), false);
      collapseThinking(node); addMeta(node, m.usage, m.model); if (m.error) markError(node, m.error); root = node.root;
      renderContent(m.parts.filter(p => p.type === "image"), node.bubble);
    } else if (m.role === "toolResult") {
      root = fillToolCard(m.toolCallId, m.toolName, m.text, m.isError, m.parts, m.details);
      if (!root) {
        root = el("details", { class: "native-message" }, el("summary", {}, m.toolName + " · 工具结果"));
        renderContent(m.parts, root); $("#messages").append(root);
      }
    } else {
      root = el("details", { class: "native-message" }, el("summary", {}, m.role === "custom" ? m.customType : m.role === "bashExecution" ? "命令执行记录" : m.role === "branchSummary" ? "分支摘要" : "上下文压缩摘要"));
      if (m.role === "bashExecution") root.append(el("pre", {}, m.command + "\n" + m.output));
      renderContent(m.parts, root); $("#messages").append(root);
    }
    if (root && m.entryId) root.dataset.entryId = m.entryId;
  }
  if (!h.messages?.length) renderWelcome();
  applySessionState(h); scrollBottom();
}
let activeStream = null;
function streamNode() {
  if (!activeStream) {
    const node = assistantSkeleton(); $("#messages").append(node.root); liveNodes.push(node);
    activeStream = { node, text: "", thinking: "" };
  }
  return activeStream;
}
function applySessionState(value) {
  state.nativeSession = value;
  state.model = value.model;
  if (!$("#model-select").options.length) syncModelSelect();
  state.streaming = !!value.busy; streamSessionId = state.streaming ? state.sessionId : null;
  setStreamingUI(state.streaming); renderSessionState(value);
  const select = $("#think-select");
  select.replaceChildren(...(value.thinkingLevels || []).map(level => el("option", { value: level }, "思考: " + level)));
  select.value = value.thinkingLevel || "off";
  if (value.model) $("#model-select").value = value.model.provider + "|" + value.model.id;
  const row = state.sessions.find(s => s.id === state.sessionId); if (row && value.name) row.title = value.name;
  $("#session-title").textContent = value.name || row?.title || "(空会话)";
  if (!state.streaming) void settleSessionActions();
}
function handleSessionEvent(ev) {
  if (ev.t === "session_replaced") {
    userInputUI.clear(); state.sessionId = ev.newSessionId; activeStream = null; restoreBindingOnSnapshot = true; pendingBinding = null;
    void refreshSessions(); void loadCommands(); return;
  }
  if (ev.t === "snapshot") {
    if (restoreBindingOnSnapshot) {
      restoreBindingOnSnapshot = false;
      const meta = ev.history.meta || {};
      state.projectId = meta.projectId || null;
      state.currentPaper = state.papers.find(p => p.id === meta.paperId) || null;
      void import("./sidebar.js").then(m => { m.renderProjects(); m.renderPapers(); });
      if (state.currentPaper) void import("./reader.js").then(m => m.readerLoadPaper(state.currentPaper));
      updateComposerHint();
    }
    renderHistory(ev.history); return;
  }
  if (ev.t === "state") { applySessionState(ev.state); return; }
  if (ev.t === "ui_request") { userInputUI.show(ev.sessionId, ev.request); return; }
  if (ev.t === "ui_resolved") { userInputUI.resolve(ev.id); return; }
  if (ev.t === "editor_text") { $("#composer-input").value = ev.text; autoSizeInput(); return; }
  if (ev.t === "extension_ui") { renderSessionState({ ...state.nativeSession, ui: ev.ui }); return; }
  if (ev.t === "notice") { toast(ev.note, ev.isError); return; }
  if (ev.t === "disconnected") {
    userInputUI.clear(); state.streaming = false; setStreamingUI(false);
    for (const n of liveNodes) finalizeActivity(n);
    toast(ev.message, true); return;
  }
  if (ev.t === "queue") {
    const lines = [...(ev.steering || []).map(t => "待插队：" + t.slice(0,100)), ...(ev.followUp || []).map(t => "已排队：" + t.slice(0,100))];
    $("#chat-queue").textContent = lines.join("\n"); $("#chat-queue").hidden = !lines.length; return;
  }
  if (ev.t === "operation_end") {
    if (ev.error) toast(ev.error, true);
    if (["reload", "startup", "binding"].includes(ev.kind)) {
      void loadCommands();
      const id = state.sessionId;
      void api.models().then(models => { if (state.sessionId === id) { state.models = models; syncModelSelect(); } }).catch(e => toast(e.message, true));
      window.dispatchEvent(new CustomEvent("pi:resources"));
    }
    return;
  }
  if (ev.t === "compaction") {
    if (ev.error) toast(ev.error, true); else toast(ev.aborted ? "已取消压缩" : "上下文已压缩"); return;
  }
  if (ev.t === "assistant_start") { if (activeStream) flushAssistant(activeStream.node, activeStream.text, activeStream.thinking, false); activeStream = null; streamNode(); }
  else if (ev.t === "user_start") { addMessageEl("user", ev.text, (ev.images || []).map(im => 'data:' + im.mimeType + ';base64,' + im.data)); }
  else if (ev.t === "delta") streamNode().text += ev.text;
  else if (ev.t === "thinking") streamNode().thinking += ev.text;
  else if (ev.t === "tool_start") addToolCard(streamNode().node, ev.id, ev.name, ev.args);
  else if (ev.t === "tool_update") liveToolText(streamNode().node, ev.id, ev.content.filter(c => c.type === "text").map(c => c.text).join(""));
  else if (ev.t === "tool_end") fillToolCard(ev.id, ev.name, ev.content.filter(c => c.type === "text").map(c => c.text).join("\n"), ev.isError, ev.content, ev.details);
  else if (ev.t === "entry" && ev.message.role === "custom") {
    const root = el("details", { class: "native-message" }, el("summary", {}, ev.message.customType)); renderContent(ev.message.parts, root); $("#messages").append(root);
  }
  if (activeStream) flushAssistant(activeStream.node, activeStream.text, activeStream.thinking, true);
}

function renderSessionMenu() {
  const menu = $("#session-menu");
  menu.replaceChildren();
  const cur = state.sessions.find((s) => s.id === state.sessionId);
  $("#session-title").textContent = cur ? cur.title || "(未命名会话)" : "发送消息时自动创建";
  const branchLabel = $("#session-branch");
  if (branchLabel) {
    const isBranch = !!(cur?.parentId || cur?.parentSession);
    branchLabel.textContent = isBranch ? "↳ Pi 分支" : "";
    branchLabel.title = isBranch ? "当前会话由 Pi 原生会话树分支而来" : "";
  }
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
    appendSessionTree(menu, inProject);
  }
  if (others.length) {
    menu.append(el("div", { class: "dd-group" }, inProject.length || state.projectId ? "其他会话" : ""));
    appendSessionTree(menu, others);
  }
  if (!state.sessions.length) menu.append(el("div", { class: "dd-item", style: { color: "var(--fg2)" } }, "暂无会话"));
}

function appendSessionTree(menu, sessions) {
  const byParent = new Map();
  for (const s of sessions) {
    const key = s.parentId && sessions.some((p) => p.id === s.parentId) ? s.parentId : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(s);
  }
  const seen = new Set();
  const walk = (nodes, depth) => {
    for (const s of nodes || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      menu.append(sessionRow(s, menu, depth));
      walk(byParent.get(s.id), depth + 1);
    }
  };
  walk(byParent.get(null), 0);
  // A malformed/foreign parent path should still be visible in the menu.
  walk(sessions.filter((s) => !seen.has(s.id)), 0);
}

function sessionRow(s, menu, depth = 0) {
  const projName = s.projectId ? (state.projects.find((p) => p.id === s.projectId)?.name || "") : "";
  const isBranch = !!(s.parentId || s.parentSession);
  return el("div", {
    class: "dd-item" + (isBranch ? " dd-branch" : ""),
    style: { paddingLeft: `${12 + depth * 18}px` },
    title: isBranch ? "Pi 原生分支会话" : "Pi 主会话",
    onclick: () => { menu.classList.remove("open"); openSession(s.id); },
  },
    el("div", { class: "t" }, (depth ? "↳ " : isBranch ? "↳ " : "") + (projName ? `[${projName}] ` : "") + (s.title || "(未命名会话)")),
    el("div", { class: "s" }, [(isBranch ? "Pi 分支" : "主会话"), s.paperId ? (state.papers.find((p) => p.id === s.paperId)?.title || s.paperId) : "未绑定论文", s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""].join(" · "))
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

function addMessageEl(role, text, thumbs = [], displayBlocks = []) {
  const bubble = el("div", { class: "bubble" }, text);
  if (thumbs?.length) {
    bubble.append(el("div", { class: "thumbs" }, ...thumbs.map((t) => el("img", { src: t }))));
  }
  for (const b of displayBlocks || []) {
    if (b.type === "image") {
      bubble.append(el("div", { class: "msg-block" }, el("img", { src: b.dataUrl, style: { maxWidth: "60%", borderRadius: "8px", border: "1px solid var(--border)" } })));
    } else if (b.type === "html") {
      const d = el("div", { class: "msg-block tbl" });
      d.innerHTML = b.html;
      bubble.append(d);
    } else if (b.type === "md") {
      const d = el("div", { class: "msg-block md" });
      renderMd(b.md, d);
      bubble.append(d);
    }
  }
  const node = el("div", { class: "msg " + role }, bubble);
  $("#messages").append(node);
  scrollBottom();
  return node;
}

// 编辑重问(fork): 修改历史问题并在新分支会话中重答,原会话原样保留
function addReaskButton(node, entryId, originalText) {
  const btn = el("button", {
    class: "msg-edit",
    title: "编辑该问题并在新分支中重答（原对话保留）",
    onclick: async (ev) => {
      ev.stopPropagation();
      if (state.streaming) return toast("当前任务执行中，请等待完成后再重问", true);
      const edited = await askText({ title: "编辑后重问", message: "编辑问题后重问 — 将新建分支会话，原对话不受影响：", initial: originalText || "", okText: "重问" });
      if (edited == null) return;
      const t = edited.trim();
      if (!t) return toast("内容为空，已取消", true);
      try {
        const r = await api.fork(state.sessionId, entryId, t.slice(0, 60));
        const result = await waitOperation(r.operationId);
        if (result?.cancelled) return;
        await refreshSessions();
        await streamPrompt(t, [], t);
      } catch (e) {
        toast("重问失败: " + e.message, true);
      }
    },
  }, "✎");
  node.querySelector(".bubble")?.append(btn);
}

function makeActivity() {
  const thinkText = el("div", { class: "act-think" });
  const tail = el("div", { class: "act-tail" });
  const status = el("span", { class: "act-status" }, "思考中");
  const time = el("span", { class: "act-time" });
  const body = el("div", { class: "act-body" }, thinkText);
  const act = { root: null, status, time, tail, thinkText, body, startedAt: Date.now(), collapsed: false, timer: null, steps: 0, thinkShown: false, running: new Map(), autoOpened: false, userToggled: false, toolTimer: null };
  act.root = el(
    "div",
    {
      class: "activity streaming",
      onclick: () => {
        act.userToggled = true;
        const open = act.root.classList.toggle("open");
        act.root.querySelector(".t-toggle").textContent = open ? "▾" : "▸";
        body.style.display = open ? "block" : "none";
      },
    },
    el("div", { class: "act-head" }, el("span", { class: "t-glyph" }, "✻"), status, time, el("span", { class: "t-toggle" })),
    tail,
    body
  );
  body.style.display = "none";
  return act;
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
  if (act.running?.size) return; // tools still running — keep the header live
  act.collapsed = true;
  clearInterval(act.timer);
  act.timer = null;
  clearInterval(act.toolTimer);
  act.toolTimer = null;
  const secs = ((Date.now() - act.startedAt) / 1000).toFixed(0);
  act.root.classList.remove("streaming");
  act.root.classList.remove("open");
  act.body.style.display = "none";
  act.status.classList.remove("live");
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

// Live header while tools execute — the "agent is working" signal.
// Keeps the collapsed one-liner honest: shows which tool is running, its
// args and elapsed time; without it a tool that starts after text output
// would run completely invisible inside the collapsed timeline.
function updateActivityLive(node) {
  const act = node.activity;
  if (!act || act.collapsed) return;
  if (act.running.size) {
    clearInterval(act.timer);
    act.timer = null;
    let last = null;
    for (const v of act.running.values()) last = v;
    act.status.textContent = `⚙ ${toolLabel(last.name)} 运行中`;
    act.status.classList.add("live");
    act.tail.style.display = "block";
    act.tail.textContent = " " + thinkTail(last.args || "");
    if (!act.toolTimer) {
      const t0 = last.startedAt;
      act.toolTimer = setInterval(() => {
        act.time.textContent = " " + ((Date.now() - t0) / 1000).toFixed(0) + "s";
      }, 500);
    }
  } else {
    clearInterval(act.toolTimer);
    act.toolTimer = null;
    act.status.classList.remove("live");
    if (act.thinkShown && !node.textAcc) {
      act.status.textContent = "深度思考中";
      act.tail.textContent = " " + thinkTail(act.thinkText.textContent || "");
      act.tail.style.display = "block";
    }
  }
}

// Turn settled (done/error/abort): clear live state and fold auto-opened
// timelines back into the one-line summary.
function finalizeActivity(node) {
  const act = node.activity;
  if (!act) return;
  act.running.clear();
  if (act.collapsed) return;
  clearInterval(act.toolTimer);
  act.toolTimer = null;
  if (act.autoOpened && !act.userToggled) {
    collapseActivity(node);
    return;
  }
  const secs = ((Date.now() - act.startedAt) / 1000).toFixed(0);
  act.root.classList.remove("streaming");
  act.status.classList.remove("live");
  const bits = [];
  if (act.thinkShown) bits.push("深度思考");
  if (act.steps) bits.push(`${act.steps} 次工具调用`);
  act.status.textContent = bits.length ? bits.join(" · ") : "已分析";
  act.time.textContent = Number(secs) > 0 ? ` ${secs}s` : "";
  act.tail.style.display = "none";
  act.root.querySelector(".t-toggle").textContent = act.root.classList.contains("open") ? "▾" : "▸";
  node.bubble.classList.remove("thinking-active");
}

function flushAssistant(node, text, thinking, streaming) {
  node.textAcc = text;
  if (thinking) setThinking(node, thinking, streaming);
  if (text && node.activity && !node.activity.collapsed && !node.activity.running.size) collapseActivity(node);
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
// fromHistory: history render has no live tools — never register it into the
// running set (that would wedge the header on "运行中" after reload).
function addToolCard(node, id, name, args, fromHistory = false) {
  const act = ensureActivity(node);
  act.steps++;
  // Text already streamed and the timeline folded → pop it back open so the
  // running tool (and its live output) is actually visible. History render
  // has no live tools: no running tracking, no auto-open (it would wedge the
  // header on "运行中" after reload).
  if (!fromHistory) {
    if (!act.userToggled && !act.root.classList.contains("open")) {
      act.collapsed = false;
      act.autoOpened = true;
      act.root.classList.add("streaming", "open");
      act.body.style.display = "block";
      act.root.querySelector(".t-toggle").textContent = "▾";
    }
    act.running.set(id, { name, args: argsPreview(args), startedAt: Date.now() });
  }
  if (!act.thinkShown && act.running.size === 1) act.status.textContent = "调用工具中";
  const status = el("span", { class: "tl-status" }, "…");
  const glyph = el("span", { class: "tl-glyph" }, "⚙");
  const card = el(
    "div",
    { class: "tool-card" },
    el("div", { class: "tool-line" }, glyph, el("span", { class: "tname" }, toolLabel(name)), el("span", { class: "targs" }, argsPreview(args)), status)
  );
  const tout = el("div", { class: "tout" });
  if (name === "bash" || name === "powershell") tout.classList.add("tout-term");
  tout.style.display = "none";
  card.append(tout);
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!tout.dataset.has) return;
    const open = tout.style.display !== "none";
    tout.style.display = open ? "none" : "block";
  });
  node.toolCards.set(id, { card, tout, glyph, status, startedAt: Date.now(), text: "", live: false, timer: null });
  act.body.append(card);
  if (!fromHistory) updateActivityLive(node);
  scrollBottom();
  return card;
}

// cap long terminal-ish output: keep the tail (bash prints newest lines last)
const OUT_MAX = 6000;
function clipOut(s, head = false) {
  if (s.length <= OUT_MAX) return s;
  return head ? s.slice(0, OUT_MAX) + `\n…[截断，共 ${s.length} 字符]` : `…[前段省略，共 ${s.length} 字符]\n` + s.slice(-OUT_MAX);
}

// SSE tool_update: pi streams bash output as cumulative snapshots (~100ms)
function liveToolText(node, id, text) {
  const tc = node.toolCards.get(id);
  if (!tc || !text) return;
  tc.text = text;
  if (!tc.live) {
    tc.live = true;
    tc.card.classList.add("run");
    tc.status.textContent = "运行中";
    tc.timer = setInterval(() => {
      tc.status.textContent = ((Date.now() - tc.startedAt) / 1000).toFixed(0) + "s 运行中";
    }, 1000);
  }
  tc.tout.textContent = clipOut(text);
  tc.tout.style.display = "block";
  tc.tout.dataset.has = "1";
  tc.card.classList.add("has-out");
  tc.tout.scrollTop = tc.tout.scrollHeight;
}

function fillToolCard(id, name, text, isError, content, details) {
  for (const node of liveNodes) {
    const tc = node.toolCards.get(id);
    if (tc) {
      clearInterval(tc.timer);
      tc.timer = null;
      node.activity?.running?.delete(id);
      const secs = ((Date.now() - tc.startedAt) / 1000).toFixed(1);
      tc.card.classList.toggle("err", !!isError);
      tc.card.classList.remove("run");
      tc.glyph.textContent = isError ? "✕" : "✓";
      const final = tc.live && tc.text.length >= String(text || "").length ? tc.text : String(text || "");
      tc.status.textContent = secs + "s" + (isError ? " ·错误" : tc.live ? " ·已结束" : "");
      if (final.trim() || content?.length) {
        tc.tout.replaceChildren();
        renderContent(content?.length ? content : [{ type: "text", text: final }], tc.tout);
        if (details && Object.keys(details).length) tc.tout.append(el("details", {}, el("summary", {}, "结构化结果"), el("pre", {}, JSON.stringify(details, null, 2))));
        tc.tout.style.display = "none";
        tc.tout.dataset.has = "1";
        tc.card.classList.add("has-out");
      }
      updateActivityLive(node);
      return tc.card;
    }
  }
}

const TOOL_LABELS = {
  read_paper: "读论文", list_library: "文献库列表", search_library: "检索文献库", search_papers: "学术检索", get_paper_pages: "论文截图",
  read: "读文件", grep: "搜索", ls: "列目录",
  bash: "shell 命令", powershell: "PowerShell", edit: "编辑文件", write: "写文件", find: "查找文件",
};
const toolLabel = (n) => TOOL_LABELS[n] || n;

function argsPreview(args) {
  try {
    const o = typeof args === "string" ? JSON.parse(args) : args || {};
    const bits = Object.entries(o).map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.slice(0, k === "command" ? 120 : 40)}`;
    });
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

export async function sendMessage(mode = "steer") {
  try {
    await sendMessageInner(mode);
  } catch (e) {
    toast("发送失败: " + (e.message || e), true);
  }
}

async function sendMessageInner(mode) {
  if (userInputUI.pending) return toast("请先回答或取消小窗里的问题");
  if (sendingQueuedMessage) return;
  const input = $("#composer-input");
  const text = input.value.trim();
  const { text: ctxText, images } = await buildPromptParts();
  if (!text && !ctxText) return;
  const fullText = [text, ctxText].filter(Boolean).join("\n\n");
  if (state.streaming) {
    // Keep the draft and attachments if the server rejects the queued message.
    sendingQueuedMessage = true;
    const originalValue = input.value;
    const originalChips = [...state.chips];
    try {
      await api.steer(streamSessionId, { text: fullText, images, mode, draft: { text, chips: structuredClone(state.chips) } });
      if (input.value === originalValue) input.value = "";
      state.chips = state.chips.filter((chip) => !originalChips.includes(chip));
      autoSizeInput();
      renderChips();
      toast(mode === "followUp" ? "已排队，当前任务完成后处理" : "已插队，将在当前轮工具结束后介入");
    } finally { sendingQueuedMessage = false; }
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

  const originalValue = input.value, originalChips = [...state.chips];
  input.value = "";
  autoSizeInput();
  state.chips = [];
  renderChips();

  try {
    await streamPrompt(fullText, images, text + (images.length ? `\n[🖼 截图 ×${images.length}]` : "") + (ctxText ? "\n＋已附上阅读器上下文" : ""));
  } catch (error) {
    if (!error.accepted && !input.value && !state.chips.length) {
      input.value = originalValue; state.chips = originalChips; autoSizeInput(); renderChips();
    }
    throw error;
  }
}

// Shared streaming core: ensures a session, renders the exchange, streams SSE.
// Used by the composer and by the reader's box-annotation quick-ask.
async function drainBranchJobs() {
  if (drainingBranchJobs || state.streaming) return;
  drainingBranchJobs = true;
  try {
    while (pendingBranchJobs.length && !state.streaming) {
      const job = pendingBranchJobs.shift();
      try { await job(); } catch (e) { toast("分支任务失败: " + e.message, true); }
    }
  } finally {
    drainingBranchJobs = false;
  }
}

async function forkPoint(sessionId) {
  try {
    const h = await api.history(sessionId);
    return [...(h.messages || [])].reverse().find((m) => m.role === "user" && m.entryId)?.entryId || null;
  } catch {
    return null;
  }
}

// Run a prompt in a native Pi branch. When the source conversation is busy,
// record the target node and create the branch after the parent finishes.
export async function streamPromptInBranch(fullText, images = [], userPreview, displayBlocks = [], onDone) {
  const sourceId = state.sessionId;
  if (!sourceId) return streamPrompt(fullText, images, userPreview, displayBlocks, onDone);
  const entryId = await forkPoint(sourceId);
  const job = async () => {
    if (state.sessionId !== sourceId) await openSession(sourceId);
    if (entryId) {
      const op = await api.fork(sourceId, entryId, (userPreview || fullText).slice(0,60));
      const result = await waitOperation(op.operationId); if (result?.cancelled) return;
    } else {
      const r = await api.createSession(state.currentPaper?.id || null, state.projectId || null);
      await openSession(r.id);
    }
    await streamPrompt(fullText, images, userPreview, displayBlocks, onDone);
  };
  if (state.streaming) { pendingBranchJobs.push(job); toast("父任务完成后创建分支并开始分析"); }
  else await job();
}

export async function streamPrompt(fullText, images = [], userPreview, displayBlocks = [], onDone) {
  if (state.streaming) throw new Error("上一项操作尚未完成");
  if (!state.sessionId) {
    const r = await api.createSession(state.currentPaper?.id || null, state.projectId || null); state.sessionId = r.id;
  }
  await connectSessionEvents(state.sessionId, handleSessionEvent);
  const originId = state.sessionId;
  const op = await api.prompt(state.sessionId, { text: fullText, images, paperId: state.currentPaper?.id || null, projectId: state.projectId || null });
  try {
    await waitOperation(op.operationId);
    if (onDone) {
      const last = [...(await api.history(originId)).messages].reverse().find(m => m.role === "assistant");
      onDone(last?.text || "");
    }
    await refreshSessions();
  } catch (error) { error.accepted = true; throw error; }
}

function setStreamingUI(on) {
  $("#btn-send").hidden = false;
  $("#btn-send").textContent = on ? "插队" : "➤";
  $("#btn-send").title = on ? "插队：Enter（当前轮工具结束后介入）" : "发送：Enter";
  $("#btn-queue").hidden = !on;
  $("#btn-stop").hidden = !on;
  $("#composer-keys").textContent = on ? "Enter 插队 · Alt+Enter / Ctrl+Q 排队 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行";
  $("#composer-input").placeholder = on ? "补充要求…（Enter 插队，Alt+Enter 排队）" : "问点什么…（Enter 发送，Shift+Enter 换行）";
  for (const id of ["#btn-new-session", "#btn-del-session", "#session-btn", "#project-select", "#model-select", "#think-select"]) $(id).disabled = on;
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
  initSessionPanel();
  let editorTimer;
  $("#composer-input").addEventListener("input", () => { clearTimeout(editorTimer); editorTimer = setTimeout(() => { if (state.sessionId && state.controlId) api.sessionAction(state.sessionId, "editor", { text: $("#composer-input").value }).catch(() => {}); }, 150); });
  $("#btn-new-session").addEventListener("click", createSession);
  $("#btn-del-session").addEventListener("click", async () => {
    if (!state.sessionId) return;
    if (!(await askConfirm({ title: "删除会话", message: "删除当前会话（含 pi 会话文件）？", okText: "删除", danger: true }))) return;
    try {
      await api.delSession(state.sessionId);
      closeSessionEvents();
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
    if (e.isComposing || e.keyCode === 229) return;
    const action = composerAction(e);
    if (!e.altKey && !e.ctrlKey && !e.metaKey && handleComposerKeys(e)) return;
    if (action) {
      e.preventDefault();
      if (input.value.trim().startsWith("/")) closeMenu();
      sendMessage(action);
    }
  });
  input.addEventListener("click", () => {
    if (input.value.startsWith("/")) onComposerInput();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#cmd-menu") && !e.target.closest("#composer-input")) closeMenu();
  });
  $("#btn-send").addEventListener("click", () => sendMessage("steer"));
  $("#btn-queue").addEventListener("click", () => sendMessage("followUp"));
  $("#btn-stop").addEventListener("click", async () => {
    const sessionId = state.sessionId;
    userInputUI.clear();
    try { if (sessionId) await api.abort(sessionId); } catch {}
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
  const id = state.sessionId;
  try {
    const commands = await api.commands(); if (id === state.sessionId) piCommands = commands;
  } catch {}
}
function slashItems(q) {
  const items = [
    ...BUILTIN_COMMANDS.filter(p => !(piCommands.extensions || []).some(e => p.name === "/" + e.name)),
    ...(piCommands.extensions || []).map(p => ({ name: "/" + p.name, desc: (p.description || "扩展命令") + " · " + (p.source || "Pi"), template: true })),
    ...piCommands.prompts.map((p) => ({ name: "/" + p.name, desc: (p.description || "提示模板") + " · " + (p.source || "Pi 模板"), template: true })),
    ...piCommands.skills.map((s) => ({ name: "/skill:" + s.name, desc: (s.description || "技能") + " · " + (s.source || "Pi 技能"), skill: true })),
  ];
  if (!q) return items.slice(0, 12);
  return items.filter((i) => i.name.toLowerCase().includes(q)).slice(0, 12);
}

async function runCompact() {
  if (!state.sessionId) return toast("没有活动会话", true);
  toast("压缩上下文中…");
  try {
    const instructions = await askText({ title: "压缩会话", message: "压缩时需要保留哪些信息？（可留空）", okText: "开始压缩" });
    if (instructions === null) return;
    const op = await api.sessionAction(state.sessionId, "compact", { instructions });
    await waitOperation(op.operationId);
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
