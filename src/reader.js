import * as pdfjsLib from "pdfjs-dist";
import { blocksToContext } from "../server/parser/mdblocks.js";
import { renderMd } from "./chat.js";
import { streamPrompt } from "./chat.js";
import { api, state, $, el, toast, addChip } from "./app.js";
import { getTemplates, saveTemplates, applyTemplate } from "./templates.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

let currentJobId = null;
let jobTimer = null;
let pdfDoc = null;
let boxMode = false;
let renderSeq = 0;
let parseVersions = [];
let previewing = false;

// ---------------- load paper ----------------
export async function readerLoadPaper(p) {
  $("#tab-parsed").click();
  $("#reader-status").textContent = p.title ? p.title.slice(0, 42) : "";
  document.title = `${p.title || "PiPaper"} · PiPaper`;
  await loadParsed(p);
  // reset pdf
  pdfDoc = null;
  $("#pdf-pages").replaceChildren();
}

async function loadParsed(p) {
  $("#parsed-content").replaceChildren();
  const res = await fetch(`/api/papers/${p.id}/blocks`).then((r) => r.json());
  if (state.currentPaper?.id !== p.id) return;
  previewing = false;
  updateParseStatus(res.status, res.engine, res.error);
  if (res.blocks?.length) {
    renderBlocks(p, res.blocks, res.paper, res);
  } else {
    $("#parsed-content").replaceChildren();
    $("#parsed-empty").hidden = false;
  }
}

function updateParseStatus(status, engine, error) {
  const chip = $("#reader-status");
  const btnParse = $("#btn-parse");
  chip.dataset.status = status;
  const label = { none: "未解析", running: "解析中…", done: `已解析${engine ? " · " + engine : ""}`, error: "解析失败" }[status] || status;
  chip.textContent = (state.currentPaper ? "" : "") + label;
  btnParse.textContent = status === "done" ? "重新解析" : "解析";
}

