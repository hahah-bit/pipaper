import { api, state, el } from "./app.js";
import { renderMd } from "./chat.js";
import { generateFigureDoc } from "./figureGen.js";
import { renderMermaidFile } from "./notesPanel.js";
import { lightbox } from "./reader.js";

// 图表分析（dock 抽屉）：拆成三个独立子模块，而不是一篇长文档。
// - 🖼 图解析：解析块里的每张图一张卡片 —— 原图在上，AI 解读（方法结构分析.md 中对应小节）直接跟在图下方
// - 📊 表解析：每张表一张卡片 —— 原表在上（外框/公式已修），AI 解读（实验设计解析.md 对应小节）在下方
// - 🗺 复现大纲：整篇 复现大纲.md（含 mermaid 流水线图）
// 解读小节的匹配靠标题锚点（图N / 表N），figureTemplates.js 的提示词骨架与之对齐。

const FIG_RE = /(?:图|Figure|Fig\.?)\s*(\d+)(?!\d)/i;
const TBL_RE = /(?:表|Table)\s*(\d+)(?!\d)/i;

const DOCS = [
  { key: "struct", file: "方法结构分析.md", label: "图解析", full: "方法结构分析", icon: "🖼", desc: "逐图解读 · 图-公式-组件串联" },
  { key: "expr", file: "实验设计解析.md", label: "表解析", full: "实验设计解析", icon: "📊", desc: "逐表解读 · 对照组与公平性" },
  { key: "repro", file: "复现大纲.md", label: "复现大纲", full: "复现大纲", icon: "🗺", desc: "声称清单 · 实验流水线 · 改进定位" },
];

// ---------------- markdown 分段：把文档切成 {level,title,text} 段 ----------------
function splitSections(md) {
  const lines = String(md || "").split(/\r?\n/);
  const secs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      cur = { level: m[1].length, title: m[2].trim(), lines: [] };
      secs.push(cur);
    } else if (cur) cur.lines.push(line);
    else { cur = { level: 0, title: "", lines: [line] }; secs.push(cur); }
  }
  return secs.map((s) => ({ level: s.level, title: s.title, text: s.lines.join("\n").trim() })).filter((s) => s.text || s.title);
}

// 命中 图N/表N 的段：连同其更深层的子段一起算该资产的解读
function matchAssetSections(secs, re) {
  const byNum = new Map();
  const used = new Set();
  secs.forEach((s, i) => {
    if (used.has(i)) return;
    const m = s.title.match(re);
    if (!m || s.level === 0) return;
    const num = +m[1];
    used.add(i);
    if (!byNum.has(num)) {
      let text = s.text;
      for (let j = i + 1; j < secs.length && secs[j].level > s.level; j++) { text += "\n\n" + secs[j].text; used.add(j); }
      byNum.set(num, text);
    }
  });
  const rest = secs.filter((s, i) => !used.has(i) && (s.text || s.title));
  return { byNum, rest };
}

function numFromCaption(caption, re) {
  const m = String(caption || "").match(re);
  return m ? +m[1] : null;
}

// ---------------- 数据 ----------------
async function loadBlocks(paper) {
  try {
    const res = await fetch(`/api/papers/${paper.id}/blocks`).then((r) => r.json());
    return res.blocks || [];
  } catch { return []; }
}

async function lookupEntry(paper) {
  const { slug } = await api.notesResolve(paper.id, paper.title || "");
  const data = await api.notes();
  return data.categories.find((c) => c.category === "图表分析")?.papers.find((x) => x.slug === slug) || null;
}

async function readDoc(relPath) {
  const r = await api.file("knowledge/" + relPath);
  return r.content || "";
}

// ---------------- 通用部件 ----------------
function mdBox(text, cls = "") {
  const box = el("div", { class: "paper-doc figmd " + cls });
  renderMd(text, box);
  return box;
}

function analysisBox(text, missing, onGenerate) {
  if (text) return mdBox(text);
  return el("div", { class: "figcard-missing" },
    el("span", {}, missing),
    onGenerate ? el("button", { class: "tool-btn", onclick: onGenerate }, "⚡ 重新生成") : null);
}

// 空态：科研流程闭环示意（未选论文时）
function researchWorkflowDiagram() {
  const chain = [
    ["📑", "选定论文", "解析 · 精读"],
    ["🖼", "图解析", "原图 + 逐图解读"],
    ["📊", "表解析", "原表 + 逐表解读"],
    ["🗺", "复现大纲", "流水线 · 改进定位"],
    ["✍️", "反哺写作", "改图 · 改实验 · 改文稿"],
  ];
  const nodes = chain.map(([icon, t, s], i) => {
    const node = el("div", { class: "fw-node" },
      el("div", { class: "fw-icon" }, icon),
      el("div", { class: "fw-t" }, t),
      el("div", { class: "fw-s" }, s));
    if (i < chain.length - 1) node.append(el("div", { class: "fw-arrow" }, "→"));
    return node;
  });
  return el("div", { class: "fw-wrap" },
    el("div", { class: "fw-title" }, "图表分析 · 科研流程闭环"),
    el("div", { class: "fw-sub" }, "读懂图 → 看懂表 → 可复现 → 反哺写作"),
    el("div", { class: "fw-chain" }, ...nodes),
  );
}

