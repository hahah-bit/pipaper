import crypto from "node:crypto";
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

// cache-bust: stamp bundle/css versions into index.html
const js = fs.readFileSync(path.join(PUB, "app.js"));
const css = fs.readFileSync(path.join(PUB, "style.css"));
const v = crypto.createHash("sha1").update(js).update(css).digest("hex").slice(0, 10);
const htmlPath = path.join(PUB, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
const jsRe = new RegExp('app[.]js([?]v=[a-f0-9]+)?' + String.fromCharCode(34));
const cssRe = new RegExp('style[.]css([?]v=[a-f0-9]+)?' + String.fromCharCode(34));
html = html.replace(jsRe, 'app.js?v=' + v + '"');
html = html.replace(cssRe, 'style.css?v=' + v + '"');
fs.writeFileSync(htmlPath, html);

console.log("build ok (v=" + v + ")");