// ---------------- parsed blocks rendering ----------------
function renderBlocks(paper, blocks, meta, document = {}) {
  $("#parsed-empty").hidden = true;
  const wrap = $("#parsed-content");
  wrap.replaceChildren();

  wrap.append(el("h1", { class: "doc-title" }, paper.title || "(无标题)"));
  const metaBits = [(paper.creators || []).slice(0, 4).join(", "), paper.year, paper.publication, paper.doi ? `DOI: ${paper.doi}` : "", `引擎: ${document.meta?.engine || meta?.parse?.engine || "?"}`].filter(Boolean);
  wrap.append(el("div", { class: "doc-meta" }, metaBits.join(" · ")));
  const notes = document.quality;
  if (notes?.warnings?.length || notes?.errors?.length) wrap.append(el("div", { class: "doc-quality" }, `需核对 ${notes.warnings.length} 项 · 结构错误 ${notes.errors.length} 项`));

  let lastPage = 0;
  let host = wrap;
  let columnGroup = null;
  const nodes = new Map();
  const pageInfo = new Map((document.pages || []).map((p) => [p.page, p]));
  const appendBlock = (b, blk) => {
    if (pageInfo.get(b.page)?.layout === "double" && ["left", "right"].includes(b.column)) {
      if (!columnGroup) {
        columnGroup = { left: el("div", { class: "paper-column" }), right: el("div", { class: "paper-column" }) };
        host.append(el("div", { class: "page-columns" }, columnGroup.left, columnGroup.right));
      }
      columnGroup[b.column].append(blk);
    } else { columnGroup = null; host.append(blk); }
    if (b.id) nodes.set(b.id, blk);
  };
  blocks.forEach((b, idx) => {
    if (b.page && b.page !== lastPage && b.page > lastPage + 0) {
      wrap.append(el("div", { class: "page-mark" }, `— 第 ${b.page} 页 —`));
      host = el("section", { class: "paper-page", "data-page": b.page });
      wrap.append(host);
      columnGroup = null;
      lastPage = b.page;
    }
    const blk = el("div", {
      class: b.type === "code" ? "blk code-blk" : "blk",
      "data-idx": idx,
      ...(b.id ? { "data-block-id": b.id } : {}),
      ...(b.page ? { "data-page": b.page } : {}),
    });
    const addBtn = el("button", {
      class: "add-btn",
      title: "把该部分加入对话",
      style: { right: "0" },
      onclick: (e) => { e.stopPropagation(); addBlockToChat(b, blk, paper, document.meta); },
    }, "＋ 对话");
    const transBtn = el("button", {
      class: "add-btn",
      title: "翻译该段（LibreTranslate）",
      style: { right: "58px" },
      onclick: (e) => { e.stopPropagation(); translateBlock(blk); },
    }, "译");
    if (!previewing) blk.append(addBtn, transBtn);
    if (b.id && document.v === 4) {
      const src = `/api/papers/${paper.id}/regions/${b.id}?version=${encodeURIComponent(document.meta?.versionId || "")}`;
      blk.append(el("button", { class: "add-btn", title: `核对原文 · 第 ${b.page} 页`, style: { right: "96px" }, onclick: () => lightbox(src, `第 ${b.page} 页`) }, "原文"));
      if (b.issues?.length) blk.classList.add("needs-review");
      if (b.type === "code" && b.algorithm) {
        const img = el("img", { class: "source-region algorithm-source", src, alt: `伪代码原文 · 第 ${b.page} 页`, loading: "lazy" });
        img.addEventListener("click", () => lightbox(src, `伪代码原文 · 第 ${b.page} 页`));
        img.addEventListener("error", () => {
          img.hidden = true;
          blk.prepend(el("div", { class: "source-status" }, "原图加载失败，请重试或查看 PDF 原文"));
        }, { once: true });
        blk.append(img, el("details", { class: "algorithm-transcript" },
          el("summary", {}, "识别文本（待核对）"), el("pre", {}, el("code", {}, b.text))));
        appendBlock(b, blk);
        return;
      }
      if (b.issues?.some((issue) => ["formula-syntax", "math-source-conflict", "table-grid-incomplete", "table-numeric-mismatch", "table-merged-values", "table-invalid-html", "empty-table", "empty-source-text"].includes(issue))) {
        blk.append(el("div", { class: "source-status" }, "原文区域 · 识别待核对"));
        blk.append(el("img", { class: "source-region", src, alt: `第 ${b.page} 页原文区域`, loading: "lazy" }));
        appendBlock(b, blk);
        return;
      }
    }
    switch (b.type) {
      case "heading": {
        const lv = Math.min(4, b.level || 1);
        blk.append(el("h" + (lv + 1), {}, b.text));
        break;
      }
      case "para": {
        const div = el("div", {});
        renderMd(b.md, div);
        blk.append(div);
        break;
      }
      case "table": {
        if (b.caption) { const cap = el("figcaption"); renderMd(b.caption, cap); blk.append(cap); }
        const div = el("div", { class: "tbl-wrap" });
        if (b.html) renderMd(b.html, div);
        else renderMd(b.md, div);
        blk.append(div);
        break;
      }
      case "image": {
        const src = `/api/papers/${paper.id}/${b.src}`;
        const img = el("img", { src, alt: b.caption || "figure", loading: "lazy" });
        img.addEventListener("load", () => { /* natural size kept via max-width */ });
        img.addEventListener("click", () => lightbox(src, b.caption));
        const cap = b.caption ? el("figcaption") : null;
        if (cap) renderMd(b.caption, cap);
        blk.append(el("figure", {}, img, cap));
        break;
      }
      case "formula": {
        const div = el("div", { class: "formula-blk" });
        renderMd(`$$${b.latex}$$`, div);
        blk.append(div);
        break;
      }
      case "code": {
        if (b.caption) blk.append(el("h4", {}, b.caption));
        blk.append(el("pre", {}, el("code", {}, b.text)));
        blk.append(el("button", { class: "add-btn", title: "复制伪代码", style: { right: "142px" }, onclick: async () => { await navigator.clipboard.writeText(b.text); toast("已复制"); } }, "复制"));
        break;
      }
      default:
        return;
    }
    appendBlock(b, blk);
  });
  for (const b of blocks.filter((b) => b.wrapBefore)) {
    const fig = nodes.get(b.id), peer = nodes.get(b.wrapBefore);
    if (fig && peer && fig.parentElement === peer.parentElement) {
      fig.classList.add("wrap-figure");
      peer.parentElement.insertBefore(fig, peer);
    }
  }
}

