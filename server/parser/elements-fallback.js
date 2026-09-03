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
  lines.sort((a, b) => a.top - b.top);
  return { lines, pageW: base.width, pageH: base.height };
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
          const col = colOf(l);
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
