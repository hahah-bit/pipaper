import { node, markdown, button, request } from "./ui.js";
import { createStudyNotes } from "./notes.js";
import { createPdfReader } from "./pdf-reader.js";

export function createStudyReader({ root, getTask, onUI, onQuote, run, stop }) {
  let doc, pageNumber = getTask().ui.page || 1, view = getTask().ui.tab || "parsed";
  if (view === "bilingual") view = "parsed";
  let selected = "", selectedText = "", selectedIds = [], selectedPage = pageNumber, disposed = false;
  const notes = createStudyNotes({ getTask });
  const translations = new Map(), blocks = new Map();
  const body = node("div", { class: "study-reader-body", tabindex: 0 });
  const surface = node("div", { class: "study-reader-surface" }, body);
  const toolbar = node("div", { class: "study-reader-toolbar" });
  const tabs = node("div", { class: "study-tabs", role: "tablist" });
  const pdf = createPdfReader({ body, url: `/api/papers/${getTask().paperId}/pdf`,
    initialPosition: { page: pageNumber, offset: getTask().ui.pdfOffset || 0 },
    onPosition: ({ page, offset }) => { pageNumber = page; onUI({ page, pdfOffset: offset }); } });
  surface.append(pdf.navigation);
  const allTranslate = button("整篇翻译 / 继续", () => run("translate", {}));
  toolbar.append(allTranslate, button("暂停翻译", stop), button("下载 PDF ↗", () => window.open(`/api/papers/${getTask().paperId}/pdf`, "_blank", "noopener")));
  const selectionLabel = node("span", {}, "已选择原文");
  const translateSelection = button("翻译所选", () => translate());
  const translatedNote = button("翻译后加入笔记", async () => { const ids = [...selectedIds]; await translate(ids); await notes.append({ blockIds: ids, translated: true }); });
  const selection = node("div", { class: "study-selection", hidden: true }, selectionLabel,
    button("发给引导", () => onQuote("guide", selected)), button("发给问答", () => onQuote("chat", selected)),
    button("加入笔记", () => notes.append({ blockIds: selectedIds, text: selectedText, page: selectedPage })), translateSelection, translatedNote);
  selection.addEventListener("mousedown", event => event.preventDefault());
  body.addEventListener("mouseup", () => {
    const sel = window.getSelection();
    if (sel?.anchorNode && body.contains(sel.anchorNode) && sel.toString().trim()) {
      const el = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
      if (el.closest(".study-translated")) return;
      const block = el.closest("[data-block-id]"), range = sel.getRangeAt(0);
      const sourcePage = Number(el.closest("[data-page]")?.dataset.page) || pageNumber;
      selectedIds = view === "parsed" ? [...blocks].filter(([, wrap]) => range.intersectsNode(wrap.querySelector(".study-original"))).map(([id]) => id) : [];
      selectedText = sel.toString().trim();
      selectedPage = sourcePage;
      selected = `【原文 · p.${sourcePage}${block ? " · " + block.dataset.blockId : ""}】\n${selectedText}`;
      showSelection();
    }
  });
  let timer;
  body.addEventListener("scroll", () => {
    if (view !== "parsed") return;
    clearTimeout(timer); timer = setTimeout(() => { if (view === "parsed") onUI({ readerScroll: body.scrollTop }); }, 250);
  });
  for (const [key, label] of [["pdf", "PDF 原文"], ["parsed", "结构化"], ["notes", "阅读笔记"]]) {
    const tab = button(label, () => switchView(key)); tab.dataset.tab = key; tab.setAttribute("role", "tab"); tabs.append(tab);
  }
  root.append(tabs, toolbar, selection, surface, notes.root);
  function showSelection() {
    selection.hidden = view === "notes" || !(selected || selectedIds.length);
    selectionLabel.textContent = selectedIds.length ? `已选 ${selectedIds.length} 个原文块` : "已选择文字";
    translateSelection.disabled = translatedNote.disabled = !selectedIds.length;
    for (const [id, box] of translations) box.hidden = view !== "parsed" || !selectedIds.includes(id);
    for (const [id, wrap] of blocks) wrap.classList.toggle("selected", selectedIds.includes(id));
  }
  function selectBlock(block) {
    selectedIds = [block.id]; selectedText = "";
    selected = `【论文原文 · p.${block.page} · ${block.id}】\n${block.md || block.html || block.text || block.latex || block.caption || ""}`;
    showSelection();
  }
  async function translate(ids = [...selectedIds]) {
    if (!ids.length) throw new Error("请在结构化视图中选择需要翻译的段落、图注或表格");
    await run("translate", { blockIds: ids });
    for (const id of ids) translationContent(id, getTask().translations[id]);
  }
  function assetURL(src) {
    const relative = String(src || "").replace(/^file\//, "");
    return `/api/papers/${getTask().paperId}/file/${relative.split("/").map(encodeURIComponent).join("/")}`;
  }
  function blockBody(block) {
    if (block.type === "image") return node("figure", {}, node("img", { src: assetURL(block.src), alt: block.caption || "论文插图", loading: "lazy" }), node("figcaption", {}, block.caption || ""));
    if (block.type === "heading") return node("h3", {}, block.text || block.md || "");
    if (block.type === "formula") return markdown(`$$\n${block.latex || ""}\n$$`);
    if (block.type === "code") return node("pre", {}, node("code", {}, block.text || ""));
    return markdown(block.html || block.md || block.text || block.caption || "");
  }
  function translationContent(id, translation) {
    const box = translations.get(id); if (!box) return;
    box.replaceChildren(node("small", {}, "中文译文"));
    if (translation?.error) box.append(node("p", { class: "study-error" }, translation.error), button("重试此块", () => run("translate", { blockId: id, retry: true })));
    else if (translation?.translated != null) box.append(markdown(translation.translated), node("small", { class: "study-muted" }, translation.preserved ? "公式／代码保持原样" : `${translation.model?.id || "模型翻译"} · 已校验结构与数值`), (translation.warnings || []).map(w => node("p", { class: "study-warning" }, w)));
    else box.append(node("p", { class: "study-muted" }, "尚未翻译"), button("翻译此段", () => run("translate", { blockId: id })));
  }
  function renderBlocks() {
    body.replaceChildren(); blocks.clear(); translations.clear();
    if (!doc) { body.append(node("div", { class: "study-empty" }, "请在中间完成论文解析，随后开始阅读。")); return; }
    for (const b of doc.blocks) {
      const wrap = node("article", { class: "study-block", "data-block-id": b.id, "data-page": b.page });
      const original = node("div", { class: "study-original" }, blockBody(b));
      const translated = node("div", { class: "study-translated", hidden: !selectedIds.includes(b.id) });
      const quote = `【论文原文 · p.${b.page} · ${b.id}】\n${b.md || b.html || b.text || b.latex || b.caption || ""}`;
      wrap.append(node("div", { class: "study-block-tools" }, button(`p.${b.page}`, async () => { await switchView("pdf"); return pdf.goTo(b.page); }),
        button("选中", () => selectBlock(b)),
        button("译", () => { selectBlock(b); return translate([b.id]); }),
        button("＋笔记", () => notes.append({ blockIds: [b.id] })),
        button("＋引导", () => onQuote("guide", quote)), button("＋问答", () => onQuote("chat", quote))), original, translated);
      original.addEventListener("click", event => { if (!window.getSelection()?.toString().trim() && !event.target.closest("a")) selectBlock(b); });
      blocks.set(b.id, wrap); translations.set(b.id, translated); translationContent(b.id, getTask().translations[b.id]); body.append(wrap);
    }
    showSelection();
  }
  async function switchView(next) {
    if (disposed) return;
    if (view === "pdf") pdf.hide();
    if (view === "parsed" && body.children.length) onUI({ readerScroll: body.scrollTop });
    clearTimeout(timer);
    if (view !== next) { selected = selectedText = ""; selectedIds = []; }
    view = next; onUI({ tab: next });
    for (const tab of tabs.children) { tab.classList.toggle("active", tab.dataset.tab === view); tab.setAttribute("aria-selected", String(tab.dataset.tab === view)); }
    surface.hidden = next === "notes"; notes.root.hidden = next !== "notes";
    toolbar.hidden = next !== "parsed";
    showSelection();
    if (next === "pdf") await pdf.show();
    else if (next === "parsed") { renderBlocks(); body.scrollTop = getTask().ui.readerScroll || 0; }
  }
  return {
    async load() {
      if (getTask().versionId) doc = await request(`/api/studies/${getTask().id}/document`);
      await switchView(view);
    },
    async focusBlock(id) {
      if (!blocks.has(id) || view !== "parsed") await switchView("parsed");
      const source = doc?.blocks.find(b => b.id === id); if (source) selectBlock(source);
      const block = blocks.get(id); block?.scrollIntoView({ block: "center", behavior: "smooth" }); block?.classList.add("study-highlight"); setTimeout(() => block?.classList.remove("study-highlight"), 2000);
    },
    updateTranslation(id, translation) { translationContent(id, translation); showSelection(); },
    flushNotes: notes.flush,
    close() { if (view === "parsed") onUI({ readerScroll: body.scrollTop }); disposed = true; clearTimeout(timer); notes.close(); pdf.close(); },
  };
}
