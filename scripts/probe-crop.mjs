import { extractFigureElements, cropFigure } from "../server/parser/elements-fallback.js";
import { renderPageCrop } from "../server/parser/render.js";

const pdf = "library/Attention Is All You Need (Vaswani et al., 2017).pdf";
console.log("extracting captions…");
const figs = await extractFigureElements(pdf, (m) => console.log(" ", m));
console.log("captions:", figs.length);
for (const f of figs) {
  console.log("crop p" + f.page, JSON.stringify(f.bbox.map((x) => Math.round(x))));
  try {
    const r = await cropFigure(pdf, f);
    console.log("  ->", r ? `${r.width}x${r.height} png ${Math.round(r.buffer.length / 1024)}KB` : "null (too small)");
  } catch (e) {
    console.log("  -> ERROR:", e.message);
  }
}
console.log("done");
