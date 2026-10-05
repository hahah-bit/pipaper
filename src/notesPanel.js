import { api } from "./platform/api.js";
import { state } from "./shell/state.js";
import { el, toast } from "./platform/dom.js";
import { renderMd } from "./platform/markdown.js";
import { renderMarkmap } from "./markmapUtil.js";
import { registerModule } from "./modules.js";
import { generateArtifact } from "./notesGen.js";

// 知识模块（粗读解析 / 思维导图 / 流程图）。资料管理使用统一存储工作区。
// 数据全部来自 knowledge/粗读/<slug>/ 下的 markdown 文件；生成走 notesGen 的临时会话。

const FILE_NOTE = "粗读解析.md";
const FILE_MINDMAP = "思维导图.md";
const FILE_FLOW = "流程图.md";
const FILE_ALGO = "算法迭代图.md";
const noopReasons = new Map(); // `${paperId}/algo` → AI 给出的无需生成原因

async function lookupPaperNotes() {
  const p = state.currentPaper;
  if (!p?.id) return { paper: null };
  const { slug } = await api.notesResolve(p.id, p.title || "");
  const data = await api.notes();
  const entry = data.categories.find((c) => c.category === "粗读")?.papers.find((x) => x.slug === slug) || null;
  return { paper: p, slug, entry };
}

async function readNoteFile(relUnderKnowledge) {
  // 列表返回的 path 已含类别段（粗读/<slug>/<file>.md）
  const r = await api.file("knowledge/" + relUnderKnowledge);
  return r.content || "";
}

// 思维导图大图查看：挂在当前全屏元素内，markmap 自动铺满并可滚轮缩放
function openMindmapLightbox(md) {
  const host = document.fullscreenElement || document.body;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.width = "100%";
  svg.style.height = "100%";
  const overlay = el("div", { class: "mindmap-lightbox" },
    el("div", { class: "mindmap-lb-bar" },
      el("span", { class: "res-note" }, "滚轮缩放 · 拖拽平移"),
      el("div", { class: "spacer" }),
      el("button", { class: "tool-btn", onclick: () => mmLb?.fit?.() }, "适应窗口"),
      el("button", { class: "tool-btn primary", onclick: () => overlay.remove() }, "✕ 关闭")
    ),
    svg
  );
  host.append(overlay);
  let mmLb = null;
  renderMarkmap(svg, md, { maxWidth: 320 })
    .then((mm) => { mmLb = mm; return mm.fit(); })
    .catch((e) => overlay.replaceChildren(el("div", { class: "res-note", style: { padding: "24px" } }, "导图渲染失败: " + (e.message || e))));
}

async function doGenerate(kind, { setStatus, done }) {
  const paper = state.currentPaper;
  if (!paper?.id) return toast("请先选择论文", true);
  try {
    const r = await generateArtifact({ paperId: paper.id, title: paper.title }, kind, { onStatus: setStatus });
    if (r?.noop) {
      noopReasons.set(`${paper.id}/${kind}`, r.reason || "");
      toast("AI 判定无需生成：" + (r.reason || "本文不涉及"), false);
    } else {
      toast("已生成，知识库已更新");
    }
  } catch (e) {
    toast(String(e.message || e), true);
  }
  done?.();
}

// ---------------- mermaid 懒加载渲染 ----------------
let mermaidLoading = null;
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/mermaid.min.js";
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("mermaid 加载异常")));
    s.onerror = () => { mermaidLoading = null; reject(new Error("mermaid 脚本加载失败（public/vendor/mermaid.min.js 缺失）")); };
    document.head.append(s);
  });
  return mermaidLoading;
}

function mermaidTheme() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg0").trim();
  const m = bg.match(/^#([0-9a-f]{6})$/i);
  if (!m) return "dark";
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 128 ? "dark" : "default";
}

async function renderMermaid(container, code) {
  const mermaid = await ensureMermaid();
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: mermaidTheme(), fontFamily: "inherit" });
  const { svg } = await mermaid.render("mmd-" + Math.random().toString(36).slice(2, 9), code);
  container.innerHTML = svg;
}