async function addBlockToChat(b, blkEl, paper, meta) {
  const body = `[paper:${paper.id} version:${meta?.versionId || "legacy"}]\n` + blocksToContext([b]);
  if (b.type === "code" && b.algorithm && blkEl.querySelector(".algorithm-source")) {
    try {
      const response = await fetch(blkEl.querySelector(".algorithm-source").src);
      if (!response.ok) throw new Error("source image unavailable");
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (state.currentPaper?.id !== paper.id || !blkEl.isConnected || previewing) return;
      showAnnotPopup({ dataUrl, page: b.page, kind: "伪代码", label: `伪代码原文 (p.${b.page})`,
        body: "以附带的 PDF 原文截图为准。下方识别文本仅作检索辅助，符号、缩进和公式必须核对截图；无法查看图片时请明确说明。\n" + body });
    } catch { toast("伪代码原图加载失败，未加入对话，请重试"); }
    return;
  }
  if (b.type === "image") {
    const img = blkEl.querySelector("img");
    const chip = { kind: "block", tag: "图", label: `图 · ${b.caption || "figure"}${b.page ? ` (p.${b.page})` : ""}`, body: b.caption || "", dataUrl: null };
    const c = document.createElement("canvas");
    const im = new Image();
    im.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(im.width, im.height));
      c.width = im.width * scale; c.height = im.height * scale;
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      chip.dataUrl = c.toDataURL("image/png");
      renderChipsIf();
    };
    im.src = img.src;
    // open the annotation popup once the原图 is captured
    im.addEventListener("load", () => showAnnotPopup({ dataUrl: chip.dataUrl, page: b.page || null, kind: "图", label: b.caption || "figure" }));
    toast("已捕获原图 — 可选模板后提问或加入对话");
  } else if (b.type === "table") {
    showAnnotPopup({ dataUrl: null, page: b.page || null, kind: "表", label: `表格${b.page ? ` (p.${b.page})` : ""}`, body });
  } else if (b.type === "formula") {
    showAnnotPopup({ dataUrl: null, page: b.page || null, kind: "公式", label: `公式${b.page ? ` (p.${b.page})` : ""}`, body });
  } else {
    const text = body;
    if (text) {
      showAnnotPopup({ dataUrl: null, page: b.page || null, kind: "段落", label: "段落", body: text.slice(0, 6000) });
    }
  }
}

// ================= 框选批注弹窗 + 提示词模板 =================

let annotCtx = null; // {dataUrl, page, kind, label, body}

function buildAnnotText() {
  const tplName = $("#annot-tpl")?.value || "";
  const note = $("#annot-input")?.value.trim() || "";
  const tpl = getTemplates().find((t) => t.name === tplName);
  const parts = [];
  if (tpl) parts.push(tpl.content);
  if (note) parts.push(`用户批注：${note}`);
  return parts.join("\n");
}

function showAnnotPopup(ctx) {
  annotCtx = ctx;
  let pop = $("#annot-popup");
  if (!pop) {
    pop = el("div", { id: "annot-popup" });
    document.body.append(pop);
  }
  pop.replaceChildren(
    el("div", { class: "annot-title" }, `框选批注 · ${ctx.kind}${ctx.page ? ` (p.${ctx.page})` : ""}`),
    el("select", { id: "annot-tpl" }, el("option", { value: "" }, "— 无模板，直接问 —"), ...getTemplates().map((t) => el("option", { value: t.name }, "模板: " + t.name))),
    el("input", { id: "annot-input", type: "text", placeholder: "批注 / 追加要求（可选）" }),
    el("div", { class: "annot-actions" },
      el("button", { id: "annot-ask", class: "tool-btn primary", onclick: annotAsk }, "▶ 问 AI"),
      el("button", { id: "annot-add", class: "tool-btn", onclick: annotAddToChat }, "＋ 加入对话"),
      el("button", { id: "annot-tpl-edit", class: "icon-btn", title: "编辑模板", onclick: openTplEditor }, "⚙"),
      el("button", { class: "icon-btn", onclick: () => pop.remove() }, "✕")
    )
  );
  pop.style.display = "block";
  // place near top-right of reader
  const rr = $("#reader-pane").getBoundingClientRect();
  pop.style.top = Math.max(80, rr.top + 90) + "px";
  pop.style.left = Math.max(12, rr.right - 380) + "px";
}

