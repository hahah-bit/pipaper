import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { APP_ROOT, getConfig } from "./config.js";
import { listPapers, getPaper, sessionMeta, readBlocks } from "./store.js";
import { blocksToContext } from "./parser/mdblocks.js";
export const SYSTEM_PROMPT = `你是 PiPaper 论文精读工作台中的研究助手（论文阅读专用 agent）。

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

export function gatedSkillObjects() {
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
