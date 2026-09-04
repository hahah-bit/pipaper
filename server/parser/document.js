import { createHash } from "node:crypto";
import katex from "katex";
import { openDocument, closeDocument } from "./render.js";
import { tableStructure } from "./tables.js";
import { missingGlyphs, missingTableNumbers } from "./evidence.js";

export const blockText = (b) => b.text || b.md || b.latex || b.caption || "";
export const validBox = (b) => Array.isArray(b?.bbox) && b.bbox.length === 4 && b.bbox.every(Number.isFinite) && b.bbox[2] > b.bbox[0] && b.bbox[3] > b.bbox[1];
const key = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export async function readNative(pdfPath) {
  const doc = await openDocument(pdfPath);
  const pages = [];
  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      const vp = pdfPage.getViewport({ scale: 1 });
      const tc = await pdfPage.getTextContent();
      const items = tc.items.filter((t) => t.str?.trim()).map((t, seq) => {
        const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
        const h = Math.hypot(t.transform[2], t.transform[3]) || 10;
        return { text: t.str, seq, bbox: [x, y - h, x + t.width, y], height: h, font: t.fontName };
      });
      pages.push({ page, width: vp.width, height: vp.height, rotation: vp.rotation, items });
      pdfPage.cleanup();
    }
  } finally { closeDocument(doc); }
  return { pages };
}

export function nativeInBox(page, box) {
  if (!page || !box) return [];
  return page.items.filter((t) => {
    const [x, y, x1, y1] = t.bbox;
    return (x + x1) / 2 >= box[0] - 2 && (x + x1) / 2 <= box[2] + 2 && (y + y1) / 2 >= box[1] - 3 && (y + y1) / 2 <= box[3] + 3;
  });
}

export function inlineContent(text) {
  const parts = [];
  const re = /\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|(?<!\\)\$(?!\$)((?:\\.|[^$\n])+)(?<!\\)\$/g;
  let at = 0;
  for (const m of String(text || "").matchAll(re)) {
    if (m.index > at) parts.push({ type: "text", text: text.slice(at, m.index) });
    parts.push({ type: "math", latex: m[1] ?? m[2] ?? m[3] ?? m[4], display: m[1] !== undefined || m[3] !== undefined });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ type: "text", text: text.slice(at) });
  return parts;
}

export function reconcileNative(blocks, native) {
  return splitPageContinuations(blocks, native).map((original) => {
    const b = structuredClone(original);
    const page = native.pages[b.page - 1];
    const tokens = validBox(b) ? nativeInBox(page, b.bbox) : [];
    b.nativeRefs = tokens.map((t) => t.seq);
    b.verification = tokens.length ? "region-matched" : "no-text-layer";
    if (b.type === "heading" && tokens.length) {
      const text = tokens.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim();
      if (key(text) === key(b.text) && text.length < 160) {
        b.provenance.verifiedBy = "pdfjs";
      }
    }
    return b;
  });
}

export function splitPageContinuations(input, native) {
  const blocks = structuredClone(input);
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "para" || block.md?.trim() || !validBox(block)) continue;
    const text = nativeInBox(native.pages[block.page - 1], block.bbox).map((t) => t.text).join(" ");
    const target = key(text);
    if (target.length < 100) continue;
    for (let i = index - 1; i >= 0; i--) {
      const previous = blocks[i];
      if (previous.page < block.page - 1) break;
      if (previous.type !== "para" || !previous.md || !validBox(previous)) continue;
      const acrossPage = previous.page === block.page - 1;
      const acrossRegion = previous.page === block.page && (block.bbox[0] >= previous.bbox[2] - 3 || block.bbox[1] >= previous.bbox[3] - 3);
      if (!acrossPage && !acrossRegion) continue;
      const offsets = [], chars = [];
      let offset = 0;
      for (const char of previous.md) {
        for (const normalized of key(char)) { chars.push(normalized); offsets.push(offset); }
        offset += char.length;
      }
      const normalized = chars.join("");
      const prefix = target.slice(0, 48), suffix = target.slice(-32);
      const start = normalized.indexOf(prefix);
      if (start < 20 || normalized.indexOf(prefix, start + 1) >= 0 || !normalized.slice(start + prefix.length).includes(suffix)) continue;
      const split = offsets[start];
      const splitsWord = /\p{L}$/u.test(previous.md.slice(0, split)) && /^\p{L}/u.test(previous.md.slice(split));
      block.md = previous.md.slice(split).trim();
      previous.md = previous.md.slice(0, split).trimEnd();
      if (splitsWord) previous.md += "-";
      block.continuedFrom = { page: previous.page, sourceIndex: previous.provenance?.sourceIndex };
      block.provenance = { ...block.provenance, textSource: previous.provenance, verifiedBy: "pdfjs", repair: acrossPage ? "exact-page-continuation" : "exact-region-continuation" };
      break;
    }
  }
  return blocks;
}

function headingLevel(text, fallback) {
  const m = String(text).match(/^((?:\d+|[A-Z])(?:\.\d+)*)[.)]?\s+\S/);
  return m ? Math.min(6, m[1].split(".").length) : fallback || 1;
}