async function annotAsk() {
  if (!annotCtx) return;
  const tplName = $("#annot-tpl")?.value || "";
  const note = $("#annot-input")?.value.trim() || "";
  const tpl = getTemplates().find((t) => t.name === tplName);
  const regionBody = annotCtx.body || "";
  const images = [];
  const displayBlocks = [];
  if (annotCtx.dataUrl) {
    const data = annotCtx.dataUrl.split(",")[1];
    if (data && data.length > 50) {
      images.push({ mimeType: "image/png", data });
      displayBlocks.push({ type: "image", dataUrl: annotCtx.dataUrl });
    }
  }
  let text;
  if (tpl) text = applyTemplate(tpl.content, regionBody || undefined, note || undefined);
  else {
    text = "请解释这个选区的内容。";
    if (regionBody) text += "\n\n--- 选区内容（" + annotCtx.kind + (annotCtx.page ? " 第" + annotCtx.page + "页" : "") + "） ---\n" + regionBody.slice(0, 6000);
  }
  const preview = (tplName ? "【" + tplName + "】" : "") + (note ? " " + note : "") + (images.length ? "\n[🖼 框选原图]" : "");
  annotCtx = null;
  $("#annot-popup")?.remove();
  await streamPrompt(text, images, preview.trim(), displayBlocks);
}

function annotAddToChat() {
  if (!annotCtx) return;
  const tplName = $("#annot-tpl")?.value || "";
  const note = $("#annot-input")?.value.trim() || "";
  const tpl = getTemplates().find((t) => t.name === tplName);
  const tplText = tpl ? applyTemplate(tpl.content, annotCtx.body || undefined, note || undefined) : "";
  if (annotCtx.dataUrl) {
    addChip({ kind: "image", tag: "批注", body: note || tplName || annotCtx.label, dataUrl: annotCtx.dataUrl, mimeType: "image/png", page: annotCtx.page });
  }
  const textBits = [];
  if (tpl) textBits.push(`【模板:${tpl.name}】${tplText}`);
  if (note) textBits.push(`【批注】${note}`);
  if (annotCtx.body) textBits.push(`【选区:${annotCtx.label}】\n${annotCtx.body.slice(0, 4000)}`);
  if (textBits.length) addChip({ kind: "text", tag: "批注", body: textBits.join("\n"), page: annotCtx.page });
  toast("已加入对话上下文");
  $("#annot-popup")?.remove();
}

function openTplEditor() {
  let back = document.getElementById("tpl-editor-backdrop");
  if (!back) {
    back = el("div", { id: "tpl-editor-backdrop" });
    document.body.append(back);
  }
  back.hidden = false;
  renderTplEditor(back);
}

function renderTplEditor(back) {
  const templates = getTemplates();
  const rows = el("div", {});
  templates.forEach((t, i) => {
    const name = el("input", { type: "text", value: t.name, style: { width: "120px", flex: "none" } });
    const content = el("textarea", { rows: "2", style: { flex: "1" } });
    content.value = t.content;
    name.addEventListener("change", () => (templates[i].name = name.value.trim() || t.name));
    content.addEventListener("change", () => (templates[i].content = content.value));
    rows.append(el("div", { class: "res-row", style: { alignItems: "flex-start" } }, name, content, el("button", { class: "icon-btn", onclick: () => { templates.splice(i, 1); saveTemplates(templates); renderTplEditor(back); } }, "✕")));
  });
  back.replaceChildren(
    el("div", { class: "modal" },
      el("div", { class: "modal-head" }, el("span", {}, "提示词模板（可编辑）"), el("button", { class: "icon-btn", onclick: () => (back.hidden = true) }, "✕")),
      el("div", { class: "modal-body" },
        el("p", { class: "res-note" }, "模板用于框选批注，支持占位符：{{选区}} = 框选/选中的内容；{{批注}} = 用户输入。发送时自动替换。修改立即保存到本地。"),
        rows,
        el("div", { style: { display: "flex", gap: "8px", marginTop: "10px" } },
          el("button", {
            class: "tool-btn", onclick: () => {
              templates.push({ name: "新模板", content: "" });
              saveTemplates(templates);
              renderTplEditor(back);
            }
          }, "＋ 添加模板"),
          el("button", {
            class: "tool-btn", onclick: () => {
              saveTemplates(templates);
              toast("模板已保存");
              back.hidden = true;
            }
          }, "保存")
        )
      )
    )
  );
}