export async function renderMermaidFile(box, mdText) {
  const blocks = [...String(mdText || "").matchAll(/```mermaid\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const prose = String(mdText || "").replace(/```mermaid[\s\S]*?```/gi, "").trim();
  if (prose) {
    const p = el("div", { class: "note-prose paper-doc" });
    renderMd(prose, p);
    box.append(p);
  }
  if (!blocks.length) {
    if (!prose) box.append(el("div", { class: "res-note" }, "（文件为空）"));
    return;
  }
  for (const code of blocks) {
    const holder = el("div", { class: "mermaid-box" });
    box.append(holder);
    try { await renderMermaid(holder, code); }
    catch (e) {
      holder.replaceChildren(
        el("pre", { class: "mermaid-src" }, code),
        el("div", { class: "res-note" }, "mermaid 渲染失败: " + e.message)
      );
    }
  }
}

// ---------------- 模块通用骨架 ----------------
function emptyState(icon, title, desc, actionLabel, onAction) {
  return el("div", { class: "note-empty" },
    el("div", { class: "note-empty-icon" }, icon),
    el("h4", {}, title),
    desc ? el("p", {}, desc) : null,
    actionLabel ? el("button", { class: "tool-btn primary", onclick: onAction }, actionLabel) : null
  );
}

function makeNoteModule({ id, name, icon, artifacts }) {
  // artifacts: [{kind, file, label, noun, optional?}] — noun 用于空态文案，避免「生成生成」叠词
  let alive = false;
  let mm = null;
  let onNotesChanged = null;
  let rootEl = null;
  let mountDispose = null;
  return {
    id, name, icon,
    mount(body, ctx) {
      alive = true; mm = null;
      const status = el("span", { class: "note-mod-status res-note" });
      const setStatus = (t) => { status.textContent = t || ""; ctx?.setStatus?.(t || ""); };
      const content = el("div", { class: "note-mod-content" });
      const genButtons = [];

      const genBtn = (art) => {
        const b = el("button", {
          class: "tool-btn primary" + (art.optional ? " subtle" : ""),
          title: art.optional ? "可选：仅当论文方法存在迭代过程时生成" : `生成/重新生成${art.noun}`,
          onclick: async () => {
            b.disabled = true;
            await doGenerate(art.kind, { setStatus, done: () => { b.disabled = false; } });
            await refresh();
          },
        }, art.label);
        genButtons.push(b);
        return b;
      };

      const head = el("div", { class: "note-mod-bar" },
        el("span", { class: "note-mod-title" }, `${icon} ${name}`),
        status,
        el("div", { class: "spacer" }),
        ...artifacts.map(genBtn),
        el("button", { class: "tool-btn", title: "重新加载", onclick: () => refresh() }, "↻")
      );
      const root = el("div", { class: "note-mod" }, head, content);
      rootEl = root;
      body.append(root);

      async function refresh() {
        if (!alive) return;
        for (const b of genButtons) b.disabled = true;
        content.replaceChildren(el("div", { class: "res-note", style: { padding: "18px" } }, "加载中…"));
        const paper = state.currentPaper;
        if (!paper?.id) {
          content.replaceChildren(emptyState("📂", "请先选择论文", "回到主界面在文献库中选择一篇论文后再来生成笔记。"));
          for (const b of genButtons) b.disabled = true;
          return;
        }
        try {
          const { entry } = await lookupPaperNotes();
          const files = entry?.files || [];
          await renderInto(content, files);
        } catch (e) {
          const msg = String(e.message || e);
          // 旧版后端没有 /api/notes 路由，Express 返回 HTML 404
          const hint = /HTTP 404/.test(msg)
            ? "后端没有笔记接口（HTTP 404）——当前运行的 PiPaper 是旧版本，请完全关闭旧进程后重新 npm start。"
            : msg;
          content.replaceChildren(el("div", { class: "res-note", style: { padding: "18px", lineHeight: 1.8 } }, "加载失败: " + hint));
        } finally {
          if (alive) for (const b of genButtons) b.disabled = false;
        }
      }

      async function renderInto(box, files) {
        box.replaceChildren();
        // 思维导图模式：内容区不再滚动，svg 铺满整个栏位高度
        box.classList.toggle("mindmap-mode", artifacts.some((a) => a.render === "mindmap"));
        for (const art of artifacts) {
          const file = files.find((f) => f.name === art.file);
          const noop = noopReasons.get(`${state.currentPaper?.id}/${art.kind}`);
          if (artifacts.length > 1) box.append(el("div", { class: "note-sec" }, `${art.icon} ${art.noun}${art.optional ? "（可选）" : ""}`));
          if (file) {
            const holder = el("div", { class: "note-file-view" });
            box.append(holder);
            let text = null;
            try {
              text = await readNoteFile(file.path);
            } catch {
              // 列表里有但读取失败（文件被移动/删除等）：按未生成处理，回到空态而不是整模块报错
              text = null;
            }
            if (text == null) {
              holder.replaceChildren(emptyState(art.icon, `读取${art.noun}失败`,
                "文件可能刚被删除或移动，可重新生成。",
                `⚡ 生成${art.noun}`,
                async () => {
                  for (const b of genButtons) b.disabled = true;
                  await doGenerate(art.kind, { setStatus, done: () => {} });
                  await refresh();
                }));
              continue;
            }
            if (art.render === "mindmap") {
              holder.classList.add("mindmap-view");
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              svg.setAttribute("class", "note-mindmap");
              const zoomBy = (k) => {
                const cur = mm?.state?.scale || 1;
                mm?.rescale?.(Math.min(5, Math.max(0.15, cur * k)));
              };
              const toolbar = el("div", { class: "note-toolbar" },
                el("button", { class: "tool-btn", title: "放大", onclick: () => zoomBy(1.25) }, "🔍＋"),
                el("button", { class: "tool-btn", title: "缩小", onclick: () => zoomBy(0.8) }, "🔍－"),
                el("button", { class: "tool-btn", title: "适应窗口", onclick: () => mm?.fit?.() }, "适应窗口"),
                el("button", { class: "tool-btn", title: "全屏查看（滚轮缩放 / 拖拽平移）", onclick: () => openMindmapLightbox(text) }, "⛶ 大图查看"),
                el("span", { class: "res-note", style: { flex: 1, textAlign: "right" } }, "滚轮缩放 · 拖拽平移")
              );
              holder.append(toolbar, svg);
              try {
                mm = await renderMarkmap(svg, text, { maxWidth: 220 });
                await mm.fit();
              } catch (e) { holder.append(el("div", { class: "res-note" }, "导图渲染失败: " + (e.message || e))); }
              // 栏位尺寸变化（切布局/拖分隔条）时自动重新铺满
              let roTimer = null;
              const ro = new ResizeObserver(() => {
                clearTimeout(roTimer);
                roTimer = setTimeout(() => { try { mm?.fit?.(); } catch {} }, 250);
              });
              ro.observe(holder);
              mountDispose = () => { clearTimeout(roTimer); ro.disconnect(); };
            } else if (art.render === "mermaid") {
              await renderMermaidFile(holder, text);
            } else {
              const doc = el("div", { class: "paper-doc note-md" });
              renderMd(text, doc);
              holder.append(doc);
            }
          } else if (art.optional && noop) {
            box.append(el("div", { class: "note-noop" },
              el("div", {}, "🤖 AI 判定本文无需生成：" + noop),
              el("button", { class: "tool-btn", onclick: () => { noopReasons.delete(`${state.currentPaper?.id}/${art.kind}`); refresh(); } }, "重新判定")
            ));
          } else {
            box.append(emptyState(art.icon,
              `尚未生成${art.noun}`,
              art.hint || "",
              `⚡ 立即生成${art.noun}`,
              async () => {
                for (const b of genButtons) b.disabled = true;
                await doGenerate(art.kind, { setStatus, done: () => {} });
                await refresh();
              }
            ));
          }
        }
      }

      refresh();
      onNotesChanged = () => { if (alive) refresh(); };
      window.addEventListener("pipaper:notes-changed", onNotesChanged);
      window.addEventListener("pipaper:paper-changed", onNotesChanged);
    },
    unmount() {
      alive = false;
      if (onNotesChanged) window.removeEventListener("pipaper:notes-changed", onNotesChanged);
      if (onNotesChanged) window.removeEventListener("pipaper:paper-changed", onNotesChanged);
      onNotesChanged = null;
      try { mountDispose?.(); } catch {}
      mountDispose = null;
      rootEl?.remove();
      rootEl = null;
    },
  };
}

export function registerNoteModules() {
  registerModule(makeNoteModule({
    id: "note", name: "粗读解析", icon: "📝",
    artifacts: [{ kind: "note", file: FILE_NOTE, label: "生成粗读解析", noun: "粗读解析", icon: "📝", render: "md",
      hint: "交代论文讲了什么、为什么写、解决了什么问题、有何局限 —— 一键由 AI 粗读摘要与结论后写入知识库。" }],
  }));
  registerModule(makeNoteModule({
    id: "mindmap", name: "思维导图", icon: "🧠",
    artifacts: [{ kind: "mindmap", file: FILE_MINDMAP, label: "生成思维导图", noun: "思维导图", icon: "🧠", render: "mindmap",
      hint: "不是章节目录，而是「问题→洞察→方法组件→实验→局限」的内容导图。" }],
  }));
  registerModule(makeNoteModule({
    id: "flow", name: "流程图", icon: "🗺",
    artifacts: [
      { kind: "flow", file: FILE_FLOW, label: "生成流程图", noun: "流程图", icon: "🗺", render: "mermaid",
        hint: "mermaid 流程图交代文章论证脉络与方法流水线。" },
      { kind: "algo", file: FILE_ALGO, label: "生成迭代图", noun: "算法迭代图", icon: "🔁", render: "mermaid", optional: true,
        hint: "可选：若论文方法存在 v1→v2 的迭代改进，生成算法迭代图。" },
    ],
  }));
}
