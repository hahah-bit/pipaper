// node-canvas variant: does attention p3 render without crashing?
import { createCanvas } from "canvas";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const fontsUrl = pathToFileURL(path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep).href;
const data = new Uint8Array(fs.readFileSync("library/Attention Is All You Need (Vaswani et al., 2017).pdf"));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, standardFontDataUrl: fontsUrl }).promise;
for (const pno of [3, 4]) {
  const page = await doc.getPage(pno);
  const vp = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  console.log(`p${pno} ok:`, canvas.width, "x", canvas.height, Math.round(canvas.toBuffer("image/png").length / 1024), "KB");
  page.cleanup();
}
console.log("done");
