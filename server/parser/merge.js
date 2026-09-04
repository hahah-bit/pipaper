// Merge layer-1 (text flow blocks) with layer-2 (positioned elements) into the
// intermediate representation: an ordered stream of blocks, each with
// `page` (1-based) and `bbox` [x0,y0,x1,y1] in top-left-origin page coords
// at scale 1 when available.

import fs from "node:fs";
import path from "node:path";

// ---------- image natural size probing (PNG / JPEG / GIF headers) ----------

export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  // GIF
  if (buf.slice(0, 3).toString() === "GIF") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  return null;
}

export function attachNaturalSize(blocks, parsedDir) {
  for (const b of blocks) {
    if (b.type !== "image" || !b.src) continue;
    try {
      const rel = String(b.src).replace(/^file\//, "");
      const file = path.join(parsedDir, rel);
      if (fs.existsSync(file)) {
        const dim = imageSize(fs.readFileSync(file));
        if (dim) b.natural = [dim.w, dim.h];
      }
    } catch {}
  }
  return blocks;
}

// ---------- MinerU content_list.json (API zip) ----------
// Items: {type:'text'|'image'|'table'|'equation', page_idx(0-based), bbox,
//         text, img:'images/x.jpg', table_body(html), text_level}
export function parseContentList(cl) {
  const flow = [];
  const elements = [];
  for (const it of Array.isArray(cl) ? cl : []) {
    const page = (it.page_idx ?? 0) + 1;
    const bbox = Array.isArray(it.bbox) ? it.bbox : null;
    const text = String(it.text || "").trim();
    const cap = (v) => (Array.isArray(v) ? v[0] : v) || "";
    switch (it.type) {
      case "text":
      case "para":
        if (text) {
          const level = it.text_level ? Math.min(4, it.text_level + 0) : inferHeadingLevel(text);
          if (level) flow.push({ type: "heading", level, text, page, bbox });
          else flow.push({ type: "para", md: text, page, bbox });
        }
        break;
      case "table":
        elements.push({ type: "table", page, bbox, html: it.table_body || "", md: "", caption: cap(it.table_caption).slice(0, 300) || text.slice(0, 120) });
        break;
      case "image":
        elements.push({ type: "image", page, bbox, src: it.img || it.img_path || it.image_path || "", caption: cap(it.image_caption).slice(0, 300) || text.slice(0, 120) });
        break;
      case "equation":
        if (text) elements.push({ type: "formula", page, bbox, latex: text.replace(/^\$\$\s*\n?|\s*\n?\$\$$/g, "").trim() });
        break;
      default:
        if (text) {
          const level = inferHeadingLevel(text);
          flow.push(level ? { type: "heading", level, text, page, bbox } : { type: "para", md: text, page, bbox });
        }
    }
  }
  return { flow, elements };
}

// ---------- MinerU middle.json parsing ----------

// magic-pdf / mineru middle.json: pdf_info[] -> preproc_blocks[] with bbox,
// lines->spans carrying content / html / image_path / latex.
export function parseMiddleJson(middle) {
  const flow = []; // text blocks (with positions)
  const elements = []; // image / table / formula with positions
  const pages = middle?.pdf_info || [];
  pages.forEach((pg, idx) => {
    const page = idx + 1;
    const blocks = pg?.preproc_blocks || pg?.para_blocks || [];
    for (const blk of blocks) {
      const bbox = Array.isArray(blk.bbox) ? blk.bbox : null;
      const spans = [];
      for (const line of blk.lines || []) for (const sp of line.spans || []) spans.push(sp);
      if (!spans.length && Array.isArray(blk.spans)) spans.push(...blk.spans);
      const text = spans
        .map((sp) => sp.content || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (blk.type === "table" || blk.type === "table-body") {
        const html = spans.find((sp) => sp.html)?.html || "";
        elements.push({ type: "table", page, bbox, md: "", html, caption: firstCaption(spans) });
        continue;
      }
      if (blk.type === "image" || blk.type === "image-body") {
        const imgSpan = spans.find((sp) => sp.image_path);
        elements.push({
          type: "image",
          page,
          bbox,
          src: imgSpan?.image_path || "",
          caption: firstCaption(spans) || captionFromSiblings(pages, idx, blk),
        });
        continue;
      }
      if (blk.type === "equation" || blk.type === "interline_equation") {
        const latex = spans.find((sp) => sp.content)?.content || "";
        if (latex) elements.push({ type: "formula", page, bbox, latex });
        continue;
      }
      // text block (possibly with inline equation spans)
      if (text) {
        const level = inferHeadingLevel(text);
        flow.push(level ? { type: "heading", level, text, page, bbox } : { type: "para", md: text, page, bbox });
      }
    }
  });
  return { flow, elements };
}

function firstCaption(spans) {
  for (const sp of spans) {
    const t = sp.content || "";
    if (/^(Figure|Fig|Table|图|表)\s*\d+/.test(t.trim())) return t.trim().slice(0, 300);
  }
  return "";
}

function captionFromSiblings(pages, pageIdx, blk) {
  // MinerU often puts captions as a separate text block right after the image block
  const blocks = pages[pageIdx]?.preproc_blocks || [];
  const i = blocks.indexOf(blk);
  for (let j = i + 1; j < Math.min(blocks.length, i + 2); j++) {
    const t = (blocks[j]?.lines || [])
      .flatMap((l) => l.spans || [])
      .map((s) => s.content || "")
      .join(" ")
      .trim();
    if (/^(Figure|Fig\.?|图)\s*\d+/.test(t)) return t.slice(0, 300);
  }
  return "";
}

// ---------- merge ----------

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
const HEADING_RE = /^(?:(\d{1,3}(?:\.\d+){0,5})[.)]?\s+|([IVX]+)[.)]\s+)([^.!?:]{2,120})$/i;
const NAMED_HEADING_RE = /^(abstract|introduction|background|related work|methods?|materials and methods|results?|discussion|conclusions?|references|acknowledg(?:e)?ments?|supplementary|appendix|conclusion and (?:future|outlook))\b/i;

