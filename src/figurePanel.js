import { api, state, $, el, toast } from "./app.js";
import { renderMd } from "./chat.js";
import { switchTab } from "./reader.js";
import { generateFigureDoc } from "./figureGen.js";

// 图表分析管理界面（阅读器「📊 图表分析」tab）：
// - 无报告：科研流程图空态（通用业务链，虚化设计）+ 选择生成按钮
// - 有报告：分节渲染三份结构化文档 + 每节「重新生成」
// 用户可控：三份文档独立生成，按钮即授权；生成走 figureGen 临时会话。

const DOCS = [
  { key: "struct", file: "方法结构分析.md", label: "方法结构分析", icon: "🧩", desc: "图-公式-组件串联 · 写作逻辑 · 更改逻辑" },
  { key: "expr", file: "实验设计解析.md", label: "实验设计解析", icon: "🧪", desc: "逐表解析 · 对照组与公平性 · 实验设计教学" },
  { key: "repro", file: "复现大纲.md", label: "复现大纲", icon: "🗺", desc: "声称清单 · 实验总括大纲 · 改进定位表" },
];

let activeDoc = "struct";
let renderSeq = 0;
let assetCache = { paperId: null, figures: new Map(), tables: new Map() }; // 原图原表索引

async function buildAssetIndex(paper) {
  if (assetCache.paperId === paper.id) return assetCache;
  const idx = { paperId: paper.id, figures: new Map(), tables: new Map() };
  try {
    const res = await fetch(`/api/papers/${paper.id}/blocks`).then((r) => r.json());
    for (const b of res.blocks || []) {
      if (b.type === "image" && b.src) {
        const m = String(b.caption || "").match(/(?:图|Figure|Fig\.?)\s*(\d+)/i);
        if (m && !idx.figures.has(+m[1])) {
          idx.figures.set(+m[1], { url: `/api/papers/${paper.id}/${b.src}`, caption: b.caption || `图${m[1]}` });
        }
      } else if (b.type === "table" && (b.html || b.md)) {
        const m = String(b.caption || "").match(/(?:表|Table)\s*(\d+)/i);
        if (m && !idx.tables.has(+m[1])) {
          idx.tables.set(+m[1], { html: b.html || b.md, caption: b.caption || `表${m[1]}` });
        }
      }
    }
  } catch {}
  assetCache = idx;
  return idx;
}

// 在文档 DOM 里找 图N/表N 的首次引用位置，把原图/原表插到该段落之后
function embedOriginalAssets(docBox, idx) {
  if (!idx || (!idx.figures.size && !idx.tables.size)) return;
  const pat = /(图|Figure|Fig\.?)\s*(\d+)|(表|Table)\s*(\d+)/g;
  const inserted = new Set();
  for (const node of [...docBox.children].filter((n) => !n.classList.contains("fig-asset"))) {
    const text = node.textContent || "";
    pat.lastIndex = 0;
    let m, anchor = node;
    while ((m = pat.exec(text))) {
      const isFig = !!m[2];
      const num = +(isFig ? m[2] : m[4]);
      const key = (isFig ? "F" : "T") + num;
      if (inserted.has(key)) continue;
      if (isFig && idx.figures.has(num)) {
        inserted.add(key);
        const { url, caption } = idx.figures.get(num);
        const fig = el("figure", { class: "fig-asset" },
          el("img", { src: url, alt: caption, loading: "lazy", onclick: () => window.open(url, "_blank") }),
          el("figcaption", {}, "📎 原图 " + caption));
        anchor.after(fig);
        anchor = fig;
      } else if (!isFig && idx.tables.has(num)) {
        inserted.add(key);
        const { html, caption } = idx.tables.get(num);
        const holder = el("div", { class: "fig-asset" },
          el("div", { class: "fig-asset-cap" }, "📎 原表 " + caption),
          el("div", { class: "tbl-wrap" }));
        renderMd(html, holder.querySelector(".tbl-wrap"));
        anchor.after(holder);
        anchor = holder;
      }
    }
  }
}

async function lookupFiles() {
  const p = state.currentPaper;
  if (!p?.id) return { paper: null, entry: null };
  const { slug } = await api.notesResolve(p.id, p.title || "");
  const data = await api.notes();
  const entry = data.categories.find((c) => c.category === "图表分析")?.papers.find((x) => x.slug === slug) || null;
  return { paper: p, entry };
}

async function readDoc(relPath) {
  const r = await api.file("knowledge/" + relPath);
  return r.content || "";
}

// ---------------- 生成 ----------------
async function generate(kind, statusEl, btn) {
  const paper = state.currentPaper;
  if (!paper?.id) return toast("请先选择论文", true);
  btn.disabled = true;
  const set = (t) => { statusEl.textContent = t || ""; };
  try {
    await generateFigureDoc({ paperId: paper.id, title: paper.title }, kind, { onStatus: set });
    toast("已生成，图表分析库已更新");
  } catch (e) {
    toast(String(e.message || e), true);
  }
  btn.disabled = false;
  await render(true);
}