// ---------------- 三个子模块的内容渲染 ----------------
// 图解析：每张图一张卡片，原图在上、解读直接跟在下方
function renderFigures(container, paper, blocks, docText, genMissing) {
  const figures = blocks.filter((b) => b.type === "image");
  const secs = splitSections(docText);
  const { byNum, rest } = matchAssetSections(secs, FIG_RE);
  if (!figures.length) {
    container.append(el("div", { class: "figana-empty" },
      el("div", {}, "🖼"), el("p", {}, "当前论文的解析结果中没有图片块（可能未用 MinerU 解析）。"),
      el("p", { class: "res-note" }, "先用「解析」选择 MinerU 引擎重新解析，即可保留图片。")));
    return;
  }
  figures.forEach((b, idx) => {
    const num = numFromCaption(b.caption, FIG_RE) ?? (idx + 1);
    const url = `/api/papers/${paper.id}/${b.src}`;
    const card = el("div", { class: "figcard" },
      el("div", { class: "figcard-tag" }, `图 ${num}`),
      el("div", { class: "figcard-media" },
        el("img", { src: url, alt: b.caption || `图${num}`, loading: "lazy", onclick: () => lightbox(url, b.caption) })),
      b.caption ? el("div", { class: "figcard-cap" }, b.caption) : null,
      el("div", { class: "figcard-body" },
        analysisBox(byNum.get(num), `方法结构分析中未找到「图${num}」的解读小节。`, genMissing)));
    container.append(card);
  });
  if (rest.length) {
    container.append(el("details", { class: "figana-overview" },
      el("summary", {}, "🧩 综合解读（数据流 · 写作逻辑 · 速查）"),
      ...rest.filter((s) => s.text).map((s) => mdBox(s.text))));
  }
}

// 表解析：每张表一张卡片，原表在上、解读在下方
function renderTables(container, paper, blocks, docText, genMissing) {
  const tables = blocks.filter((b) => b.type === "table");
  const secs = splitSections(docText);
  const { byNum, rest } = matchAssetSections(secs, TBL_RE);
  if (!tables.length) {
    container.append(el("div", { class: "figana-empty" },
      el("div", {}, "📊"), el("p", {}, "当前论文的解析结果中没有表格块。"),
      el("p", { class: "res-note" }, "推荐用 MinerU 解析以保留表格结构。")));
    return;
  }
  // 无编号的表按顺序认领剩余的解读小节
  const claimed = new Set([...byNum.keys()]);
  const queue = [...byNum.keys()].sort((a, b) => a - b).filter((n) => !tables.some((b) => numFromCaption(b.caption, TBL_RE) === n));
  tables.forEach((b, idx) => {
    let num = numFromCaption(b.caption, TBL_RE);
    if (num == null) { num = queue.shift() ?? idx + 1; }
    claimed.add(num);
    const card = el("div", { class: "figcard" },
      el("div", { class: "figcard-tag" }, `表 ${num}`),
      b.caption ? el("div", { class: "figcard-cap figcard-cap-top" }, b.caption) : null,
      el("div", { class: "figcard-tbl" }, (() => {
        const wrap = el("div", { class: "tbl-wrap" });
        renderMd(b.html || b.md || "（表格内容为空）", wrap);
        return wrap;
      })()),
      el("div", { class: "figcard-body" },
        analysisBox(byNum.get(num), `实验设计解析中未找到「表${num}」的解读小节。`, genMissing)));
    container.append(card);
  });
  if (rest.length) {
    container.append(el("details", { class: "figana-overview" },
      el("summary", {}, "🧪 综合解读（实验总览 · 设计教学 · 数字速查）"),
      ...rest.filter((s) => s.text).map((s) => mdBox(s.text))));
  }
}

// 复现大纲：整篇文档（mermaid 流水线）
async function renderRepro(container, docText) {
  const holder = el("div", { class: "figana-doc" });
  container.append(holder);
  try { await renderMermaidFile(holder, docText); }
  catch (e) { holder.replaceChildren(mdBox(docText)); }
}

