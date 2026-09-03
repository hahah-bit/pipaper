import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { APP_ROOT, getConfig } from "./config.js";
import { listPapers, getPaper, sessionMeta, setSessionMeta, deleteSessionMeta, readParsedText, readBlocks, writeParseState, getProject } from "./store.js";

// ---------------------------------------------------------------------------
// PiPaper harness: embeds the pi agent SDK as the conversation kernel.
// - auth & model catalog come from the user's own ~/.pi/agent (auth.json,
//   models.json, models-store.json) via ModelRuntime
// - sessions are native pi JSONL sessions (SessionManager), resumable in the
//   pi TUI as well
// - streaming events are bridged to the web UI over SSE
// ---------------------------------------------------------------------------

const chats = new Map(); // sessionId -> { session, busy }
let modelRuntime = null;
let sharedLoader = null;
let initPromise = null;

const SYSTEM_PROMPT = `你是 PiPaper 论文精读工作台中的研究助手（论文阅读专用 agent）。

你的工作方式：
- 用户的对话通常绑定了一篇"当前论文"。通过 read_paper 工具阅读论文（不带 paper_id 时读当前论文）。
- 读长文前先 read_paper mode=outline 看结构，再 mode=section 精读相关章节；需要精确定位时用 mode=search。
- list_library / search_library 可以跨论文检索用户文献库。
- 用户消息里可能出现"引用块"（以【选中】或【截图】开头的附件上下文），那是用户从阅读器里框选或划选的内容，优先围绕这些内容回答。
- 回答用中文（用户使用英文提问时可用英文），公式用 LaTeX（$...$ 行内、$$...$$ 独立），重要结论注明来源章节/页码。
- 涉及事实性内容必须基于论文原文，不要编造；论文里没有的就明说。
- 简洁直接，避免空话；适合学术讨论的严谨语气。`;

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      modelRuntime = await ModelRuntime.create();
      sharedLoader = new DefaultResourceLoader({
        cwd: APP_ROOT,
        agentDir: getAgentDir(),
        systemPromptOverride: () => SYSTEM_PROMPT,
        appendSystemPromptOverride: () => [],
      });
      await sharedLoader.reload();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export async function modelList() {
  await ensureInit();
  let available = [];
  try {
    available = await modelRuntime.getAvailable();
  } catch {}
  let def = null;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
    def = { provider: settings.defaultProvider, id: settings.defaultModel, thinkingLevel: settings.defaultThinkingLevel || getConfig().chat.thinkingLevel };
  } catch {}
  return {
    default: def,
    models: available.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name || m.id,
      reasoning: !!m.reasoning,
      input: m.input || [],
      contextWindow: m.contextWindow,
    })),
  };
}

// Slash commands: pi prompt templates (global/project .md), pi skills, and
// app built-ins. All pass through session.prompt() which expands them natively.
export async function listCommands() {
  await ensureInit();
  const out = { prompts: [], skills: [] };
  try {
    const pr = sharedLoader.getPrompts();
    for (const p of pr.prompts || []) out.prompts.push({ name: p.name, description: p.description || "", source: p.source || "" });
  } catch {}
  try {
    const sk = sharedLoader.getSkills();
    for (const s of sk.skills || []) out.skills.push({ name: s.name, description: s.description || "", source: s.source || "" });
  } catch {}
  return out;
}

export async function compactSession(sessionId, customInstructions) {
  const c = chat(sessionId);
  if (c.busy) throw new Error("会话正在回复中，稍后再压缩");
  const r = await c.session.compact(customInstructions);
  return { ok: true, summary: String(r?.summary || "").slice(0, 400) };
}

// Loader introspection for the resource manager UI
export function sharedLoaderInfo() {
  if (!sharedLoader) return null;
  const ext = sharedLoader.getExtensions?.();
  const extensions = (ext?.extensions || []).map((e) => ({
    name: e.name || String(e.path || "").split(/[\\/]/).pop(),
    path: e.path || "",
    source: e.source || "",
  }));
  return { extensions };
}

