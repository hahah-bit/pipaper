import fs from "node:fs";

// Fallback layer-1 engine: pdfjs-dist (legacy build) text extraction. Always
// available, no network/native deps. Produces paragraph/heading blocks with
// page + bbox (viewport coords at scale 1, top-left origin) so layer-2
// elements (figure crops) can be interleaved at their real positions.

import { openDocument } from "./render.js";
import { pageLines } from "./elements-fallback.js";

export async function parseFallbackText(pdfPath, _cfg, log = () => {}) {
  log("本地兜底解析（pdf.js 文本抽取）+ 图表定位…");
  const doc = await openDocument(pdfPath);
  const blocks = [];
  const H1 = /^(abstract|introduction|background|related work|methods?|materials and methods|results?|discussion|conclusions?|references|acknowledg(e)ments?|supplementary|appendix|conclusion and (?:future|outlook))\b/i;
  const H2 = /^(\d+(\.\d+)*[.)]?\s+\S.{2,90}|^[IVX]+\.\s+\S.{2,90})$/;

  for (let p = 1; p <= doc.numPages; p++) {
    let page;
    try {
      page = await doc.getPage(p);
      const { lines, pageH } = await pageLines(page);
      let para = null; // accumulating paragraph {text, x0,x1,top,bottom}
      const flush = () => {
        if (!para) return;
        const text = para.text.replace(/(\w)-\s+(\w)/g, "$1$2").replace(/\s+/g, " ").trim();
        if (text) {
          blocks.push({ type: "para", md: text, page: p, bbox: [para.x0, para.top, para.x1, para.bottom] });
        }
        para = null;
      };
      const pushPara = (t, l) => {
        if (!para) para = { text: t, x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom };
        else {
          para.text += " " + t;
          para.x1 = Math.max(para.x1, l.x1);
          para.bottom = l.bottom;
        }
      };

      for (const ln of lines) {
        const t = ln.text.trim();
        if (!t) {
          flush();
          continue;
        }
        const big = ln.h >= 13;
        const headingOf = (t2) => {
          if (big && t2.length < 120) return ln.h >= 16 ? 1 : 2;
          if (H1.test(t2) && t2.length < 60) return 1;
          if (H2.test(t2) && t2.length < 90) return 2;
          return 0;
        };
        const lv = headingOf(t);
        if (lv) {
          flush();
          blocks.push({
            type: "heading",
            level: lv,
            text: t.replace(/\s+/g, " "),
            page: p,
            bbox: [ln.x0, ln.top, ln.x1, ln.bottom],
          });
          continue;
        }
        pushPara(t, ln);
        const endsSentence = /[.!?:;”"']$/.test(t);
        if (endsSentence && para.text.length > 320) flush();
      }
      flush();
    } finally {
      page?.cleanup?.();
    }
    if (p % 5 === 0) log(`已抽取 ${p}/${doc.numPages} 页`);
  }
  doc.destroy?.();
  log(`文本层完成：${blocks.length} 块`);
  return { blocks, pages: doc.numPages };
}
