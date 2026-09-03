// Merge layer-1 (text flow blocks) with layer-2 (positioned elements) into the
// v2 intermediate representation: an ordered stream of blocks, each with
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
          if (it.text_level) flow.push({ type: "heading", level: Math.min(4, it.text_level + 0), text, page, bbox });
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
        if (text) flow.push({ type: "para", md: text, page, bbox });
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
      if (text) flow.push({ type: "para", md: text, page, bbox });
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
      const candKey = norm((cand.md || "").slice(0, 80));
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
    return [...flow, ...els.map(toBlock)];
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
    // full positional interleave: rebuild stream sorted by (page, y)
    const stream = [
      ...flow.map((b) => ({ kind: "flow", b, key: [b.page ?? 1e9, yOfB(b)] })),
      ...positioned.map((e) => ({ kind: "el", b: toBlock(e), key: [e.page ?? 1e9, yOf(e)] })),
    ];
    stream.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
    return stream.map((s) => s.b);
  }

  // page-boundary insertion
  for (const e of positioned) {
    const at = byPageInsert.has(e.page) ? byPageInsert.get(e.page) : result.length;
    result.splice(at, 0, toBlock(e));
    // shift later insert positions
    for (const [pg, pos] of byPageInsert) if (pos >= at) byPageInsert.set(pg, pos + 1);
  }
  for (const e of loose) result.push(toBlock(e));
  return result;

  function yOf(e) {
    return Array.isArray(e.bbox) ? e.bbox[1] : 0;
  }
  function yOfB(b) {
    return Array.isArray(b.bbox) ? b.bbox[1] : 0;
  }
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