// Per-project loader: skill enable-list filtering + extra extension paths.
const projectLoaders = new Map(); // projectId|global -> loader
function loaderKey(projectId) {
  const key = projectId || "global";
  if (projectLoaders.has(key)) return projectLoaders.get(key);
  let loader = sharedLoader;
  if (projectId) {
    const proj = getProject(projectId);
    const res = proj?.resources || {};
    const enabled = res.skillsEnabled || [];
    const extraExts = res.extensions || [];
    if (enabled.length || extraExts.length) {
      loader = new DefaultResourceLoader({
        cwd: APP_ROOT,
        agentDir: getAgentDir(),
        systemPromptOverride: () => SYSTEM_PROMPT,
        appendSystemPromptOverride: () => [],
        skillsOverride: enabled.length
          ? (cur) => ({
              skills: (cur.skills || []).filter((s) => enabled.includes(s.name) || s.source === "custom"),
              diagnostics: cur.diagnostics,
            })
          : undefined,
        additionalExtensionPaths: extraExts,
      });
      loader.reload?.();
    }
  }
  projectLoaders.set(key, loader);
  return loader;
}

// ---------------- agent tools (paper domain) ----------------

function clamp(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + `\n…[截断，共 ${s.length} 字符]` : s;
}

function buildPaperTools(idHolder) {
  // idHolder: {id: string|null} — resolved after the AgentSession exists
  const currentPaper = () => {
    const meta = idHolder.id ? sessionMeta(idHolder.id) : null;
    return meta?.paperId ? getPaper(meta.paperId) : null;
  };

  const list_library = defineTool({
    name: "list_library",
    label: "文献库列表",
    description: "列出用户论文库中的全部论文（含 id、标题、年份、解析状态）。当前绑定的论文会标注。",
    parameters: Type.Object({}),
    execute: async () => {
      const bound = currentPaper()?.id;
      const lines = listPapers().map(
        (p) => `- [${p.id}] ${p.title}${p.year ? ` (${p.year})` : ""}${p.id === bound ? "  ←当前论文" : ""}｜解析:${readBlocks(p.id) ? "已解析" : "未解析"}`
      );
      return { content: [{ type: "text", text: clamp(`共 ${lines.length} 篇：\n` + lines.join("\n"), 20000) }], details: {} };
    },
  });

  const search_library = defineTool({
    name: "search_library",
    label: "检索文献库",
    description: "按关键词在论文库的标题/作者/摘要中检索，返回匹配论文列表。",
    parameters: Type.Object({ query: Type.String({ description: "关键词" }) }),
    execute: async (_id, { query }) => {
      const q = query.toLowerCase();
      const hits = listPapers().filter((p) =>
        [p.title, p.abstract, ...(p.creators || []), p.publication].some((t) => String(t || "").toLowerCase().includes(q))
      );
      const text = hits.length
        ? hits.map((p) => `- [${p.id}] ${p.title}${p.year ? ` (${p.year})` : ""}｜${(p.creators || []).slice(0, 3).join(", ")}`).join("\n")
        : "没有匹配的论文。";
      return { content: [{ type: "text", text: clamp(text, 10000) }], details: {} };
    },
  });

  const read_paper = defineTool({
    name: "read_paper",
    label: "读论文",
    description:
      "阅读论文解析后的内容。mode: outline=标题结构; section=按标题取章节(需 query); search=全文关键词定位(需 query); full=全文(可截断)。不带 paper_id 时读当前绑定的论文。",
    parameters: Type.Object({
      paper_id: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal("outline"), Type.Literal("section"), Type.Literal("search"), Type.Literal("full")])),
      query: Type.Optional(Type.String()),
      max_chars: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params) => {
      const paper = params.paper_id ? getPaper(params.paper_id) : currentPaper();
      if (!paper) {
        return {
          content: [{ type: "text", text: "未找到论文。请确认 paper_id，或让用户在侧边栏选择一篇论文（会话需绑定论文）。可用 list_library 查看全部。" }],
          details: {},
        };
      }
      let md = readParsedText(paper.id);
      if (!md) {
        return {
          content: [{ type: "text", text: `《${paper.title}》尚未完成解析。请让用户在阅读器中点击"解析"按钮，之后再读取。` }],
          details: {},
        };
      }
      const mode = params.mode || "full";
      const maxChars = Math.min(params.max_chars || 24000, 80000);
      if (mode === "full") {
        return { content: [{ type: "text", text: clamp(`《${paper.title}》全文：\n\n` + md, maxChars) }], details: {} };
      }
      const blocks = readBlocks(paper.id) || [];
      if (mode === "outline") {
        const heads = blocks
          .filter((b) => b.type === "heading")
          .map((b, i) => `${"  ".repeat(Math.max(0, (b.level || 1) - 1))}- [${i}] ${b.text}${b.page ? ` (p.${b.page})` : ""}`);
        return { content: [{ type: "text", text: `《${paper.title}》结构（[i] 为块索引，read_paper section 的 query 按标题匹配）：\n` + heads.join("\n") }], details: {} };
      }
      if (mode === "search" && params.query) {
        const q = params.query.toLowerCase();
        const hits = [];
        blocks.forEach((b, i) => {
          const t = b.text || b.md || "";
          if (t.toLowerCase().includes(q)) hits.push({ b, i });
        });
        const lines = hits.slice(0, 40).map(({ b, i }) => {
          const t = (b.text || b.md || b.latex || "").replace(/\s+/g, " ");
          return `- [块${i}${b.type === "heading" ? "·标题" : ""}${b.page ? ` p.${b.page}` : ""}] ${t.slice(0, 220)}`;
        });
        return { content: [{ type: "text", text: hits.length ? `“${params.query}” 命中 ${hits.length} 处：\n` + lines.join("\n") : "无命中。" }], details: {} };
      }
      // section
      const q = (params.query || "").toLowerCase();
      let start = blocks.findIndex((b) => b.type === "heading" && (b.text || "").toLowerCase().includes(q));
      if (start < 0) {
        start = blocks.findIndex((b) => (b.text || b.md || "").toLowerCase().includes(q));
      }
      if (start < 0) return { content: [{ type: "text", text: `找不到匹配 "⁠${params.query}" 的章节。可先 read_paper mode=outline 看结构。` }], details: {} };
      const level = blocks[start].level || 1;
      let end = blocks.length;
      for (let i = start + 1; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === "heading" && (b.level || 1) <= level) {
          end = i;
          break;
        }
      }
      const sec = blocks.slice(start, end);
      const text = sec.map((b) => (b.type === "heading" ? "#".repeat(b.level || 1) + " " + b.text : b.md || b.html || b.latex || (b.src ? `[图片:${b.caption || b.src}]` : ""))).join("\n\n");
      const pg = blocks[start].page ? `\n\n(起始页码 p.${blocks[start].page})` : "";
      return { content: [{ type: "text", text: clamp(`《${paper.title}》§${blocks[start].text}：\n\n` + text + pg, maxChars) }], details: {} };
    },
  });

  const get_paper_pages = defineTool({
    name: "get_paper_pages",
    label: "论文页面截图",
    description:
      "把论文的若干页渲染成图片供视觉查看（看图表/排版/公式的原始样子）。pages 用页码如 \"3\" 或 \"3-4\"（最多 4 页）。不带 paper_id 时读当前论文。",
    parameters: Type.Object({
      paper_id: Type.Optional(Type.String()),
      pages: Type.String({ description: '页码范围，例如 "3" 或 "3-4"' }),
    }),
    execute: async (_id, { paper_id, pages }) => {
      const paper = paper_id ? getPaper(paper_id) : currentPaper();
      if (!paper) return { content: [{ type: "text", text: "未找到论文，请确认 paper_id 或让用户选择论文。" }], details: {} };
      if (!paper.pdfPath || !fs.existsSync(paper.pdfPath)) return { content: [{ type: "text", text: "该论文没有 PDF 文件。" }], details: {} };
      const m = String(pages || "").match(/(\d+)\s*(?:-\s*(\d+))?/);
      if (!m) return { content: [{ type: "text", text: 'pages 参数格式如 "3" 或 "3-4"。' }], details: {} };
      let p1 = Number(m[1]);
      let p2 = m[2] ? Number(m[2]) : p1;
      p2 = Math.min(p2, p1 + 3);
      const { renderPage, openDocument, closeDocument } = await import("./parser/render.js");
      const doc = await openDocument(paper.pdfPath);
      const content = [{ type: "text", text: `《${paper.title}》第 ${p1}-${p2} 页截图：` }];
      try {
        for (let p = p1; p <= Math.min(p2, doc.numPages); p++) {
          const r = await renderPage(doc, p, 1.6);
          const png = r.toPngBuffer();
          r.cleanup();
          content.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
        }
      } catch (e) {
        content.push({ type: "text", text: `(渲染失败: ${e.message})` });
      } finally {
        closeDocument(doc);
      }
      return { content, details: {} };
    },
  });

  return [list_library, search_library, read_paper, get_paper_pages];
}

