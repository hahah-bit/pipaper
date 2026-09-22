import * as pdfjs from "pdfjs-dist";
import { node, button } from "./ui.js";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

// Keep page geometry mounted while rendering only the visible neighbourhood.
// This preserves continuous scrolling without retaining a canvas for every page.
export function createPdfReader({ body, url, initialPosition, onPosition }) {
  let pdf, loading, preparation, pages = [], active = false, disposed = false, width = 0, showRevision = 0;
  let position = initialPosition, current = initialPosition.page || 1;
  let jobs = 0, saveTimer, resizeTimer, frame, open = false;
  const stack = node("div", { class: "study-pdf-stack" });
  const counter = node("span", {}, "…");
  const toggle = button("", () => setOpen(!open), "study-pdf-toggle");
  toggle.append(counter); toggle.setAttribute("aria-label", "展开页面导航");
  toggle.setAttribute("aria-expanded", "false");
  const input = node("input", { type: "number", min: 1, value: current, "aria-label": "跳转到 PDF 页码" });
  const total = node("span", { class: "study-muted" });
  const track = node("div", { class: "study-pdf-thumbnails", "aria-label": "论文页面，滚轮横向浏览", tabindex: 0 });
  const previous = node("button", { type: "button", class: "study-pdf-arrow", onclick: () => goTo(current - 1) }, "‹");
  const next = node("button", { type: "button", class: "study-pdf-arrow", onclick: () => goTo(current + 1) }, "›");
  previous.setAttribute("aria-label", "上一页"); next.setAttribute("aria-label", "下一页");
  const panel = node("div", { class: "study-pdf-navigation-panel", hidden: true },
    node("div", { class: "study-pdf-navigation-head" }, node("span", {}, "页面导航"),
      node("label", {}, "跳至", input, total),
      node("a", { href: url, target: "_blank", rel: "noopener", download: "", "aria-label": "下载 PDF" }, "下载 ↗")),
    track, node("small", { class: "study-pdf-navigation-hint" }, "点击页面跳转 · 滚轮横向浏览"));
  const navigation = node("nav", { class: "study-pdf-nav", "aria-label": "PDF 页面导航", hidden: true }, panel,
    node("div", { class: "study-pdf-navigation-bar" }, previous, toggle, next));
  input.addEventListener("change", () => goTo(Number(input.value)));
  input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); goTo(Number(input.value)); } });
  navigation.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") setOpen(true); });
  navigation.addEventListener("pointerleave", () => { if (!navigation.contains(document.activeElement)) setOpen(false); });
  navigation.addEventListener("focusin", event => { if (event.target !== toggle) setOpen(true); });
  navigation.addEventListener("focusout", event => { if (!navigation.contains(event.relatedTarget)) setOpen(false); });
  navigation.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); document.activeElement?.blur(); setOpen(false); } });
  navigation.addEventListener("wheel", event => {
    if (!open || event.ctrlKey || event.target === input) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    track.scrollLeft += delta * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? track.clientWidth : 1);
  }, { passive: false });
  track.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const focused = Number(event.target.dataset.page) || current;
    const number = event.key === "Home" ? 1 : event.key === "End" ? pages.length : focused + (event.key === "ArrowLeft" ? -1 : 1);
    pages[Math.max(0, Math.min(pages.length - 1, number - 1))]?.thumbnail.focus();
  });
  const pageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = pages[Number(entry.target.dataset.page) - 1];
      if (record) { record.near = entry.isIntersecting; if (!record.near) release(record); }
    }
    pump();
  }, { root: body, rootMargin: "700px 0px" });
  const thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = pages[Number(entry.target.dataset.page) - 1];
      if (record) record.thumbVisible = entry.isIntersecting;
    }
    pump();
  }, { root: track, rootMargin: "0px 100px" });
  const resizeObserver = new ResizeObserver(() => {
    if (!active || !body.clientWidth || body.clientWidth === width) return;
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (active) layout(capture()); }, 80);
  });
  resizeObserver.observe(body);
  body.addEventListener("scroll", scroll);

  function setOpen(value) {
    if (value === open) return;
    open = value; panel.hidden = !value;
    navigation.classList.toggle("expanded", value);
    toggle.setAttribute("aria-expanded", String(value));
    toggle.setAttribute("aria-label", value ? "收起页面导航" : "展开页面导航");
    if (value) { revealThumbnail(); pump(); }
  }
  function revealThumbnail() {
    const thumb = pages[current - 1]?.thumbnail;
    if (thumb) track.scrollLeft = thumb.offsetLeft - track.clientWidth / 2 + thumb.offsetWidth / 2;
  }
  function setCurrent(number) {
    const changed = current !== number;
    current = number; counter.textContent = `${current} / ${pages.length}`;
    if (document.activeElement !== input) input.value = current;
    pages.forEach(record => {
      record.thumbnail.classList.toggle("active", record.number === current);
      if (record.number === current) record.thumbnail.setAttribute("aria-current", "page");
      else record.thumbnail.removeAttribute("aria-current");
    });
    previous.disabled = current <= 1; next.disabled = current >= pages.length;
    if (changed && open) revealThumbnail();
  }
  function capture() {
    if (!pages.length || !active || !body.clientWidth || !body.clientHeight || !body.contains(stack)) return position;
    const top = body.scrollTop + 2;
    let low = 0, high = pages.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (pages[mid].element.offsetTop <= top) low = mid; else high = mid - 1;
    }
    const record = pages[low];
    return { page: record.number, offset: Math.max(0, Math.min(1, (body.scrollTop - record.element.offsetTop) / record.element.offsetHeight)) };
  }
  function save() { if (active && pages.length) { position = capture(); onPosition(position); } }
  function scroll() {
    if (!active || frame) return;
    frame = requestAnimationFrame(() => {
      frame = null; if (!active) return;
      position = capture(); setCurrent(position.page);
      clearTimeout(saveTimer); saveTimer = setTimeout(save, 180);
    });
  }
  function release(record) {
    record.generation++;
    record.renderTask?.cancel(); record.textTask?.cancel();
    record.canvas?.remove(); record.textLayer?.remove();
    if (record.canvas) { record.canvas.width = 0; record.canvas.height = 0; }
    record.canvas = record.textLayer = null;
  }
  function layout(anchor) {
    width = body.clientWidth; if (!width) return;
    const available = Math.max(100, width - 24);
    for (const record of pages) {
      release(record);
      record.element.style.width = `${available}px`;
      record.element.style.height = `${available * record.ratio}px`;
      record.scale = available / record.baseWidth;
      record.element.style.setProperty("--scale-factor", String(record.scale));
    }
    const record = pages[Math.max(0, Math.min(pages.length - 1, (anchor.page || 1) - 1))];
    if (record) { body.scrollTop = record.element.offsetTop + (anchor.offset || 0) * record.element.offsetHeight; setCurrent(record.number); }
    pump();
  }
  function pump() {
    if (!active || disposed) return;
    while (jobs < 2) {
      const main = pages.filter(r => r.near && !r.canvas && !r.rendering && !r.error).sort((a, b) => Math.abs(a.number - current) - Math.abs(b.number - current))[0];
      const record = main || (open && pages.find(r => r.thumbVisible && !r.thumbDone && !r.thumbRendering && !r.thumbError));
      if (!record) break;
      jobs++; if (main) record.rendering = true; else record.thumbRendering = true;
      render(record, !main).finally(() => { jobs--; if (main) record.rendering = false; else record.thumbRendering = false; pump(); });
    }
  }
  async function render(record, thumbnail) {
    const generation = record.generation;
    const viewport = record.page.getViewport({ scale: thumbnail ? Math.min(68 / record.baseWidth, 88 / (record.baseWidth * record.ratio)) : record.scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = node("canvas", { "aria-hidden": "true" });
    canvas.width = Math.ceil(viewport.width * dpr); canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    let textLayer;
    try {
      const task = record.page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
      if (thumbnail) record.thumbTask = task; else record.renderTask = task;
      await task.promise;
      if (disposed || !active || (!thumbnail && generation !== record.generation)) return;
      if (thumbnail) { record.thumbnail.prepend(canvas); record.thumbDone = true; return; }
      textLayer = node("div", { class: "textLayer" });
      const content = await record.page.getTextContent();
      if (!active || generation !== record.generation) return;
      const textTask = new pdfjs.TextLayer({ textContentSource: content, container: textLayer, viewport });
      record.textTask = textTask; await textTask.render();
      if (!active || generation !== record.generation) return;
      record.canvas = canvas; record.textLayer = textLayer; record.element.append(canvas, textLayer);
    } catch (error) {
      if (disposed || !active || generation !== record.generation || error.name === "RenderingCancelledException" || error.name === "AbortException") return;
      if (thumbnail) record.thumbError = true;
      else {
        record.error = true;
        const retry = button(`第 ${record.number} 页加载失败，点击重试`, () => { retry.remove(); record.error = false; pump(); });
        retry.classList.add("study-pdf-retry"); retry.title = error.message; record.element.append(retry);
      }
    } finally {
      if (!canvas.isConnected) { canvas.width = 0; canvas.height = 0; }
    }
  }
  async function prepare() {
    loading ||= pdfjs.getDocument(url);
    pdf ||= await loading.promise;
    if (pages.length || disposed) return;
    const sources = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
    if (disposed) return;
    pages = sources.map((page, i) => {
      const number = i + 1, viewport = page.getViewport({ scale: 1 });
      const element = node("div", { class: "study-pdf-page", "data-page": number, "aria-label": `PDF 第 ${number} 页` }, node("span", { class: "study-pdf-placeholder" }, `第 ${number} 页`));
      const thumbnail = button("", () => goTo(number), "study-pdf-thumbnail");
      thumbnail.dataset.page = number; thumbnail.setAttribute("aria-label", `跳转到第 ${number} 页`);
      thumbnail.append(node("span", {}, String(number)));
      return { number, page, element, thumbnail, baseWidth: viewport.width, ratio: viewport.height / viewport.width, generation: 0 };
    });
    stack.replaceChildren(...pages.map(r => r.element)); track.replaceChildren(...pages.map(r => r.thumbnail));
    input.max = pages.length; total.textContent = `/ ${pages.length}`;
  }
  async function show() {
    const revision = ++showRevision;
    active = true; navigation.hidden = false; body.classList.add("study-pdf-body");
    body.replaceChildren(node("div", { class: "study-loading" }, "正在加载论文…"));
    try { preparation ||= prepare(); await preparation; }
    catch (error) {
      if (active && !disposed && revision === showRevision) body.replaceChildren(node("div", { class: "study-empty" }, `PDF 加载失败：${error.message}`, button("重试加载", () => { loading = preparation = null; return show(); })));
      return;
    }
    if (!active || disposed || revision !== showRevision) return;
    body.replaceChildren(stack); layout(position);
    for (const record of pages) { pageObserver.observe(record.element); thumbnailObserver.observe(record.thumbnail); }
  }
  function goTo(number) {
    if (!Number.isFinite(number) || !pages.length) { input.value = current; return; }
    const target = Math.max(1, Math.min(pages.length, Math.round(number)));
    body.scrollTop = pages[target - 1].element.offsetTop;
    setCurrent(target); save();
  }
  function hide() {
    save(); active = false; showRevision++; setOpen(false); navigation.hidden = true;
    pageObserver.disconnect(); thumbnailObserver.disconnect();
    clearTimeout(saveTimer); clearTimeout(resizeTimer); cancelAnimationFrame(frame); frame = null;
    for (const record of pages) { record.near = record.thumbVisible = false; release(record); record.thumbTask?.cancel(); }
    body.classList.remove("study-pdf-body");
  }
  return { navigation, show, hide, goTo,
    close() { hide(); disposed = true; resizeObserver.disconnect(); body.removeEventListener("scroll", scroll); loading?.destroy(); },
  };
}