// per-block translation via the self-hosted LibreTranslate service
async function translateBlock(blkEl) {
  let box = blkEl.querySelector(".trans-result");
  if (box) {
    box.remove();
    return;
  }
  const text = blkEl.querySelector(".md-body, p, .tbl-wrap, .formula-blk")?.innerText?.trim() || blkEl.innerText.trim();
  if (!text) return;
  box = el("div", { class: "trans-result" }, "翻译中…");
  blkEl.append(box);
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 4500), target: "zh" }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
    box.textContent = j.translated;
    box.append(el("div", { class: "trans-meta" }, "LibreTranslate · 点击「译」收起"));
  } catch (e) {
    box.textContent = "翻译失败: " + e.message;
  }
}

function renderChipsIf() { import("./app.js").then((m) => m.renderChips()); }

function lightbox(src, caption) {
  const back = el("div", {
    style: { position: "fixed", inset: "0", background: "rgba(4,6,14,.85)", zIndex: "150", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out", flexDirection: "column", gap: "10px" },
    onclick: () => back.remove(),
  });
  const img = el("img", { src, style: { maxWidth: "92vw", maxHeight: "86vh", borderRadius: "6px" } });
  back.append(img, caption ? el("div", { style: { color: "#aab" } }, caption) : null);
  document.body.append(back);
}

// ---------------- selection (both views) ----------------
function selectedSourceText() {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return "";
  const fragment = selection.getRangeAt(0).cloneContents();
  for (const math of fragment.querySelectorAll(".katex")) {
    const latex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex) math.replaceWith(document.createTextNode("$" + latex + "$"));
  }
  for (const button of fragment.querySelectorAll(".add-btn")) button.remove();
  for (const block of fragment.querySelectorAll("p,pre,div.blk,h2,h3,h4,tr")) block.append(document.createTextNode("\n"));
  return fragment.textContent.trim();
}
function initSelection() {
  const popup = $("#sel-popup");
  $("#parsed-content").addEventListener("copy", (event) => {
    const text = selectedSourceText();
    if (text && event.clipboardData) { event.clipboardData.setData("text/plain", text); event.preventDefault(); }
  });
  document.addEventListener("mouseup", (e) => {
    if (e.target?.closest?.("#sel-popup")) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 2 || sel.isCollapsed) {
        popup.hidden = true;
        return;
      }
      // must be inside reader
      const anchor = sel.anchorNode?.parentElement || sel.anchorNode;
      if (!anchor?.closest?.("#reader-body")) {
        popup.hidden = true;
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      popup.style.left = Math.min(window.innerWidth - 130, rect.left + rect.width / 2 - 55) + "px";
      popup.style.top = rect.top + "px";
      popup.hidden = false;
      popup.dataset.page = anchor.closest(".page-el")?.dataset.page || anchor.closest(".blk")?.dataset.page || "";
    }, 10);
  });
  $("#btn-sel-add").addEventListener("click", () => {
    if (previewing) return toast("请先采用该版本，再加入对话", true);
    const text = selectedSourceText();
    if (text) {
      const page = parseInt(popup.dataset.page) || null;
      addChip({ kind: "text", tag: "选中", body: text.slice(0, 8000), page });
      toast("选中文本已加入对话");
    }
    popup.hidden = true;
  });
}

// ---------------- pdf view ----------------
async function loadPdf(paper) {
  if (!paper.pdfPath) {
    $("#pdf-pages").replaceChildren(el("div", { class: "empty-hint" }, "该论文没有关联 PDF 文件"));
    return;
  }
  const seq = ++renderSeq;
  try {
    const url = `/api/papers/${paper.id}/pdf`;
    pdfDoc = await pdfjsLib.getDocument({ url }).promise;
    const container = $("#pdf-pages");
    container.replaceChildren();
    for (let pno = 1; pno <= pdfDoc.numPages; pno++) {
      if (seq !== renderSeq) return; // paper switched
      await renderPage(pno);
    }
  } catch (e) {
    $("#pdf-pages").replaceChildren(el("div", { class: "empty-hint" }, "PDF 加载失败: " + e.message));
  }
}

