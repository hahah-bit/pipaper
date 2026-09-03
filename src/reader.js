import * as pdfjsLib from "pdfjs-dist";
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
  updateParseStatus(res.status, res.engine, res.error);
  if (res.blocks?.length) {
    renderBlocks(p, res.blocks, res.paper);
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
function renderBlocks(paper, blocks, meta) {
  $("#parsed-empty").hidden = true;
  const wrap = $("#parsed-content");
  wrap.replaceChildren();

  wrap.append(el("h1", { class: "doc-title" }, paper.title || "(无标题)"));
  const metaBits = [(paper.creators || []).slice(0, 4).join(", "), paper.year, paper.publication, paper.doi ? `DOI: ${paper.doi}` : "", `引擎: ${meta?.parse?.engine || "?"}`].filter(Boolean);
  wrap.append(el("div", { class: "doc-meta" }, metaBits.join(" · ")));

  let lastPage = 0;
  blocks.forEach((b, idx) => {
    if (b.page && b.page !== lastPage && b.page > lastPage + 0) {
      wrap.append(el("div", { class: "page-mark" }, `— 第 ${b.page} 页 —`));
      lastPage = b.page;
    }
    const blk = el("div", { class: "blk", "data-idx": idx, ...(b.page ? { "data-page": b.page } : {}) });
    const addBtn = el("button", {
      class: "add-btn",
      title: "把该部分加入对话",
      style: { right: "-6px" },
      onclick: (e) => { e.stopPropagation(); addBlockToChat(b, blk, paper); },
    }, "＋ 对话");
    const transBtn = el("button", {
      class: "add-btn",
      title: "翻译该段（LibreTranslate）",
      style: { right: "58px" },
      onclick: (e) => { e.stopPropagation(); translateBlock(blk); },
    }, "译");
    blk.append(addBtn, transBtn);
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
        const div = el("div", { class: "tbl-wrap" });
        if (b.html) div.innerHTML = safeHtml(b.html);
        else renderMd(b.md, div);
        blk.append(div);
        break;
      }
      case "image": {
        const src = `/api/papers/${paper.id}/${b.src}`;
        const img = el("img", { src, alt: b.caption || "figure", loading: "lazy" });
        img.addEventListener("load", () => { /* natural size kept via max-width */ });
        img.addEventListener("click", () => lightbox(src, b.caption));
        blk.append(el("figure", {}, img, b.caption ? el("figcaption", {}, b.caption) : null));
        break;
      }
      case "formula": {
        const div = el("div", { class: "formula-blk" });
        renderMd(`$$${b.latex}$$`, div);
        blk.append(div);
        break;
      }
      case "code": {
        const div = el("div");
        renderMd("```" + (b.lang || "") + "\n" + b.text + "\n```", div);
        blk.append(div);
        break;
      }
      default:
        return;
    }
    wrap.append(blk);
  });

  // headings clickable for outline jump? keep simple
}

function safeHtml(html) {
  const t = document.createElement("div");
  t.innerHTML = html;
  return t.innerHTML;
}

function addBlockToChat(b, blkEl, paper) {
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
    showAnnotPopup({ dataUrl: null, page: b.page || null, kind: "表", label: `表格${b.page ? ` (p.${b.page})` : ""}`, body: b.md || stripTags(b.html) });
  } else if (b.type === "formula") {
    showAnnotPopup({ dataUrl: null, page: b.page || null, kind: "公式", label: `公式${b.page ? ` (p.${b.page})` : ""}`, body: `$$${b.latex}$$` });
  } else {
    const text = blkEl.innerText.trim();
    if (text) {
      showAnnotPopup({ dataUrl: null, page: b.page || null, kind: "段落", label: "段落", body: text.slice(0, 6000) });
    }
  }
}

function stripTags(html) {
  const d = el("div", { html });
  return d.textContent || "";
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
function initSelection() {
  const popup = $("#sel-popup");
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
    const sel = window.getSelection();
    const text = sel?.toString().trim();
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
  $("#btn-parse").addEventListener("click", () => {
    const p = state.currentPaper;
    if (!p) return toast("请先选择论文", true);
    $("#parse-panel").hidden = false;
    $("#parse-title").textContent = `解析《${(p.title || "").slice(0, 40)}》`;
    const st = p.parse?.status;
    if (st !== "running") $("#parse-log").textContent = "";
  });
  $("#btn-parse-close").addEventListener("click", () => {
    $("#parse-panel").hidden = true;
    stopJobPoll();
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
        toast("解析完成 ✓");
        await reloadPaperQuiet(paperId);
      } else if (j.status === "error") {
        stopJobPoll();
        setBusyStatus(null);
        toast("解析失败: " + j.error, true);
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
  const { loadPapers, renderPapers } = await import("./sidebar.js");
  await loadPapers();
  state.currentPaper = state.papers.find((p) => p.id === paperId) || state.currentPaper;
  renderPapers();
  const p = state.currentPaper;
  const res = await fetch(`/api/papers/${p.id}/blocks`).then((r) => r.json());
  updateParseStatus(res.status, res.engine, res.error);
  if (res.blocks?.length) renderBlocks(p, res.blocks, res.paper);
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
