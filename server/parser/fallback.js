import fs from "node:fs";

// Fallback engine: pdfjs-dist (legacy build) text extraction. Always available,
// no network/native deps. Produces paragraph blocks with page hints and simple
// heading heuristics. Formulas/tables are not recovered in this mode.

export async function parseFallbackText(pdfPath, _cfg, log = () => {}) {
  log("本地兜底解析（pdf.js 文本抽取，不含公式/表格结构）…");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const blocks = [];
  const H1 = /^(abstract|introduction|background|related work|methods?|materials and methods|results?|discussion|conclusions?|references|acknowledg(e)ments?|supplementary|appendix|conclusion and (?:future|outlook))\b/i;
  const H2 = /^(\d+(\.\d+)*[.)]?\s+\S.{2,90}|^[IVX]+\.\s+\S.{2,90})$/;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines = [];
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      const y = Math.round(it.transform[5]);
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - y) < 3) {
        last.text += (last.text.endsWith(" ") || it.str.startsWith(" ") ? "" : " ") + it.str;
      } else {
        lines.push({ y, text: it.str, height: Math.abs(it.transform[3]) || 10 });
      }
    }
    // de-hyphenate and merge wrapped lines into paragraphs
    let para = [];
    const flush = () => {
      if (!para.length) return;
      let text = para.join(" ").replace(/(\w)-\s+(\w)/g, "$1$2").replace(/\s+/g, " ").trim();
      if (text) blocks.push({ type: "para", md: text, page: p });
      para = [];
    };
    for (const ln of lines) {
      const t = ln.text.trim();
      if (!t) {
        flush();
        continue;
      }
      const big = ln.height >= 13;
      if (big && t.length < 120) {
        flush();
        blocks.push({ type: "heading", level: ln.height >= 16 ? 1 : 2, text: t.replace(/\s+/g, " "), page: p });
        continue;
      }
      if (H1.test(t) && t.length < 60) {
        flush();
        blocks.push({ type: "heading", level: 1, text: t.replace(/\s+/g, " "), page: p });
        continue;
      }
      if (H2.test(t) && t.length < 90) {
        flush();
        blocks.push({ type: "heading", level: 2, text: t.replace(/\s+/g, " "), page: p });
        continue;
      }
      para.push(t);
      const endsSentence = /[.!?:;”"']$/.test(t) || t.endsWith(".");
      if (endsSentence && para.join(" ").length > 320) flush();
    }
    flush();
    log(`已抽取 ${p}/${doc.numPages} 页`);
  }
  return { blocks, pages: doc.numPages };
}
