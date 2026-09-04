// Fallback layer-2 element extractor: caption-anchored figure crops.
// No ML — uses pdf.js text positions to find "Figure N" captions and crops
// the region above them (vector figures included, since we rasterize pages).
//
// All bboxes are [x0, y0(top), x1, y1(bottom)] in viewport coords at scale 1
// (top-left origin), so they interleave directly with fallback text blocks and
// can be cropped by renderPageCrop by simple scale multiplication.

import { openDocument, renderPageCrop } from "./render.js";

const CAPTION_RE = /^\s*(Figure|Fig\.?|图)\s*(\d+)\s*[:.\uFF1A]?/i;

// Extract text lines of a page in viewport scale-1 coords.
export async function pageLines(page) {
  const base = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const lines = [];
  for (const it of tc.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const x = it.transform[4];
    const pdfY = it.transform[5];
    const h = Math.abs(it.transform[3]) || 10;
    const w = it.width || it.str.length * h * 0.5;
    const [vx, vyBaseline] = base.convertToViewportPoint(x, pdfY);
    const bottom = vyBaseline;
    const top = vyBaseline - h;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.bottom - bottom) < 2.5 && x >= last.x0) {
      last.text += it.str;
      last.x1 = Math.max(last.x1, vx + w);
    } else {
      lines.push({ text: it.str, x0: vx, x1: vx + w, top, bottom, h });
    }
  }
  lines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  return { lines: orderPageLines(lines, base.width), pageW: base.width, pageH: base.height };
}

function orderPageLines(lines, pageW) {
  const contentMin = Math.min(...lines.map((l) => l.x0));
  const contentMax = Math.max(...lines.map((l) => l.x1));
  const contentW = Math.max(1, contentMax - contentMin);
  const eligible = lines.filter((l) => l.text.length >= 25 && (l.x1 - l.x0) < contentW * 0.72);
  const centers = eligible.map((l) => (l.x0 + l.x1) / 2).sort((a, b) => a - b);
  let gap = 0;
  let at = -1;
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] > gap) {
      gap = centers[i] - centers[i - 1];
      at = i;
    }
  }
  if (at < 0 || gap < pageW * 0.16) return lines.map((l) => ({ ...l, column: "single" }));
  const split = (centers[at - 1] + centers[at]) / 2;
  const columnOf = (l) => {
    const tolerance = pageW * 0.025;
    if (l.x1 <= split + tolerance) return "left";
    if (l.x0 >= split - tolerance) return "right";
    return "span";
  };
  const tagged = lines.map((l) => ({ l, column: columnOf(l) }));
  const left = tagged.filter((x) => x.column === "left").sort(linePosition);
  const right = tagged.filter((x) => x.column === "right").sort(linePosition);
  const spans = tagged.filter((x) => x.column === "span").sort((a, b) => linePosition(a.l, b.l));
  const substantive = (x) => x.column !== "span" && !/^published as a conference paper/i.test(x.l.text) && !/^\d+$/.test(x.l.text.trim()) && (x.l.text.length >= 28 || x.l.h >= 13);
  const leftBody = left.filter(substantive);
  const rightBody = right.filter(substantive);
  const body = leftBody.concat(rightBody);
  const firstY = body.length ? Math.min(...body.map((x) => x.l.top)) : Math.min(...tagged.map((x) => x.l.top));
  const rightEnd = right.length ? Math.max(...right.map((x) => x.l.bottom)) : -Infinity;
  // A short final line of a full-width paragraph can look like a left-column
  // line. Keep it with the span above until the first real column paragraph.
  const corrected = tagged.map((x) => x.column !== "span" && x.l.top < firstY ? { ...x, column: "span" } : x);
  const correctedLeft = corrected.filter((x) => x.column === "left").sort((a, b) => linePosition(a.l, b.l));
  const correctedRight = corrected.filter((x) => x.column === "right").sort((a, b) => linePosition(a.l, b.l));
  const correctedSpans = corrected.filter((x) => x.column === "span").sort((a, b) => linePosition(a.l, b.l));
  const pre = correctedSpans.filter((x) => x.l.top < firstY);
  const post = correctedSpans.filter((x) => rightEnd > -Infinity && x.l.top > rightEnd - 12);
  const middle = correctedSpans.filter((x) => !post.includes(x) && x.l.top >= firstY);
  return [...pre, ...correctedLeft, ...middle, ...correctedRight, ...post].map((x) => ({ ...x.l, column: x.column }));
}

function linePosition(a, b) {
  return a.top - b.top || a.x0 - b.x0;
}

export async function extractFigureElements(pdfPath, log = () => {}) {
  const doc = await openDocument(pdfPath);
  const elements = [];
  try {
    for (let pno = 1; pno <= doc.numPages; pno++) {
      let page;
      try {
        page = await doc.getPage(pno);
        const { lines, pageW } = await pageLines(page);
        const mid = pageW / 2;
        const colOf = (l) => (l.x1 <= mid + 10 ? 0 : l.x0 >= mid - 10 ? 1 : -1);
        const isParaLine = (l) => l.text.length > 50 && (l.x1 - l.x0) / Math.max(1, l.text.length) < 14;

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const m = l.text.match(CAPTION_RE);
          if (!m) continue;
          const col = l.column === "single" ? colOf(l) : l.column === "span" ? -1 : l.column === "left" ? 0 : 1;
          const x0 = col === 1 ? mid : Math.max(0, l.x0 - 20);
          const x1 = col === 0 ? mid : col === -1 ? pageW : Math.min(pageW, l.x1 + 20);
          // top = bottom of nearest dense paragraph line above the caption
          let top = Math.max(0, l.top - 320);
          for (let j = i - 1; j >= 0; j--) {
            const pl = lines[j];
            if (pl.bottom >= l.top) continue;
            const pcol = colOf(pl);
            if (col !== -1 && pcol !== -1 && pcol !== col) continue;
            if (isParaLine(pl)) {
              top = pl.bottom + 3;
              break;
            }
          }
          if (l.top - top < 40) continue; // too small to be a figure
          elements.push({
            kind: "figure",
            page: pno,
            bbox: [x0, top, x1, l.bottom + 2],
            caption: l.text.trim().slice(0, 300),
          });
          log(`第 ${pno} 页发现图注: ${l.text.trim().slice(0, 60)}`);
        }
      } finally {
        page?.cleanup?.();
      }
    }
  } finally {
    doc.destroy?.();
  }
  return dedupe(elements);
}

function dedupe(elements) {
  const seen = new Set();
  return elements.filter((e) => {
    const num = e.caption.match(CAPTION_RE)?.[2] || "?";
    const key = e.page + ":" + num;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function cropFigure(pdfPath, el) {
  return renderPageCrop(pdfPath, el.page, el.bbox, { scale: 2, minW: 60, minH: 40 });
}
