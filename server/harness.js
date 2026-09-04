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
import { listPapers, getPaper, sessionMeta, setSessionMeta, deleteSessionMeta, readBlocks, getProject } from "./store.js";
import { blocksToContext } from "./parser/mdblocks.js";
import { UserInputBroker, userInputTool } from "./user-input.js";

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
- search_papers 可以在线聚合检索学术文献（OpenAlex/arXiv/Semantic Scholar 等），download_paper 可把开放获取论文下载入库；用户想"找论文/查相关工作"时优先用这两个工具。
- 会话绑定论文或 Zotero 项目时，你还会加载"论文综合"技能组（zotero 文献管理、nature 系列学术技能）。zotero_search / zotero_item 用于管理用户 Zotero 库。
- 用户消息里可能出现"引用块"（以【选中】或【截图】开头的附件上下文），那是用户从阅读器里框选或划选的内容，优先围绕这些内容回答。
- 回答用中文（用户使用英文提问时可用英文），公式用 LaTeX（$...$ 行内、$$...$$ 独立），重要结论注明来源章节/页码。
- 你的工具面与 pi 原版一致：read/bash/edit/write 以及已安装的扩展插件工具（web_search 等）都在，需要时可直接用。bash 的工作目录是 PiPaper 安装根目录；执行会改动文件的命令前先向用户说明后果。
- 涉及事实性内容必须基于论文原文，不要编造；论文里没有的就明说。
- 确实需要用户选择、确认是否继续或补充必要信息时，调用 request_user_input 工具，在网页小窗中收集答案后继续；不要只写一句问题然后等待。已有明确授权的操作直接执行。用户取消或拒绝不等于同意。
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

// ---------------------------------------------------------------------------
// Layered skills (progressive disclosure, display-level routing):
//   base layer    — pi's normal discovery (always on)
//   gated layer   — 论文综合技能组 (zotero, nature-*, ...) loaded ONLY into
//                   sessions bound to a paper or a Zotero-linked project.
//                   Nothing is copied: gated skills are referenced in place.
// ---------------------------------------------------------------------------

function gatedSkillDirs() {
  const dirs = [];
  const gatedRoot = path.join(getAgentDir(), "skills-gated");
  if (fs.existsSync(gatedRoot)) {
    for (const d of fs.readdirSync(gatedRoot)) dirs.push(path.join(gatedRoot, d));
  }
  const codexSkills = path.join(process.env.USERPROFILE || "", ".codex", "skills");
  try {
    if (fs.existsSync(codexSkills)) {
      for (const d of fs.readdirSync(codexSkills)) {
        if (d.startsWith("nature-")) dirs.push(path.join(codexSkills, d));
      }
    }
  } catch {}
  return dirs.filter((d) => fs.existsSync(path.join(d, "SKILL.md")));
}