async function renderPage(pno) {
  const page = await pdfDoc.getPage(pno);
  const holder = $("#pdf-pages");
  let pageEl = holder.querySelector(`.page-el[data-page="${pno}"]`);
  if (!pageEl) {
    pageEl = el("div", { class: "page-el", "data-page": pno });
    pageEl.append(el("div", { class: "page-num-label" }, `p. ${pno}`));
    const canvas = el("canvas");
    const textDiv = el("div", { class: "textLayer" });
    pageEl.append(canvas, textDiv);
    holder.append(pageEl);
  }
  const canvas = pageEl.querySelector("canvas");
  const textDiv = pageEl.querySelector(".textLayer");
  const cssWidth = Math.min(900, holder.clientWidth - 48);
  const scale = cssWidth / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  pageEl.style.width = viewport.width + "px";
  pageEl.style.height = viewport.height + "px";

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;

  textDiv.replaceChildren();
  const tc = await page.getTextContent();
  const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: textDiv, viewport });
  await tl.render();
  textDiv.style.width = textDiv.style.height = "";
}

// box-select screenshots
function initBoxSelect() {
  const btn = $("#btn-boxselect");
  btn.addEventListener("click", () => {
    boxMode = !boxMode;
    btn.classList.toggle("active", boxMode);
    toast(boxMode ? "框选模式：在 PDF 页面上拖拽截图" : "框选模式关闭");
  });

  const holder = $("#pdf-pages");
  let dragging = null;
  holder.addEventListener("mousedown", (e) => {
    if (!boxMode) return;
    const pageEl = e.target.closest(".page-el");
    if (!pageEl) return;
    e.preventDefault();
    const rect = pageEl.getBoundingClientRect();
    dragging = { pageEl, x0: e.clientX - rect.left, y0: e.clientY - rect.top, box: null };
    const box = el("div", { class: "box-overlay" });
    pageEl.append(box);
    dragging.box = box;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = dragging.pageEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const b = dragging.box;
    b.style.left = Math.min(dragging.x0, x) + "px";
    b.style.top = Math.min(dragging.y0, y) + "px";
    b.style.width = Math.abs(x - dragging.x0) + "px";
    b.style.height = Math.abs(y - dragging.y0) + "px";
    dragging.cur = { x, y };
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    const { pageEl, box, x0, y0, cur } = dragging;
    dragging = null;
    box.remove();
    if (!cur) return; // click without drag
    const w = Math.abs(cur.x - x0);
    const h = Math.abs(cur.y - y0);
    if (w < 12 || h < 12) return;
    const pageNum = parseInt(pageEl.dataset.page);
    const leftCss = Math.min(x0, cur.x), topCss = Math.min(y0, cur.y);
    // crop from canvas at device pixels
    const canvas = pageEl.querySelector("canvas");
    const dpr = canvas.width / (parseFloat(canvas.style.width) || canvas.offsetWidth || 1);
    const sx = Math.max(0, leftCss * dpr), sy = Math.max(0, topCss * dpr);
    const sw = Math.min(w * dpr, canvas.width - sx), sh = Math.min(h * dpr, canvas.height - sy);
    if (sw < 4 || sh < 4) return;
    const out = document.createElement("canvas");
    out.width = Math.round(sw); out.height = Math.round(sh);
    out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL("image/png");
    if (!dataUrl || dataUrl.length < 100) {
      toast("截图失败，请重试", true);
      return;
    }
    showAnnotPopup({ dataUrl, page: pageNum, kind: "框选", label: `PDF 第${pageNum}页区域` });
  });
}