export function inferHeadingLevel(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 140 || /^(?:figure|fig\.?|table|图|表)\s*\d+/i.test(t)) return 0;
  const numbered = t.match(HEADING_RE);
  if (numbered) return numbered[1] ? Math.min(4, numbered[1].split(".").length) : 1;
  if (NAMED_HEADING_RE.test(t) && !/[.!?:;]$/.test(t)) return 1;
  if (/^[A-Z][A-Z0-9 &'(),/-]{3,100}$/.test(t) && !/[.!?:;]$/.test(t)) return 2;
  return 0;
}

export function normalizeLatex(latex) {
  return String(latex || "")
    .replace(/^\s*\$\$?\s*|\s*\$\$?\s*$/g, "")
    .replace(/\s*([_^])\s*/g, "$1")
    .replace(/\{\s+/g, "{")
    .replace(/\s+\}/g, "}")
    .replace(/\{([^{}]*\s+[^{}]*)\}/g, (whole, body, offset, source) => {
      const before = source.slice(Math.max(0, offset - 24), offset);
      if (/\\(?:text|mathrm|mathbf|operatorname)\s*$/.test(before)) return whole;
      return /^[A-Za-z0-9\s]+$/.test(body) ? `{${body.replace(/\s+/g, "")}}` : whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// PDF extractors commonly add spaces around TeX operators and braces. Keep
// prose spacing intact while repairing only text enclosed by math delimiters.
export function normalizeMathText(text) {
  const source = String(text || "");
  return source.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$)/g, (part) => {
    const left = part.startsWith("$$") ? "$$" : part.startsWith("\\[") ? "\\[" : part.startsWith("\\(") ? "\\(" : "$";
    const right = part.endsWith("$$") ? "$$" : part.endsWith("\\]") ? "\\]" : part.endsWith("\\)") ? "\\)" : "$";
    return left + normalizeLatex(part.slice(left.length, part.length - right.length)) + right;
  });
}

export function normalizeBlockContent(block) {
  if (!block || typeof block !== "object") return block;
  if (block.type === "para") {
    block.md = normalizeProseText(normalizeMathText(block.md));
    const level = inferHeadingLevel(block.md);
    if (level) {
      block.type = "heading";
      block.level = level;
      block.text = block.md;
      delete block.md;
    }
  }
  if (block.type === "heading") block.text = normalizeProseText(String(block.text || "").replace(/\s+/g, " ").trim());
  if (block.type === "formula") block.latex = normalizeLatex(block.latex);
  return block;
}

function textOf(block) {
  return block?.text || block?.md || block?.latex || block?.caption || "";
}

function isPageChrome(block) {
  const text = String(textOf(block)).replace(/\s+/g, " ").trim();
  return /^published as a conference paper\b/i.test(text) || /^\d{1,3}$/.test(text);
}

function normalizeProseText(text) {
  return String(text || "").replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1$2");
}

function overlapRatio(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const x = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = x * y;
  const area = Math.min(Math.max(1, (a[2] - a[0]) * (a[3] - a[1])), Math.max(1, (b[2] - b[0]) * (b[3] - b[1])));
  return intersection / area;
}

export function dedupeBlocks(blocks) {
  const out = [];
  for (const raw of blocks || []) {
    const b = normalizeBlockContent(raw);
    const key = norm(textOf(b).slice(0, 120));
    const duplicate = key && out.some((prev) => {
      if (prev.page !== b.page || norm(textOf(prev).slice(0, 120)) !== key) return false;
      if (overlapRatio(prev.bbox, b.bbox) >= 0.35) return true;
      return Array.isArray(prev.bbox) && Array.isArray(b.bbox) && Math.abs(prev.bbox[1] - b.bbox[1]) < 18;
    });
    if (!duplicate) out.push(b);
  }
  return out;
}

// Assign page+bbox positions to md flow blocks by fuzzy text matching against
// positioned middle.json text blocks. Returns matched count.
export function attachPositions(mdBlocks, positionedFlow) {
  const unused = positionedFlow.map((p, i) => i);
  for (const b of mdBlocks) {
    const key = norm((b.text || b.md || "").slice(0, 40));
    if (!key) continue;
    let best = -1;
    let bestScore = 0;
    for (const i of unused) {
      const cand = positionedFlow[i];
      const candKey = norm(textOf(cand).slice(0, 80));
      if (!candKey) continue;
      // prefix containment score
      const n = Math.min(key.length, 40);
      let score = 0;
      if (candKey.startsWith(key) || key.startsWith(candKey.slice(0, Math.min(key.length, 40)))) score = n;
      else {
        // sliding window containment
        for (let s = 0; s + n <= candKey.length && score === 0; s += 4) {
          if (candKey.slice(s, s + Math.min(n, 24)) === key.slice(0, Math.min(n, 24))) score = n - s / 4;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= 8) {
      const p = positionedFlow[best];
      b.page = p.page;
      b.bbox = p.bbox;
      unused.splice(unused.indexOf(best), 1);
    }
  }
  return mdBlocks;
}

// Interleave positioned elements into the flow. Ordering key: (page, y0).
// Flow blocks without positions keep relative order and elements attach at
// their page boundary (after the last block of that page), or at the end.
export function mergeBlocks(flow, elements, { parsedDir, assetsDir, saveAsset } = {}) {
  const hasPositions = flow.some((b) => b.page != null);
  const els = [...elements];

  // save element image assets when a saver is provided (MinerU image_path files)
  for (const e of els) {
    if (e.type === "image" && e.src && saveAsset) {
      e.src = saveAsset(e.src);
    }
  }

  if (!hasPositions) {
    // append elements at the end grouped by page if the flow has any page info,
    // otherwise plain append in (page, y) order
    els.sort((a, b) => (a.page || 0) - (b.page || 0) || yOf(a) - yOf(b));
    return dedupeBlocks([...flow, ...els.map(toBlock)]);
  }

  // index flow blocks by page for boundary insertion
  const result = [];
  const byPageInsert = new Map(); // page -> insert position in result (grows)
  flow.forEach((b, i) => {
    result.push(b);
    const pg = b.page;
    byPageInsert.set(pg, result.length);
  });

  els.sort((a, b) => (a.page || 0) - (b.page || 0) || yOf(a) - yOf(b));
  const positioned = els.filter((e) => e.page != null && e.bbox);
  const loose = els.filter((e) => !(e.page != null && e.bbox));

  if (flow.some((b) => b.bbox)) {
    return dedupeBlocks([...flow, ...positioned.map(toBlock)]);
  }

  // page-boundary insertion
  for (const e of positioned) {
    const at = byPageInsert.has(e.page) ? byPageInsert.get(e.page) : result.length;
    result.splice(at, 0, toBlock(e));
    // shift later insert positions
    for (const [pg, pos] of byPageInsert) if (pos >= at) byPageInsert.set(pg, pos + 1);
  }
  for (const e of loose) result.push(toBlock(e));
  return dedupeBlocks(result);

  function yOf(e) {
    return Array.isArray(e.bbox) ? e.bbox[1] : 0;
  }
  function yOfB(b) {
    return Array.isArray(b.bbox) ? b.bbox[1] : 0;
  }
}

function validBox(b) {
  return Array.isArray(b?.bbox) && b.bbox.length === 4 && b.bbox[2] > b.bbox[0] && b.bbox[3] > b.bbox[1];
}

function yOfBlock(b) {
  return validBox(b) ? b.bbox[1] : Number.MAX_SAFE_INTEGER;
}

function sortByPosition(a, b) {
  return yOfBlock(a) - yOfBlock(b) || (validBox(a) ? a.bbox[0] : 0) - (validBox(b) ? b.bbox[0] : 0);
}

function findColumnSplit(blocks, pageWidth) {
  const eligible = blocks.filter((b) => validBox(b) && ["para", "heading"].includes(b.type) && (b.type === "heading" || textOf(b).length >= 55));
  const narrow = eligible.filter((b) => (b.bbox[2] - b.bbox[0]) < pageWidth * 0.72);
  if (narrow.length < 3) return null;
  const centers = narrow.map((b) => (b.bbox[0] + b.bbox[2]) / 2).sort((a, b) => a - b);
  let bestGap = 0;
  let bestAt = -1;
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] > bestGap) {
      bestGap = centers[i] - centers[i - 1];
      bestAt = i;
    }
  }
  if (bestAt < 0 || bestGap < pageWidth * 0.16) return null;
  const left = narrow.filter((b) => (b.bbox[0] + b.bbox[2]) / 2 < centers[bestAt]);
  const right = narrow.filter((b) => (b.bbox[0] + b.bbox[2]) / 2 >= centers[bestAt]);
  if (left.length < 2 || right.length < 1) return null;
  return (centers[bestAt - 1] + centers[bestAt]) / 2;
}

function layoutPage(page, pageBlocks) {
  const positioned = pageBlocks.filter(validBox);
  const pageWidth = Math.max(1, ...positioned.map((b) => b.bbox[2]));
  const pageHeight = Math.max(1, ...positioned.map((b) => b.bbox[3]));
  const split = findColumnSplit(pageBlocks, pageWidth);
  const columns = split ? ["left", "right"] : ["single"];
  const columnOf = (b) => {
    if (!split || !validBox(b)) return "single";
    const [x0, , x1] = b.bbox;
    const tolerance = pageWidth * 0.025;
    if (x1 <= split + tolerance) return "left";
    if (x0 >= split - tolerance) return "right";
    return "span";
  };
  const tagged = pageBlocks.map((b) => ({ b, column: columnOf(b) }));
  let ordered;
  if (!split) ordered = tagged.sort((a, b) => sortByPosition(a.b, b.b)).map((x) => x.b);
  else {
    const left = tagged.filter((x) => x.column === "left").sort((a, b) => sortByPosition(a.b, b.b));
    const right = tagged.filter((x) => x.column === "right").sort((a, b) => sortByPosition(a.b, b.b));
    const spans = tagged.filter((x) => x.column === "span").sort((a, b) => sortByPosition(a.b, b.b));
    const substantive = (x) => !/^published as a conference paper/i.test(textOf(x.b)) && !/^\d+$/.test(textOf(x.b).trim()) && (x.b.type === "heading" || textOf(x.b).length >= 28);
    const body = left.concat(right).filter(substantive);
    const firstY = body.length ? Math.min(...body.map((x) => yOfBlock(x.b))) : Math.min(...tagged.map((x) => yOfBlock(x.b)));
    const rightEnd = right.length ? Math.max(...right.map((x) => validBox(x.b) ? x.b.bbox[3] : yOfBlock(x.b))) : -Infinity;
    const pre = spans.filter((x) => yOfBlock(x.b) <= firstY + 24);
    const post = spans.filter((x) => rightEnd > -Infinity && yOfBlock(x.b) > rightEnd - 24);
    const middle = spans.filter((x) => !post.includes(x) && yOfBlock(x.b) > firstY + 24);
    ordered = [...pre, ...left, ...middle, ...right, ...post].map((x) => x.b);
  }
  const order = ordered.map((b, i) => {
    b.column = columnOf(b);
    b.order = i;
    return b;
  });
  const bbox = positioned.length ? [Math.min(...positioned.map((b) => b.bbox[0])), 0, pageWidth, pageHeight] : [0, 0, pageWidth, pageHeight];
  return { page, width: pageWidth, height: pageHeight, layout: split ? "double" : "single", columns, bbox, blocks: order };
}

export function normalizeLayout(blocks) {
  const clean = dedupeBlocks(blocks).filter((b) => !isPageChrome(b));
  const byPage = new Map();
  const loose = [];
  for (const b of clean) {
    if (b.page == null) loose.push(b);
    else if (!byPage.has(b.page)) byPage.set(b.page, []);
    if (b.page != null) byPage.get(b.page).push(b);
  }
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, pageBlocks]) => layoutPage(page, pageBlocks));
  const readingBlocks = [...pages.flatMap((p) => p.blocks), ...loose];
  const sections = [];
  readingBlocks.forEach((b, i) => {
    if (b.type === "heading") sections.push({ index: i, level: b.level || 1, title: b.text, page: b.page || null });
  });
  return { pages, readingBlocks, sections };
}

function toBlock(e) {
  if (e.type === "image") {
    return { type: "image", src: e.src, caption: e.caption || "", page: e.page, bbox: e.bbox, natural: e.natural };
  }
  if (e.type === "table") {
    return { type: "table", md: e.md || "", html: e.html || "", caption: e.caption || "", page: e.page, bbox: e.bbox };
  }
  if (e.type === "formula") {
    return { type: "formula", latex: e.latex, page: e.page, bbox: e.bbox };
  }
  return e;
}
