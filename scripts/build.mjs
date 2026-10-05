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

// cache-bust: stamp bundle/css versions into index.html
await esbuild.build({ entryPoints: [path.join(ROOT, "src", "study", "app.js")], bundle: true,
  outfile: path.join(PUB, "study.js"), format: "iife", target: "es2022", sourcemap: true, logLevel: "info" });
const js = fs.readFileSync(path.join(PUB, "app.js"));
await esbuild.build({ entryPoints: [path.join(ROOT, "src", "topics", "app.js")], bundle: true,
  outfile: path.join(PUB, "topics.js"), format: "iife", target: "es2022", sourcemap: true, logLevel: "info" });
const themeCss = fs.readFileSync(path.join(PUB, "theme.css"));
const topicVersion = crypto.createHash("sha1").update(fs.readFileSync(path.join(PUB, "topics.js"))).update(fs.readFileSync(path.join(PUB, "topics.css"))).update(themeCss).digest("hex").slice(0, 10);
const topicHtml = path.join(PUB, "topics.html");
fs.writeFileSync(topicHtml, fs.readFileSync(topicHtml, "utf8").replace(/topics\.(js|css)(\?v=[a-f0-9]+)?"/g, (_m, ext) => `topics.${ext}?v=${topicVersion}"`).replace(/theme\.css(\?v=[a-f0-9]+)?"/, `theme.css?v=${topicVersion}"`));
const css = fs.readFileSync(path.join(PUB, "style.css"));
const v = crypto.createHash("sha1").update(js).update(css).update(themeCss).digest("hex").slice(0, 10);
const htmlPath = path.join(PUB, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
const jsRe = new RegExp('app[.]js([?]v=[a-f0-9]+)?' + String.fromCharCode(34));
const cssRe = new RegExp('style[.]css([?]v=[a-f0-9]+)?' + String.fromCharCode(34));
html = html.replace(jsRe, 'app.js?v=' + v + '"');
html = html.replace(cssRe, 'style.css?v=' + v + '"');
html = html.replace(/theme\.css(\?v=[a-f0-9]+)?"/, 'theme.css?v=' + v + '"');
fs.writeFileSync(htmlPath, html);

console.log("build ok (v=" + v + ")");
