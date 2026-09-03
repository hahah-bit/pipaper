import { renderPageCrop, renderPage, openDocument } from "../server/parser/render.js";

const pdf = "library/Attention Is All You Need (Vaswani et al., 2017).pdf";

console.log("1. full page render p3 …");
const rp = await renderPage(pdf, 3, 2);
console.log("   ok", rp.width, "x", rp.height, Math.round(rp.toPngBuffer().length / 1024), "KB");

console.log("2. crop p3 [190,82,612,414] …");
const r = await renderPageCrop(pdf, 3, [190, 82, 612, 414], { scale: 2, minW: 60, minH: 40 });
console.log("   ok:", r ? `${r.width}x${r.height} KB ${Math.round(r.buffer.length / 1024)}` : "null");

console.log("3. second crop same doc …");
const r2 = await renderPageCrop(pdf, 3, [100, 300, 500, 500], { scale: 2, minW: 60, minH: 40 });
console.log("   ok:", r2 ? `${r2.width}x${r2.height}` : "null");
console.log("done");