// ---------------- 模块主体 ----------------
export function figureDrawerModule() {
  let alive = false;
  let rootEl = null;
  let activeDoc = "struct";
  let onChanged = null;

  async function render() {
    if (!alive || !rootEl) return;
    const paper = state.currentPaper;
    if (!paper?.id) {
      rootEl.replaceChildren(
        researchWorkflowDiagram(),
        el("div", { class: "fig-empty-hint" }, "在左侧文献库选择一篇论文后，这里生成该论文的图表分析。"));
      return;
    }
    const status = el("span", { class: "res-note figana-status" });
    const setStatus = (t) => { status.textContent = t || ""; };
    rootEl.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "加载中…"));

    let entry = null;
    try { entry = await lookupEntry(paper); }
    catch (e) {
      const msg = String(e.message || e);
      rootEl.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } },
        "加载失败: " + (/HTTP 404/.test(msg) ? "后端没有图表分析接口——请重启 PiPaper。" : msg)));
      return;
    }
    if (!alive) return;
    const files = entry?.files || [];
    const have = (d) => files.some((f) => f.name === d.file);
    if (!have(DOCS.find((d) => d.key === activeDoc))) activeDoc = (DOCS.find((d) => have(d)) || DOCS[0]).key;

    // 生成逻辑：单份 / 全部
    async function generate(kind) {
      if (!paper?.id) return;
      try {
        await generateFigureDoc({ paperId: paper.id, title: paper.title }, kind, { onStatus: setStatus });
        toast("已生成，图表分析已更新");
      } catch (e) { toast(String(e.message || e), true); }
      await render();
    }

    const genAll = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        genAll.disabled = true;
        for (const d of DOCS) { setStatus(`全部生成：${d.full}…`); await generate(d.key); }
        setStatus("");
        genAll.disabled = false;
      },
    }, "⚡ 全部生成");

    // 子模块切换条
    const tabs = el("div", { class: "figana-tabs" });
    const content = el("div", { class: "figana-content" });
    async function showTab(key) {
      activeDoc = key;
      [...tabs.querySelectorAll(".figana-tab")].forEach((n) => n.classList.toggle("active", n.dataset.key === key));
      content.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "加载中…"));
      const d = DOCS.find((x) => x.key === key);
      const f = files.find((x) => x.name === d.file);
      if (!f) {
        content.replaceChildren(el("div", { class: "fig-gen-card solo" },
          el("div", { class: "fgc-icon" }, d.icon),
          el("div", { class: "fgc-t" }, `尚未生成${d.full}`),
          el("div", { class: "fgc-s" }, d.desc),
          el("button", { class: "tool-btn primary", onclick: (e) => { e.currentTarget.disabled = true; generate(key); } }, "⚡ 立即生成")));
        return;
      }
      try {
        const text = await readDoc(f.path);
        if (!alive) return;
        content.replaceChildren();
        const regen = el("button", { class: "tool-btn", title: `重新生成${d.full}`, onclick: (e) => { e.currentTarget.disabled = true; generate(key); } }, "↻");
        const bar = el("div", { class: "figana-docbar" }, el("span", { class: "res-note" }, `来源：${d.full}.md`), el("div", { class: "spacer" }), regen);
        content.append(bar);
        if (key === "struct") renderFigures(content, paper, blocks, text, () => generate("struct"));
        else if (key === "expr") renderTables(content, paper, blocks, text, () => generate("expr"));
        else await renderRepro(content, text);
      } catch (e) {
        content.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "读取失败: " + (e.message || e)));
      }
    }
    for (const d of DOCS) {
      tabs.append(el("button", {
        class: "figana-tab" + (activeDoc === d.key ? " active" : "") + (have(d) ? "" : " missing"),
        "data-key": d.key,
        title: have(d) ? d.desc : `${d.full}尚未生成——点击后可生成`,
        onclick: () => showTab(d.key),
      }, `${d.icon} ${d.label}${have(d) ? "" : " ＋"}`));
    }

    const blocks = await loadBlocks(paper);
    if (!alive) return;
    const head = el("div", { class: "figana-head" },
      el("span", { class: "figana-title", title: paper.title }, `📊 ${String(paper.title).slice(0, 40)}`),
      status, el("div", { class: "spacer" }), genAll);
    rootEl.replaceChildren(head, tabs, content);
    await showTab(activeDoc);
  }

  return {
    id: "figana",
    name: "图表分析",
    icon: "📊",
    mount(body, ctx) {
      alive = true;
      rootEl = el("div", { class: "figana" });
      body.append(rootEl);
      render();
      onChanged = () => { if (alive) render(); };
      window.addEventListener("pipaper:paper-changed", onChanged);
    },
    unmount() {
      alive = false;
      if (onChanged) window.removeEventListener("pipaper:paper-changed", onChanged);
      onChanged = null;
      rootEl?.remove();
      rootEl = null;
    },
  };
}