// ---------------- session lifecycle ----------------

const PAPER_TOOL_NAMES = ["list_library", "search_library", "read_paper", "get_paper_pages"];

function makeSessionOpts(sm, idHolder, projectId) {
  return {
    cwd: APP_ROOT,
    agentDir: getAgentDir(),
    modelRuntime,
    settingsManager: SettingsManager.create(APP_ROOT, getAgentDir()),
    resourceLoader: loaderKey(projectId),
    tools: ["read", "grep", "ls", ...PAPER_TOOL_NAMES],
    customTools: buildPaperTools(idHolder),
    sessionManager: sm,
  };
}

async function newChat({ paperId, projectId } = {}) {
  await ensureInit();
  const idHolder = { id: null };
  const { session } = await createAgentSession(makeSessionOpts(SessionManager.create(APP_ROOT), idHolder, projectId));
  idHolder.id = session.sessionId;
  setSessionMeta(idHolder.id, { paperId: paperId || null, projectId: projectId || null });
  chats.set(idHolder.id, { session, busy: false });
  return session;
}

async function openChat(sessionId) {
  if (chats.has(sessionId)) return chats.get(sessionId).session;
  await ensureInit();
  const all = await SessionManager.list(APP_ROOT);
  const info = all.find((s) => s.id === sessionId || path.basename(s.path || "").startsWith(sessionId));
  if (!info) throw new Error("会话不存在: " + sessionId);
  const idHolder = { id: sessionId };
  const { session } = await createAgentSession(makeSessionOpts(SessionManager.open(info.path), idHolder, sessionMeta(sessionId)?.projectId));
  const id = session.sessionId;
  idHolder.id = id;
  chats.set(id, { session, busy: false });
  return session;
}