// Native dimensions are authoritative. Source order is retained; layout is
// presentation metadata, never a reason to move unmatched text to another page.
export function buildDocument(input, native, meta) {
  const blocks = structuredClone(input);
  const errors = [];
  const warnings = [];
  const stack = [];
  let previousPage = 0;
  for (const [i, b] of blocks.entries()) {
    b.provenance ||= { engine: meta.engine, sourceIndex: i };
    b.id ||= "b_" + createHash("sha256").update(JSON.stringify([b.page, b.provenance, b.bbox, blockText(b)])).digest("hex").slice(0, 20);
    b.order = i;
    b.issues ||= [];
    if (!Number.isInteger(b.page) || !native.pages[b.page - 1]) errors.push({ blockId: b.id, code: "missing-page", message: "内容缺少有效页码" });
    else {
      if (b.page < previousPage) errors.push({ blockId: b.id, code: "page-order", message: "来源阅读顺序发生跨页回退" });
      previousPage = b.page;
      const p = native.pages[b.page - 1];
      if (!validBox(b)) errors.push({ blockId: b.id, code: "missing-box", message: "内容缺少有效坐标" });
      else if (b.bbox[0] < -3 || b.bbox[1] < -3 || b.bbox[2] > p.width + 3 || b.bbox[3] > p.height + 3) errors.push({ blockId: b.id, code: "box-outside-page", message: "坐标超出原始页面" });
    }
    if (b.type === "heading") {
      b.level = headingLevel(b.text, b.level);
      if (!b.algorithm) {
        while (stack.length && stack.at(-1).level >= b.level) stack.pop();
        stack.push({ id: b.id, title: b.text, level: b.level });
      }
    }
    b.sectionPath = stack.map((s) => s.title);
    const nativeText = validBox(b) ? nativeInBox(native.pages[b.page - 1], b.bbox).map((t) => t.text).join(" ") : "";
    if (b.type === "para") b.content = inlineContent(b.md || "");
    if (b.type === "para" && !b.md?.trim() && nativeText.length > 20) b.issues.push("empty-source-text");
    if (b.type === "table" && b.html) {
      try {
        b.table = tableStructure(b.html);
        b.issues.push(...b.table.issues);
        if (nativeText) {
          const missing = missingTableNumbers(b.table.cells, nativeText);
          if (missing.length) { b.issues.push("table-numeric-mismatch"); b.verificationDetails = { missingNumbers: missing }; }
        }
        if (b.table.cells.some((c) => /\d+\.\d+\s+\d+\.\d+/.test(c.text))) b.issues.push("table-merged-values");
      } catch { b.issues.push("table-invalid-html"); }
    }
    const mathSpans = b.type === "formula" ? [{ latex: b.latex }] : b.type === "para" ? b.content.filter((s) => s.type === "math") : inlineContent(b.caption || "").filter((s) => s.type === "math");
    for (const math of mathSpans) {
      try {
        katex.renderToString(math.latex || "", { displayMode: b.type === "formula" || Boolean(math.display), throwOnError: true, strict: "ignore", trust: false });
        if (nativeText) {
          const missing = missingGlyphs(math.latex || "", nativeText);
          if (missing.length) { b.issues.push("math-source-conflict"); (b.mathConflicts ||= []).push({ latex: math.latex, unmatchedGlyphs: missing.join("") }); }
        }
      }
      catch { b.issues.push("formula-syntax"); }
    }
    if (b.type === "table" && !b.html && !b.md) b.issues.push("empty-table");
    if (b.type === "image" && !b.src) b.issues.push("missing-image");
    if (b.issues.length && nativeText) b.nativeText = nativeText;
    for (const code of new Set(b.issues)) warnings.push({ blockId: b.id, page: b.page, code });
  }
  const pages = native.pages.map((p) => {
    const pb = blocks.filter((b) => b.page === p.page);
    if (!pb.length && p.items.some((t) => t.text.length > 15)) errors.push({ page: p.page, code: "missing-page-content", message: "原页存在文字，但解析结果没有内容" });
    const body = pb.filter((b) => ["para", "heading"].includes(b.type) && validBox(b));
    const left = body.filter((b) => b.bbox[2] < p.width * 0.54 && blockText(b).length > 100);
    const right = body.filter((b) => b.bbox[0] > p.width * 0.46 && blockText(b).length > 100);
    const double = left.length >= 2 && right.length >= 2 && left.some((l) => right.some((r) => Math.min(l.bbox[3], r.bbox[3]) - Math.max(l.bbox[1], r.bbox[1]) > 25));
    for (const b of pb) b.column = double && validBox(b) ? b.bbox[2] < p.width * 0.54 ? "left" : b.bbox[0] > p.width * 0.46 ? "right" : "span" : "single";
    // Side illustrations are regions within a single-column page.
    for (const fig of pb.filter((b) => b.type === "image" && validBox(b))) {
      const peer = body.find((b) => b.bbox[2] <= fig.bbox[0] + 5 && Math.min(b.bbox[3], fig.bbox[3]) - Math.max(b.bbox[1], fig.bbox[1]) > 20);
      if (!double && peer && fig.bbox[2] - fig.bbox[0] < p.width * 0.55) fig.wrapBefore = peer.id;
    }
    return { page: p.page, width: p.width, height: p.height, rotation: p.rotation, layout: double ? "double" : "single", blockIds: pb.map((b) => b.id) };
  });
  return { v: 4, meta: { ...meta, pages: pages.length, blocks: blocks.length, schemaVersion: 4 }, blocks, pages, sections: blocks.filter((b) => b.type === "heading").map((b) => ({ id: b.id, index: b.order, title: b.text, level: b.level, page: b.page })), quality: { errors, warnings, checkedBlocks: blocks.length, mathCheck: "syntax-and-native-glyphs", semanticVerification: false } };
}
