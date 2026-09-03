import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");

fs.mkdirSync(path.join(PUB, "vendor"), { recursive: true });

// copy static vendor assets (katex css+fonts, pdf.js worker)
const katexSrc = path.join(ROOT, "node_modules", "katex", "dist");
const katexDst = path.join(PUB, "vendor", "katex");
fs.rmSync(katexDst, { recursive: true, force: true });
fs.cpSync(katexSrc, katexDst, { recursive: true });

const workerSrc = path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
fs.copyFileSync(workerSrc, path.join(PUB, "vendor", "pdf.worker.min.mjs"));

await esbuild.build({
  entryPoints: [path.join(ROOT, "src", "app.js")],
  bundle: true,
  outfile: path.join(PUB, "app.js"),
  format: "iife",
  target: "es2022",
  minify: false,
  sourcemap: true,
  logLevel: "info",
});

console.log("build ok");
