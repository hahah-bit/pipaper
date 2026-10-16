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

// dockview-core 8.3 的 esm 入口是无样式构建：从 styled iife 提取内嵌 CSS 到 vendor
await import(new URL("extract-dockview-css.mjs", import.meta.url).href);

// mermaid: 打成懒加载的全局包（流程图模块首次使用时注入 <script>），不进主 bundle
await esbuild.build({
  entryPoints: [path.join(ROOT, "scripts", "mermaid-entry.mjs")],
  bundle: true,
  outfile: path.join(PUB, "vendor", "mermaid.min.js"),
  format: "iife",
  target: "es2022",
  minify: true,
  logLevel: "silent",
});

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

for (const entry of ["study", "topics"]) await esbuild.build({
  entryPoints: [path.join(ROOT, "src", entry, "app.js")], bundle: true,
  outfile: path.join(PUB, entry + ".js"), format: "iife", target: "es2022", sourcemap: true, logLevel: "info",
});

// Each page includes every shared style it consumes in its cache fingerprint.
for (const [page, assets] of Object.entries({
  index: ["app.js", "style.css", "theme.css"],
  study: ["study.js", "style.css", "study.css", "theme.css"],
  topics: ["topics.js", "topics.css", "theme.css"],
})) {
  const hash = crypto.createHash("sha1");
  for (const asset of assets) hash.update(fs.readFileSync(path.join(PUB, asset)));
  const version = hash.digest("hex").slice(0, 10);
  const htmlPath = path.join(PUB, page + ".html");
  let html = fs.readFileSync(htmlPath, "utf8");
  for (const asset of assets) {
    const escaped = asset.replace(/[.]/g, "[.]");
    html = html.replace(new RegExp(escaped + '([?]v=[a-f0-9]+)?"', "g"), asset + '?v=' + version + '"');
  }
  fs.writeFileSync(htmlPath, html);
  console.log(page + " build ok (v=" + version + ")");
}