function chat(sessionId) {
  const c = chats.get(sessionId);
  if (!c) throw new Error("会话未加载");
  return c;
}

// ---------------- history mapping ----------------

export async function sessionHistory(sessionId) {
  let session;
  try {
    session = await openChat(sessionId);
  } catch (err) {
    return { error: String(err.message || err) };
  }
  const msgs = [];
  for (const m of session.messages || []) {
    if (m.role === "user") {
      const parts = [];
      if (typeof m.content === "string") parts.push({ type: "text", text: m.content });
      else
        for (const c of m.content || []) {
          if (c.type === "text") parts.push({ type: "text", text: c.text });
          else if (c.type === "image") parts.push({ type: "image", mimeType: c.mimeType || "image/png", data: c.data });
        }
      msgs.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const parts = [];
      for (const c of m.content || []) {
        if (c.type === "text" && c.text) parts.push({ type: "text", text: c.text });
        else if (c.type === "thinking" && c.thinking) parts.push({ type: "thinking", text: c.thinking });
        else if (c.type === "toolCall") parts.push({ type: "toolCall", id: c.id, name: c.name, args: c.arguments });
      }
      msgs.push({
        role: "assistant",
        parts,
        model: m.model ? `${m.provider || ""}/${m.model}` : undefined,
        usage: m.usage ? { input: m.usage.input, output: m.usage.output, cost: m.usage.cost?.total } : undefined,
        stopReason: m.stopReason,
        error: m.errorMessage || undefined,
      });
    } else if (m.role === "toolResult") {
      const text = (m.content || [])
        .map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[图片]" : ""))
        .join("\n");
      msgs.push({ role: "toolResult", toolCallId: m.toolCallId, toolName: m.toolName, text, isError: !!m.isError });
    }
  }
  return { messages: msgs, model: session.model ? { provider: session.model.provider, id: session.model.id } : null, thinkingLevel: session.thinkingLevel };
}