// ---------------- 空态：科研流程图（通用，不针对某篇论文） ----------------
function researchWorkflowDiagram() {
  const chain = [
    ["📑", "选定论文", "解析 · 精读"],
    ["📋", "实验契约", "冻结声称与设置"],
    ["🧩", "方法结构分析", "图·公式·组件串联"],
    ["🧪", "实验设计解析", "逐表拆解 · 设计教学"],
    ["🗺", "复现大纲", "总括大纲 · 改进定位"],
    ["🛠", "复现执行", "分层验证"],
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
  const ribbon = (cls, title, items) => el("div", { class: "fw-ribbon " + cls },
    el("span", { class: "fw-ribbon-t" }, title),
    items.map((x, i) => el("span", { class: "fw-ribbon-item" }, x + (i < items.length - 1 ? "  →" : ""))));
  const blob = (cls) => el("div", { class: "fw-blob " + cls });
  return el("div", { class: "fw-wrap" },
    blob("b1"), blob("b2"), blob("b3"),
    el("div", { class: "fw-title" }, "科研流程闭环"),
    el("div", { class: "fw-sub" }, "图表分析是第一环：读懂图 → 看懂实验 → 复现改进 → 反哺写作"),
    el("div", { class: "fw-chain" }, ...nodes),
    ribbon("fw-rc", "写作思维链", ["动机", "洞察", "方法", "验证", "结论"]),
    ribbon("fw-rr", "复现业务链", ["阅读", "契约", "环境", "执行", "对比", "报告"]),
  );
}

// ---------------- 主渲染 ----------------
export async function renderFigurePanel() {
  const seq = ++renderSeq;
  const box = $("#figana-body");
  if (!box || !$("#figana-view") || $("#figana-view").hidden) return;
  box.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "加载中…"));
  const paper = state.currentPaper;
  if (!paper?.id) {
    box.replaceChildren(
      researchWorkflowDiagram(),
      el("div", { class: "fig-empty-hint" }, "在左侧文献库选择一篇论文后，这里生成该论文的图表分析报告。")
    );
    return;
  }
  let entry = null;
  try { ({ entry } = await lookupFiles()); }
  catch (e) {
    const msg = String(e.message || e);
    box.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } },
      "加载失败: " + (/HTTP 404/.test(msg) ? "后端没有图表分析接口——请重启 PiPaper。" : msg)));
    return;
  }
  if (seq !== renderSeq) return;
  const files = entry?.files || [];
  const have = (key) => files.some((f) => f.name === DOCS.find((d) => d.key === key).file);

  // 顶栏：论文标题 + 全部生成
  const status = el("span", { class: "res-note", style: { flex: "1", textAlign: "right" } });
  const genAllBtn = el("button", {
    class: "tool-btn primary",
    onclick: async () => {
      genAllBtn.disabled = true;
      for (const d of DOCS) {
        status.textContent = `全部生成：${d.label}…`;
        await generate(d.key, status, genAllBtn);
      }
      status.textContent = "";
      genAllBtn.disabled = false;
    },
  }, "⚡ 全部生成");
  const head = el("div", { class: "fig-head" },
    el("span", { class: "fig-title", title: paper.title }, `📊 ${String(paper.title).slice(0, 44)}`),
    status, genAllBtn);

  const content = el("div", { class: "fig-content" });
  box.replaceChildren(head, content);

  if (!files.length) {
    content.append(
      researchWorkflowDiagram(),
      el("div", { class: "fig-gen-row" },
        ...DOCS.map((d) => el("button", {
          class: "fig-gen-card",
          onclick: (e) => generate(d.key, status, e.currentTarget),
        },
          el("div", { class: "fgc-icon" }, d.icon),
          el("div", { class: "fgc-t" }, d.label),
          el("div", { class: "fgc-s" }, d.desc),
          el("div", { class: "fgc-go" }, "生成 →"))))
    );
    return;
  }

  // 有报告：分节导航 + 文档渲染
  if (!have(activeDoc)) activeDoc = DOCS.find((d) => have(d.key)).key;
  const nav = el("div", { class: "fig-nav" });
  const docBox = el("div", { class: "fig-doc paper-doc" });
  const assetIdx = await buildAssetIndex(paper);
  async function showDoc(key) {
    activeDoc = key;
    const d = DOCS.find((x) => x.key === key);
    [...nav.children].forEach((n) => n.classList.toggle("active", n.dataset.key === key));
    docBox.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "加载中…"));
    try {
      const f = files.find((x) => x.name === d.file);
      const text = await readDoc(f.path);
      renderMd(text, docBox);
      embedOriginalAssets(docBox, assetIdx);
    } catch (e) {
      docBox.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "读取失败: " + (e.message || e)));
    }
  }
  for (const d of DOCS) {
    nav.append(el("button", {
      class: "fig-nav-btn" + (activeDoc === d.key ? " active" : "") + (have(d.key) ? "" : " missing"),
      dataset: { key: d.key },
      onclick: () => have(d.key) ? showDoc(d.key) : generate(d.key, status, null),
      title: have(d.key) ? d.desc : "尚未生成——点击生成",
    }, `${d.icon} ${d.label}${have(d.key) ? "" : " +"}${have(d.key) ? "" : ""}`));
  }
  const regen = el("button", { class: "tool-btn", title: "重新生成当前文档", onclick: () => generate(activeDoc, status, regen) }, "↻ 重新生成");
  nav.append(el("div", { class: "spacer" }), regen);
  content.append(nav, docBox);
  await showDoc(activeDoc);
}

export function initFigurePanel() {
  $("#tab-figana")?.addEventListener("click", () => { switchTab("figana"); setTimeout(renderFigurePanel, 30); });
  // 论文切换后若停留在本 tab，自动刷新
  window.addEventListener("pipaper:paper-changed", () => {
    if ($("#figana-view") && !$("#figana-view").hidden) renderFigurePanel();
  });
}
