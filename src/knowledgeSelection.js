import { el, toast } from "./platform/dom.js";
import { requestJson } from "./platform/http.js";
import { state } from "./shell/state.js";
import { addChip } from "./features/chat/attachments.js";
import { renderMd } from "./platform/markdown.js";

async function saveKnowledgeEvidence({ text, source }) {
  if (text.length > 8000) return toast("请选择不超过 8000 字的文本", true);
  if (!state.projectId) return toast("先在顶部选择项目，才能保存证据卡", true);
  try {
    await requestJson(
      "/api/research/projects/" + encodeURIComponent(state.projectId) + "/evidence",
      {
        method: "POST",
        body: {
          type: "fact",
          content: text,
          source: {
            kind: "retrieval",
            resourceId: source.resourceId || "",
            versionId: source.versionId || "",
            generationId: source.generationId || "",
            recordId: source.recordId || "",
            pages: source.pages || [],
            sectionPath: source.sectionPath || [],
            label: source.title || "知识库选区",
          },
        },
      },
    );
    toast("已保存为证据卡，可在「研究」面板查看");
  } catch (e) {
    toast("保存证据失败: " + e.message, true);
  }
}

export function selectedKnowledgeText(range) {
  const complete = range.cloneRange();
  const mathAt = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(".katex");
  const startMath = mathAt(range.startContainer), endMath = mathAt(range.endContainer);
  if (startMath) complete.setStartBefore(startMath);
  if (endMath) complete.setEndAfter(endMath);
  const fragment = complete.cloneContents();
  for (const math of fragment.querySelectorAll(".katex")) {
    const latex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex) math.replaceWith(document.createTextNode(`$${latex}$`));
  }
  for (const hidden of fragment.querySelectorAll(".katex-mathml,button")) hidden.remove();
  for (const block of fragment.querySelectorAll("p,li,pre,blockquote")) block.append(document.createTextNode("\n"));
  return fragment.textContent.trim();
}