export async function listSessions() {
  let raw = [];
  try {
    raw = await SessionManager.list(APP_ROOT);
  } catch {}
  const out = [];
  for (const info of raw) {
    const id = info.id || path.basename(info.path || "", ".jsonl");
    const meta = sessionMeta(id) || {};
    let mtime = meta.updatedAt;
    try {
      mtime = fs.statSync(info.path).mtime.toISOString();
    } catch {}
    out.push({
      id,
      path: info.path,
      title: meta.title || (info.firstMessage || "").slice(0, 60) || "(空会话)",
      paperId: meta.paperId || null,
      projectId: meta.projectId || null,
      createdAt: meta.createdAt,
      updatedAt: mtime,
      messageCount: info.messageCount,
    });
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
}

export async function createChat({ paperId, projectId, title } = {}) {
  const session = await newChat({ paperId, projectId });
  const id = session.sessionId;
  setSessionMeta(id, { paperId: paperId || null, projectId: projectId || null, title: title || null });
  return { id, model: session.model ? { provider: session.model.provider, id: session.model.id } : null };
}

export async function deleteChat(sessionId) {
  const c = chats.get(sessionId);
  if (c) {
    try {
      await c.session.dispose();
    } catch {}
    chats.delete(sessionId);
  }
  const all = await SessionManager.list(APP_ROOT);
  const info = all.find((s) => (s.id === sessionId || path.basename(s.path || "").startsWith(sessionId)));
  if (info?.path && fs.existsSync(info.path)) fs.rmSync(info.path, { force: true });
  deleteSessionMeta(sessionId);
}

export async function setChatModel(sessionId, { provider, id, thinkingLevel }) {
  const c = chat(sessionId);
  if (provider && id) {
    const model = modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`模型不存在或不可用: ${provider}/${id}`);
    await c.session.setModel(model);
  }
  if (thinkingLevel) c.session.setThinkingLevel(thinkingLevel);
  return { model: c.session.model ? { provider: c.session.model.provider, id: c.session.model.id } : null, thinkingLevel: c.session.thinkingLevel };
}

export async function abortChat(sessionId) {
  const c = chats.get(sessionId);
  if (c) await c.session.abort();
}

// ---------------- prompt streaming (SSE) ----------------

function sse(send, obj) {
  send(`data: ${JSON.stringify(obj)}\n\n`);
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export async function promptChat(sessionId, { text, images = [], paperId, projectId }, send) {
  const c = chats.has(sessionId) ? chats.get(sessionId) : { session: await openChat(sessionId), busy: false };
  if (c.busy) throw new Error("该会话正在回复中，请稍候或另开会话");
  c.busy = true;
  if (paperId || projectId) setSessionMeta(sessionId, { ...(paperId ? { paperId } : {}), ...(projectId ? { projectId } : {}) });
  if (!sessionMeta(sessionId)?.title && text) setSessionMeta(sessionId, { title: text.slice(0, 60) });
  setSessionMeta(sessionId, { updatedAt: new Date().toISOString() });

  const unsub = c.session.subscribe((event) => {
    try {
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent || {};
        if (e.type === "text_delta" && e.delta) sse(send, { t: "delta", text: e.delta });
        else if (e.type === "thinking_delta" && e.delta) sse(send, { t: "thinking", text: e.delta });
      } else if (event.type === "tool_execution_start") {
        sse(send, { t: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        let preview = "";
        const rc = event.result?.content || event.output?.content || [];
        if (Array.isArray(rc)) preview = rc.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join(" ");
        sse(send, { t: "tool_end", id: event.toolCallId, name: event.toolName, isError: !!event.isError, preview: truncate(preview, 600) });
      } else if (event.type === "turn_end") {
        const m = event.message;
        if (m?.usage) sse(send, { t: "usage", usage: { input: m.usage.input, output: m.usage.output, cost: m.usage.cost?.total } });
      } else if (event.type === "auto_retry_start") {
        sse(send, { t: "retry", note: event.error || "请求失败，自动重试中…" });
      } else if (event.type === "compaction_start") {
        sse(send, { t: "notice", note: "上下文过长，自动压缩中…" });
      }
    } catch {}
  });

  try {
    // pi-ai ImageContent: {type:'image', data(base64), mimeType}
    const imgs = (images || [])
      .filter((im) => im?.data && im.data.length > 50)
      .slice(0, 6)
      .map((im) => ({ type: "image", mimeType: im.mimeType || "image/png", data: im.data }));
    await c.session.prompt(text, { images: imgs });
    const last = (c.session.messages || []).filter((m) => m.role === "assistant").pop();
    sse(send, {
      t: "done",
      usage: last?.usage ? { input: last.usage.input, output: last.usage.output, cost: last.usage.cost?.total } : null,
      model: c.session.model ? { provider: c.session.model.provider, id: c.session.model.id } : null,
      stopReason: last?.stopReason,
      errorMessage: last?.errorMessage || undefined,
    });
  } catch (err) {
    sse(send, { t: "error", message: String(err.message || err) });
  } finally {
    unsub();
    c.busy = false;
  }
}