// ---------------- parse panel ----------------
function initParsePanel() {
  $("#btn-parse").addEventListener("click", async () => {
    const p = state.currentPaper;
    if (!p) return toast("请先选择论文", true);
    $("#parse-panel").hidden = false;
    $("#parse-title").textContent = `解析《${(p.title || "").slice(0, 40)}》`;
    const st = p.parse?.status;
    if (st !== "running") $("#parse-log").textContent = "";
    await refreshVersions(p.id);
  });
  $("#btn-parse-close").addEventListener("click", () => {
    $("#parse-panel").hidden = true;
    if (previewing && state.currentPaper) loadParsed(state.currentPaper);
  });
  $("#btn-parse-start").addEventListener("click", async () => {
    const p = state.currentPaper;
    if (!p) return toast("请先选择论文", true);
    try {
      const r = await api.parse(p.id, $("#parse-engine").value);
      currentJobId = r.jobId;
      $("#parse-log").textContent = `引擎: ${r.engine}\n`;
      startJobPoll(p.id);
    } catch (e) {
      $("#parse-log").textContent += "✕ " + e.message + "\n";
    }
  });
  $("#parse-version").addEventListener("change", updateVersionButtons);
  $("#btn-version-preview").addEventListener("click", async () => {
    const p = state.currentPaper, id = $("#parse-version").value;
    if (!p || !id) return;
    try {
      const doc = await api.parseVersion(p.id, id);
      if (state.currentPaper?.id !== p.id) return;
      previewing = true;
      renderBlocks(p, Array.isArray(doc) ? doc : doc.blocks, p, doc);
      $("#reader-status").textContent = "预览版本 · Pi 仍读取当前版本";
    } catch (e) { toast(e.message, true); }
  });
  $("#btn-version-activate").addEventListener("click", async () => {
    const p = state.currentPaper, id = $("#parse-version").value;
    if (!p || !id) return;
    try { await api.activateParseVersion(p.id, id); await loadParsed(p); await refreshVersions(p.id); toast("已切换解析版本"); }
    catch (e) { toast(e.message, true); }
  });
  $("#btn-version-replay").addEventListener("click", async () => {
    const p = state.currentPaper, id = $("#parse-version").value;
    if (!p || !id) return;
    try { const job = await api.parse(p.id, "hybrid", id); currentJobId = job.jobId; startJobPoll(p.id); }
    catch (e) { toast(e.message, true); }
  });
  $("#btn-version-compare").addEventListener("click", compareVersion);
}

async function refreshVersions(paperId) {
  try {
    const res = await api.parseVersions(paperId);
    if (state.currentPaper?.id !== paperId) return;
    parseVersions = res.versions;
    $("#parse-version").replaceChildren(...parseVersions.map((v) => el("option", { value: v.id }, `${v.active ? "当前 · " : ""}${new Date(v.createdAt).toLocaleString()} · ${v.engine} · ${{ready:"可用",legacy:"旧版快照",review:"待检查",error:"失败",running:"解析中"}[v.status] || v.status}`)));
    updateVersionButtons();
  } catch (e) { toast(e.message, true); }
}
function updateVersionButtons() {
  const v = parseVersions.find((v) => v.id === $("#parse-version").value);
  $("#btn-version-preview").disabled = !v || !["ready", "legacy", "review"].includes(v.status);
  $("#btn-version-compare").disabled = $("#btn-version-preview").disabled;
  $("#btn-version-activate").disabled = !v || v.active || !["ready", "legacy"].includes(v.status);
  $("#btn-version-replay").disabled = !v?.replayable;
  const errors = v?.quality?.errors || [], warnings = v?.quality?.warnings || [];
  $("#parse-quality").replaceChildren(el("span", {}, v ? v.quality ? `${v.blocks || 0} 块 · 结构错误 ${errors.length} · 待核对 ${warnings.length}` : "旧版或未完成版本 · 尚未校验" : "暂无历史版本"));
  if (errors.length || warnings.length) $("#parse-quality").append(el("details", {}, el("summary", {}, "查看质量报告"), el("pre", {}, [...errors, ...warnings].map((x) => `p.${x.page || "?"} ${x.blockId || ""}: ${x.message || x.code}`).join("\n"))));
}
async function compareVersion() {
  const p = state.currentPaper, id = $("#parse-version").value;
  if (!p || !id) return;
  try {
    const [current, candidate] = await Promise.all([fetch(`/api/papers/${p.id}/blocks`).then((r) => r.json()), api.parseVersion(p.id, id)]);
    const selected = Array.isArray(candidate) ? candidate : candidate.blocks;
    const pageNumbers = [...new Set([...(current.blocks || []), ...selected].map((b) => b.page || 0))].sort((a, b) => a - b);
    const picker = el("select", { "aria-label": "对比页码" }, ...pageNumbers.map((n) => el("option", { value: n }, n ? `第 ${n} 页` : "未定位内容")));
    const left = el("pre"), right = el("pre");
    const draw = () => {
      const text = (bs) => bs.filter((b) => (b.page || 0) === Number(picker.value)).map((b) => `[${b.type}] ${b.text || b.md || b.latex || b.caption || b.html || ""}`).join("\n\n");
      left.textContent = text(current.blocks || []); right.textContent = text(selected);
    };
    picker.addEventListener("change", draw); draw();
    const dialog = el("dialog", { class: "parse-compare" });
    dialog.append(el("div", { class: "parse-compare-head" }, el("strong", {}, "解析版本对比"), picker, el("button", { class: "tool-btn", onclick: () => dialog.close() }, "关闭")), el("div", { class: "parse-compare-columns" }, el("section", {}, el("h3", {}, "当前版本"), left), el("section", {}, el("h3", {}, "选中版本"), right)));
    dialog.addEventListener("close", () => dialog.remove());
    window.document.body.append(dialog); dialog.showModal();
  } catch (e) { toast(e.message, true); }
}