export function createKnowledgeSelection(root) {
  let popup, selected, disposed = false;
  const sources = new WeakMap(), panels = new Map();
  const hide = () => { popup?.remove(); popup = null; };
  const target = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(".knowledge-block-source");
  function capture(event) {
    if (disposed) return;
    if (event?.target?.closest?.(".knowledge-translation,[role=link],button")) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) { hide(); return; }
    const range = selection.getRangeAt(0), start = target(range.startContainer), end = target(range.endContainer);
    const a = sources.get(start), b = sources.get(end);
    if (!a || !b || a.recordId !== b.recordId || a.generationId !== b.generationId || !root.contains(end)) { hide(); return; }
    const text = selectedKnowledgeText(range);
    if (text.length < 2) { hide(); return; }
    selected = { text, source: b, block: end.parentElement };
    hide();
    popup = el("div", { class: "knowledge-selection-menu", role: "toolbar", "aria-label": "选中文本操作" });
    popup.addEventListener("pointerdown", event => event.preventDefault());
    if (/[A-Za-z]{2}/.test(text)) popup.append(el("button", { type: "button", onclick: () => {
      const choice = selected; hide(); void translate(choice);
    } }, "翻译"));
    popup.append(el("button", { type: "button", onclick: () => {
      const { text, source } = selected;
      if (text.length > 8000) return toast("请选择不超过 8000 字的文本", true);
      addChip({ kind: "text", tag: `${source.citationId || "知识库"} · 引用`, page: source.pages?.[0],
        resourceId: source.resourceId, generationId: source.generationId,
        body: `【知识库选区 · ${source.title}\n${source.sectionPath?.join(" > ") || "文档根节点"} · 页 ${source.pages?.join(", ") || "—"} · 版本 ${source.versionId}】\n${text}` });
      toast("已添加进对话，发送下一条消息时带上这段引用"); hide();
    } }, "添加进对话"));
    popup.append(el("button", { type: "button", onclick: () => {
      const choice = selected; hide(); void saveKnowledgeEvidence(choice);
    } }, "保存为证据"));
    document.body.append(popup);
    const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
    const rect = rects.at(-1) || range.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, rect.left))}px`;
    popup.style.top = `${Math.max(8, Math.min(window.innerHeight - popup.offsetHeight - 8, rect.bottom + 7))}px`;
  }
  async function translate(choice) {
    if (!choice || !root.contains(choice.block)) return;
    if (choice.text.length > 8000) return toast("请选择不超过 8000 字的文本", true);
    let entry = panels.get(choice.block);
    if (!entry) {
      const panel = el("section", { class: "knowledge-translation", "aria-label": "选区中文译文", "aria-expanded": "false" });
      const inner = el("div", { class: "knowledge-translation-inner" });
      const heading = el("strong", {}, "中文译文");
      const meta = el("small", { class: "res-note" }, "GLM 模型翻译");
      const content = el("div", { class: "knowledge-translation-content", role: "status", "aria-live": "polite" });
      const close = el("button", { type: "button", class: "tool-btn", "aria-label": "收起译文", onclick: () => {
        entry.controller?.abort(); panel.classList.remove("is-open"); panel.setAttribute("aria-expanded", "false");
      } }, "收起");
      inner.append(el("div", { class: "knowledge-translation-header" }, heading, meta, close), content);
      panel.append(inner); choice.block.append(panel);
      entry = { panel, content, meta, sequence: 0 }; panels.set(choice.block, entry);
    }
    entry.controller?.abort();
    const ticket = ++entry.sequence;
    entry.panel.classList.add("is-open"); entry.panel.setAttribute("aria-expanded", "true");
    // The initial collapsed frame lets CSS unfold the panel from the text edge.
    if (!entry.text) {
      entry.panel.classList.remove("is-open");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!disposed && root.contains(choice.block) && entry.panel.getAttribute("aria-expanded") === "true") entry.panel.classList.add("is-open");
      }));
    }
    if (entry.text === choice.text && entry.translated) return;
    entry.text = choice.text; entry.translated = null;
    entry.content.textContent = "模型正在翻译选中文本…";
    entry.meta.textContent = "选区模型翻译 · 默认 GLM";
    entry.controller = new AbortController();
    try {
      const response = await fetch("/api/rag/translate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: choice.source.resourceId, generationId: choice.source.generationId,
          recordId: choice.source.recordId, text: choice.text }), signal: entry.controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "翻译失败");
      if (disposed || ticket !== entry.sequence || !root.contains(choice.block)) return;
      entry.translated = data.translated;
      renderMd(data.translated, entry.content);
      entry.meta.textContent = `${data.model?.id || "GLM"} · 仅翻译选区${data.cached ? " · 已保存译文" : ""}`;
    } catch (error) {
      if (disposed || ticket !== entry.sequence || !root.contains(choice.block)) return;
      entry.content.replaceChildren(el("p", {}, error.name === "AbortError" ? "翻译已停止" : `翻译失败：${error.message}`),
        el("button", { class: "tool-btn", type: "button", onclick: () => void translate(choice) }, "重试翻译"));
    }
  }
  const onSelectionChange = () => { if (window.getSelection()?.isCollapsed) hide(); };
  const onKey = event => { if (event.key === "Escape") hide(); else if (event.shiftKey || event.key === "Shift") capture(); };
  const onOutside = event => { if (!popup?.contains(event.target) && !root.contains(event.target)) hide(); };
  root.addEventListener("pointerup", capture);
  root.addEventListener("keyup", onKey);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("pointerdown", onOutside);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  return {
    register(source, metadata) { sources.set(source, metadata); },
    reset() { hide(); selected = null; for (const entry of panels.values()) entry.controller?.abort(); panels.clear(); },
    dispose() {
      disposed = true; this.reset();
      root.removeEventListener("pointerup", capture); root.removeEventListener("keyup", onKey);
      document.removeEventListener("selectionchange", onSelectionChange); document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide);
    },
  };
}