export function gatedSkills() {
  const out = [];
  for (const dir of gatedSkillDirs()) {
    let name = path.basename(dir);
    let description = "";
    try {
      const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
      name = (md.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || name;
      description = (md.match(/^description:\s*([\s\S]*?)(?=\n[a-z-]+:|\n---|$)/m) || [])[1]?.trim().replace(/\s+/g, " ") || "";
    } catch {}
    out.push({ name, description: description.slice(0, 140), dir });
  }
  return out;
}

function gatedSkillObjects() {
  const fsmods = [];
  void fsmods;
  return gatedSkills().map((s) => ({
    name: s.name,
    description: s.description,
    filePath: path.join(s.dir, "SKILL.md"),
    baseDir: s.dir,
    source: "gated:论文综合",
  }));
}

function projectTypeOf(projectId) {
  if (!projectId) return null;
  try {
    const p = getProject(projectId);
    return p?.type || null;
  } catch {
    return null;
  }
}

// Per-project loader: skill enable-list filtering + extra extension paths.
// Layer rule: sessions bound to a paper or a Zotero project also get the
// gated 论文综合 skill group (display-level routing, no hooks).
const projectLoaders = new Map(); // key -> loader
function loaderKey(projectId, { paperBound = false } = {}) {
  const key = (projectId || "global") + (paperBound ? ":paper" : "");
  if (projectLoaders.has(key)) return projectLoaders.get(key);
  let loader = sharedLoader;
  const proj = projectId ? getProject(projectId) : null;
  const res = proj?.resources || {};
  const enabled = res.skillsEnabled || [];
  const extraExts = res.extensions || [];
  const gated = paperBound || proj?.type === "zotero" ? gatedSkillObjects() : [];
  if (enabled.length || extraExts.length || gated.length) {
    loader = new DefaultResourceLoader({
      cwd: APP_ROOT,
      agentDir: getAgentDir(),
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
      skillsOverride: (cur) => ({
        skills: [...(cur.skills || []).filter((s) => !enabled.length || enabled.includes(s.name) || s.source === "custom"), ...gated],
        diagnostics: cur.diagnostics,
      }),
      additionalExtensionPaths: extraExts,
    });
    loader.reload?.();
  }
  projectLoaders.set(key, loader);
  return loader;
}

// ---------------- agent tools (paper domain) ----------------

function clamp(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + `\n…[截断，共 ${s.length} 字符]` : s;
}

export function buildPaperTools(idHolder) {
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
      const parsed = readBlocks(paper.id) || [];
      const rawBlocks = Array.isArray(parsed) ? parsed : parsed.blocks || parsed.readingBlocks || [];
      const versionNote = parsed.meta?.versionId ? `[解析版本 ${parsed.meta.versionId}; 内容指纹 ${parsed.meta.contentHash || "legacy"}]\n` : "[旧解析结果，尚未通过新版结构校验]\n";
      const md = rawBlocks.length ? versionNote + blocksToContext(rawBlocks) : "";
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
      const blocks = rawBlocks;
      if (mode === "outline") {
        const heads = blocks
          .flatMap((b, i) => b.type === "heading" ? [`${"  ".repeat(Math.max(0, (b.level || 1) - 1))}- [${i}] ${b.text}${b.page ? ` (p.${b.page})` : ""}`] : []);
        return { content: [{ type: "text", text: versionNote + `《${paper.title}》结构（[i] 为块索引，read_paper section 的 query 按标题匹配）：\n` + heads.join("\n") }], details: {} };
      }
      if (mode === "search" && params.query) {
        const q = params.query.toLowerCase();
        const hits = [];
        blocks.forEach((b, i) => {
          const t = b.text || b.md || b.latex || b.html || b.caption || "";
          if (t.toLowerCase().includes(q)) hits.push({ b, i });
        });
        const lines = hits.slice(0, 40).map(({ b, i }) => {
          const t = (b.text || b.md || b.latex || b.html || b.caption || "").replace(/\s+/g, " ");
          return `- [块${i} ${b.id || "legacy"}${b.page ? ` p.${b.page}` : ""}${b.issues?.length ? " 待核对:" + b.issues.join(",") : ""}] ${t.slice(0, 220)}`;
        });
        return { content: [{ type: "text", text: versionNote + (hits.length ? `“${params.query}” 命中 ${hits.length} 处：\n` + lines.join("\n") : "无命中。") }], details: {} };
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
      const text = versionNote + blocksToContext(sec);
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

  const search_papers = defineTool({
    name: "search_papers",
    label: "学术检索",
    description: "聚合检索学术论文（OpenAlex/arXiv/Semantic Scholar/Crossref/PubMed）。返回标题、作者、年份、DOI、venue、被引数、OA 与 PDF 链接、摘要。可用 year_from/year_to 过滤。",
    parameters: Type.Object({
      query: Type.String({ description: "检索词（主题/方法/模型名等）" }),
      year_from: Type.Optional(Type.Number()),
      year_to: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number({ description: "每个源的返回条数，默认 10" })),
    }),
    execute: async (_id, { query, year_from, year_to, limit }) => {
      const { aggregateSearch, tierOf } = await import("./search/engines.js");
      const r = await aggregateSearch(query, { yearFrom: year_from, yearTo: year_to, limit: Math.min(limit || 10, 20) });
      if (!r.results.length) return { content: [{ type: "text", text: `“${query}” 没有检索到结果。${r.errors.length ? "部分源出错: " + r.errors.join("; ") : ""}` }], details: {} };
      const lines = r.results.slice(0, 12).map((x, i) => {
        const tier = tierOf(x);
        return `${i + 1}. ${x.title}\n   ${x.authors.slice(0, 3).join(", ")}${x.authors.length > 3 ? " 等" : ""} | ${x.year || "?"} | ${x.venue || "无 venue"} | 被引 ${x.citations ?? "?"} [${tier.label}]${x.oa ? " [OA]" : ""}\n   DOI: ${x.doi || "-"} | PDF: ${x.pdfUrl ? "有" : "无"}\n   摘要: ${x.abstract.slice(0, 160)}…`;
      });
      return { content: [{ type: "text", text: clamp(`“${query}” 检索到 ${r.total} 条（前 12 条）：\n\n` + lines.join("\n"), 12000) }], details: {} };
    },
  });

  const download_paper = defineTool({
    name: "download_paper",
    label: "下载论文入库",
    description: "按 DOI 或精确标题检索并下载开放获取 PDF 到用户文献库（成功后可用 read_paper 读取）。优先精确 DOI。",
    parameters: Type.Object({
      doi: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
    }),
    execute: async (_id, { doi, title }) => {
      if (!doi && !title) return { content: [{ type: "text", text: "请提供 doi 或 title。" }], details: {} };
      const { aggregateSearch, tierOf } = await import("./search/engines.js");
      const q = doi || title;
      const r = await aggregateSearch(q, { limit: 5 });
      const hit = r.results.find((x) => (doi && x.doi === String(doi).toLowerCase()) || (title && x.title.toLowerCase().includes(String(title).toLowerCase().slice(0, 40))));
      if (!hit) return { content: [{ type: "text", text: "未检索到匹配论文。" }], details: {} };
      if (!hit.pdfUrl) return { content: [{ type: "text", text: `找到了《${hit.title}》（DOI:${hit.doi || "-"}），但没有开放获取 PDF，无法自动下载。` }], details: {} };
      try {
        const ua = "PiPaper/0.5 (academic reader; local app)";
        const res = await fetch(hit.pdfUrl, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(120000), redirect: "follow" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 10000 || buf[0] !== 0x25) throw new Error("内容不是有效 PDF");
        const { importPdfFile } = await import("./store.js");
        const { paper } = importPdfFile(hit.title.slice(0, 80) + ".pdf", buf);
        return { content: [{ type: "text", text: `已下载并入库：《${paper.title}》（id: ${paper.id}），现在可以用 read_paper 阅读了。` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `下载失败（${String(e.message || e).slice(0, 100)}）。可以请用户手动从 ${hit.url || hit.pdfUrl} 下载导入。` }], details: {} };
      }
    },
  });

  const zotero_search = defineTool({
    name: "zotero_search",
    label: "Zotero 检索",
    description: "在用户 Zotero 文献库中按标题/作者/摘要检索，返回条目、年份与 PDF 可用性。需要文献管理时先用它。",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_id, { query, limit }) => {
      const { getConfig } = await import("./config.js");
      const { zoteroSearch } = await import("./zotero.js");
      try {
        const hits = zoteroSearch(getConfig().zotero, query, Math.min(limit || 8, 20));
        if (!hits.length) return { content: [{ type: "text", text: `Zotero 库中没有匹配 "${query}" 的条目。` }], details: {} };
        const lines = hits.map((h) => `- [${h.zoteroKey}] ${h.title} (${h.year || "?"})｜${(h.creators || []).slice(0, 2).join(", ")}｜${h.pdfPath ? "有PDF" : "无PDF"}${h.doi ? "｜DOI:" + h.doi : ""}`);
        return { content: [{ type: "text", text: clamp(`Zotero 检索到 ${hits.length} 条：\n` + lines.join("\n"), 8000) }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: "Zotero 不可用: " + String(e.message || e).slice(0, 120) }], details: {} };
      }
    },
  });

  const zotero_item = defineTool({
    name: "zotero_item",
    label: "Zotero 条目详情",
    description: "按 key 查看一条 Zotero 条目的完整元数据（DOI、venue、摘要、PDF 路径）。",
    parameters: Type.Object({ key: Type.String() }),
    execute: async (_id, { key }) => {
      const { getConfig } = await import("./config.js");
      const { zoteroItem } = await import("./zotero.js");
      const it = zoteroItem(getConfig().zotero, key);
      if (!it) return { content: [{ type: "text", text: "未找到该 key 的条目。" }], details: {} };
      const lines = [
        `标题: ${it.title}`,
        `作者: ${(it.creators || []).join(", ")}`,
        `年份: ${it.year ?? "-"}`,
        `DOI: ${it.doi || "-"}`,
        `期刊: ${it.publication || "-"}`,
        `类型: ${it.itemType}`,
        it.pdfPath ? `PDF: ${it.pdfPath}` : "PDF: 无附件",
        it.abstract ? `摘要: ${it.abstract.slice(0, 800)}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  return [list_library, search_library, read_paper, get_paper_pages, search_papers, download_paper, zotero_search, zotero_item];
}

// ---------------- session lifecycle ----------------

const PAPER_TOOL_NAMES = ["list_library", "search_library", "read_paper", "get_paper_pages", "search_papers", "download_paper", "zotero_search", "zotero_item"];

function makeSessionOpts(sm, idHolder, projectId) {
  const paperBound = !!(idHolder.paperId || projectTypeOf(projectId) === "zotero");
  idHolder.ui = new UserInputBroker();
  return {
    cwd: APP_ROOT,
    agentDir: getAgentDir(),
    modelRuntime,
    settingsManager: SettingsManager.create(APP_ROOT, getAgentDir()),
    resourceLoader: loaderKey(projectId, { paperBound }),
    // No allowlist = the pi-native tool surface: read/bash/edit/write plus all
    // extension-registered tools plus the paper tools below (same as pi CLI).
    tools: undefined,
    customTools: [...buildPaperTools(idHolder), userInputTool(idHolder.ui)],
    sessionManager: sm,
  };
}

async function newChat({ paperId, projectId, title = null } = {}) {
  await ensureInit();
  const idHolder = { id: null, paperId };
  const { session } = await createAgentSession(makeSessionOpts(SessionManager.create(APP_ROOT), idHolder, projectId));
  idHolder.id = session.sessionId;
  setSessionMeta(idHolder.id, { paperId: paperId || null, projectId: projectId || null, title });
  chats.set(idHolder.id, { session, ui: idHolder.ui, busy: false });
  return session;
}

async function openChat(sessionId) {
  if (chats.has(sessionId)) return chats.get(sessionId).session;
  await ensureInit();
  const all = await SessionManager.list(APP_ROOT);
  const info = all.find((s) => s.id === sessionId || path.basename(s.path || "").startsWith(sessionId));
  if (!info) throw new Error("会话不存在: " + sessionId);
  const idHolder = { id: sessionId, paperId: sessionMeta(sessionId)?.paperId || null };
  const { session } = await createAgentSession(makeSessionOpts(SessionManager.open(info.path), idHolder, sessionMeta(sessionId)?.projectId));
  const id = session.sessionId;
  idHolder.id = id;
  chats.set(id, { session, ui: idHolder.ui, busy: false });
  return session;
}

function chat(sessionId) {
  const c = chats.get(sessionId);
  if (!c) throw new Error("会话未加载");
  return c;
}

// ---------------- history mapping ----------------

// AgentMessage objects don't carry their JSONL entry id (fork targets need it),
// so pair each mapped history message with its file entry by role+content.
function resolveEntryIds(session, msgs) {
  const entries = (session.sessionManager?.getEntries?.() || []).filter((e) => e.type === "message");
  if (!entries.length) return msgs;
  // mapped history msgs expose parts; file entries expose raw message content
  const textOf = (m) => {
    if (Array.isArray(m.parts)) return m.parts.filter((p) => p.type === "text").map((p) => p.text || "").join(" ");
    if (typeof m.content === "string") return m.content;
    return (m.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join(" ");
  };
  const head = (m) => textOf(m).replace(/\s+/g, " ").trim().slice(0, 80);
  let ei = 0;
  return msgs.map((m) => {
    if (m.role === "user" || m.role === "assistant") {
      const want = head(m);
      if (!want) return m;
      while (ei < entries.length) {
        const en = entries[ei++];
        const em = en.message;
        if (em.role !== m.role) continue;
        if (head(em) === want) return { ...m, entryId: en.id };
      }
    } else if (m.role === "toolResult") {
      while (ei < entries.length) {
        const en = entries[ei++];
        const em = en.message;
        if (em.role !== "toolResult") continue;
        if (em.toolCallId === m.toolCallId) return { ...m, entryId: en.id };
      }
    }
    return m;
  });
}

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
      msgs.push({ role: "user", parts, entryId: m.id });
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
        entryId: m.id,
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
  const withIds = resolveEntryIds(session, msgs);
  return { messages: withIds, model: session.model ? { provider: session.model.provider, id: session.model.id } : null, thinkingLevel: session.thinkingLevel };
}

export async function listSessions() {
  let raw = [];
  try {
    raw = await SessionManager.list(APP_ROOT);
  } catch {}
  const pathToId = new Map();
  for (const info of raw) {
    const id = info.id || path.basename(info.path || "", ".jsonl");
    if (info.path) pathToId.set(path.resolve(info.path), id);
  }
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
      parentSession: info.parentSessionPath || null,
      parentId: info.parentSessionPath ? (pathToId.get(path.resolve(info.parentSessionPath)) || null) : null,
    });
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
}

export async function createChat({ paperId, projectId, title } = {}) {
  const session = await newChat({ paperId, projectId, title: title || null });
  const id = session.sessionId;
  setSessionMeta(id, { paperId: paperId || null, projectId: projectId || null, title: title || null });
  return { id, model: session.model ? { provider: session.model.provider, id: session.model.id } : null };
}

export async function deleteChat(sessionId) {
  const c = chats.get(sessionId);
  if (c) {
    await abortChat(sessionId);
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
  if (c) {
    c.stopped = true;
    const aborted = c.session.abort();
    c.ui.disconnect("aborted");
    await aborted;
  }
}

export function answerUserInput(sessionId, requestId, answer) {
  chat(sessionId).ui.answer(requestId, answer);
  return { ok: true };
}

// ---------------- steer & fork (pi 对话管理) ----------------
// steer: 追加/打断 — 会话正在回复时,把新消息作为 steer 排入 pi 运行队列
// (当前回合工具结算后、下一次模型调用前注入，即 pi CLI 的 Enter 语义)。
// 消息内容与结果事件都走原 SSE 连接,因此这里不订阅,快速返回即可。
export async function steerChat(sessionId, { text, images = [], mode = "steer" } = {}) {
  const t = String(text || "").trim();
  if (!t) throw new Error("空消息");
  if (!["steer", "followUp"].includes(mode)) throw new Error("无效的排队方式");
  await openChat(sessionId);
  const c = chat(sessionId);
  if (!c.busy) throw new Error("会话当前空闲，请直接发送");
  if (c.stopped) throw new Error("会话正在停止，请稍后再发送");
  if (c.ui.pending.size) throw new Error("请先回答或取消当前提问，再发送新消息");
  const imgs = (images || [])
    .filter((im) => im?.data && im.data.length > 50)
    .slice(0, 6)
    .map((im) => ({ type: "image", mimeType: im.mimeType || "image/png", data: im.data }));
  // Use native queue APIs: never start an unobserved prompt during preflight.
  if (mode === "followUp") await c.session.followUp(t, imgs);
  else await c.session.steer(t, imgs);
  return { ok: true, queued: true, mode };
}

// fork(编辑重问/重定向): 在某条历史问题之前切出新分支会话文件
// (pi 的 createBranchedSession 语义:保留到该问题之前的历史,原会话文件不动),
// 新会话与原会话在会话列表里并列,互不影响。
export async function forkChat(sessionId, { entryId, title = null } = {}) {
  if (!entryId) throw new Error("缺少目标消息");
  const c = chats.has(sessionId) ? chats.get(sessionId) : { session: await openChat(sessionId), busy: false };
  const live = c.session;
  const sm0 = live.sessionManager;
  const entry = sm0?.getEntry?.(entryId);
  if (!entry || entry.type !== "message" || entry.message?.role !== "user") {
    throw new Error("找不到要重问的问题消息（可能已被压缩或不在当前分支）");
  }
  const file = live.sessionFile || sm0?.getSessionFile?.();
  if (!file || !fs.existsSync(file)) {
    throw new Error("会话尚未保存，等 agent 回复过一次后再重问");
  }
  const meta = sessionMeta(sessionId) || {};
  const leafId = entry.parentId;
  let newSm;
  if (leafId) {
    newSm = SessionManager.open(file);
    const newFile = newSm.createBranchedSession(leafId);
    if (!fs.existsSync(newFile)) {
      // pi 只在分支包含 assistant 消息时落盘;空分支(如重问第一条)手动
      // 物化文件,让新会话立即可被发现/打开。
      fs.writeFileSync(newFile, newSm.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  } else {
    // fork 点在第一条用户消息之前:新建空会话文件并链接 parentSession
    newSm = SessionManager.create(APP_ROOT);
    newSm.newSession({ parentSession: file });
    fs.writeFileSync(newSm.sessionFile, JSON.stringify(newSm.fileEntries[0]) + "\n");
  }
  const newId = newSm.sessionId;
  setSessionMeta(newId, {
    paperId: meta.paperId || null,
    projectId: meta.projectId || null,
    title: title || meta.title || null,
    updatedAt: new Date().toISOString(),
  });
  const idHolder = { id: newId, paperId: meta.paperId || null };
  const { session } = await createAgentSession(makeSessionOpts(newSm, idHolder, meta.projectId || null));
  chats.set(newId, { session, ui: idHolder.ui, busy: false });
  return { id: newId, model: session.model ? { provider: session.model.provider, id: session.model.id } : null };
}

// ---------------- prompt streaming (SSE) ----------------

function sse(send, obj) {
  send(`data: ${JSON.stringify(obj)}\n\n`);
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Streamable partial tool output (bash prints cumulative snapshots here)
function partialToolText(result) {
  if (typeof result === "string") return result;
  const rc = result?.content;
  if (Array.isArray(rc)) return rc.map((x) => (x.type === "text" ? x.text : "")).join("");
  return "";
}

export async function promptChat(sessionId, { text, images = [], paperId, projectId }, send, signal) {
  await openChat(sessionId);
  if (signal?.aborted) return;
  const c = chat(sessionId);
  if (c.busy) throw new Error("该会话正在回复中，请稍候或另开会话");
  c.busy = true;
  c.stopped = false;
  c.ui.connect((event) => sse(send, event));
  const onAbort = () => { void abortChat(sessionId).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (paperId || projectId) setSessionMeta(sessionId, { ...(paperId ? { paperId } : {}), ...(projectId ? { projectId } : {}) });
  if (!sessionMeta(sessionId)?.title && text) setSessionMeta(sessionId, { title: text.slice(0, 60) });
  setSessionMeta(sessionId, { updatedAt: new Date().toISOString() });

  const unsub = c.session.subscribe((event) => {
    try {
      if (event.type === "queue_update") {
        sse(send, { t: "queue", steering: event.steering, followUp: event.followUp });
      } else if (event.type === "message_start") {
        const m = event.message;
        if (m.role === "assistant") sse(send, { t: "assistant_start" });
        else if (m.role === "user") sse(send, { t: "user_start", text: typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n"), images: (Array.isArray(m.content) ? m.content : []).filter((p) => p.type === "image") });
      } else if (event.type === "message_update") {
        const e = event.assistantMessageEvent || {};
        if (e.type === "text_delta" && e.delta) sse(send, { t: "delta", text: e.delta });
        else if (e.type === "thinking_delta" && e.delta) sse(send, { t: "thinking", text: e.delta });
      } else if (event.type === "tool_execution_start") {
        sse(send, { t: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_update") {
        const text = partialToolText(event.partialResult);
        if (text) sse(send, { t: "tool_update", id: event.toolCallId, name: event.toolName, text: truncate(text, 16000), total: text.length });
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
    if (!c.extensionsBound) {
      // Bind after the SSE transport is live, since session_start can ask a question.
      c.extensionsBound = true;
      try {
        await c.session.bindExtensions({
          mode: "rpc",
          uiContext: c.ui.context(c.session.extensionRunner.getUIContext()),
          onError: (event) => c.ui.send?.({ t: "notice", note: event.error, isError: true }),
        });
      } catch (error) {
        c.extensionsBound = false;
        throw error;
      }
    }
    if (c.stopped || signal?.aborted) return;
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
    c.ui.disconnect("finished");
    signal?.removeEventListener("abort", onAbort);
    unsub();
    c.busy = false;
  }
}