function startJobPoll(paperId) {
  stopJobPoll();
  setBusyStatus("解析中…");
  jobTimer = setInterval(async () => {
    try {
      const j = await api.job(currentJobId);
      $("#parse-log").textContent = `引擎: ${j.engine}\n` + j.log.join("\n");
      $("#parse-log").scrollTop = $("#parse-log").scrollHeight;
      if (j.status === "done") {
        stopJobPoll();
        setBusyStatus(null);
        toast(j.activated ? "首个解析版本已采用" : "新版本已保存，可预览后采用");
        await reloadPaperQuiet(paperId);
        await refreshVersions(paperId);
      } else if (j.status === "review") {
        stopJobPoll(); setBusyStatus(null);
        toast("新版本需检查，仍使用原解析结果", true);
        await refreshVersions(paperId);
      } else if (j.status === "error") {
        stopJobPoll();
        setBusyStatus(null);
        toast("解析失败: " + j.error, true);
        await refreshVersions(paperId);
      }
    } catch {}
  }, 1200);
}

function stopJobPoll() {
  clearInterval(jobTimer);
  jobTimer = null;
}

function setBusyStatus(txt) {
  const chip = $("#reader-status");
  if (txt) chip.dataset.busy = "1";
  else delete chip.dataset.busy;
  if (txt) chip.textContent = txt;
  else if (state.currentPaper) updateParseStatus(state.currentPaper.parse?.status || "none");
}

async function reloadPaperQuiet(paperId) {
  if (state.currentPaper?.id !== paperId) return;
  const { loadPapers, renderPapers } = await import("./sidebar.js");
  await loadPapers();
  state.currentPaper = state.papers.find((p) => p.id === paperId) || state.currentPaper;
  renderPapers();
  const p = state.currentPaper;
  const res = await fetch(`/api/papers/${p.id}/blocks`).then((r) => r.json());
  updateParseStatus(res.status, res.engine, res.error);
  previewing = false;
  if (res.blocks?.length) renderBlocks(p, res.blocks, res.paper, res);
}

// ---------------- init ----------------
export function initReader() {
  $("#tab-parsed").addEventListener("click", () => switchTab("parsed"));
  $("#tab-pdf").addEventListener("click", () => switchTab("pdf"));
  initSelection();
  initBoxSelect();
  initParsePanel();
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (pdfDoc && !$("#pdf-view").hidden) {
        renderSeq++;
        (async () => { for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i); })();
      }
    }, 300);
  });
}

function switchTab(which) {
  const isParsed = which === "parsed";
  $("#tab-parsed").classList.toggle("active", isParsed);
  $("#tab-pdf").classList.toggle("active", !isParsed);
  $("#parsed-view").hidden = !isParsed;
  $("#pdf-view").hidden = isParsed;
  if (!isParsed && state.currentPaper && !pdfDoc) loadPdf(state.currentPaper);
}

export { loadPdf };
