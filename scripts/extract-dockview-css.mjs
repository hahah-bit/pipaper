// 从 dockview-core 的 styled iife 构建里提取内嵌 CSS（8.3.1 的 esm 入口是无样式构建），
// 落盘 public/vendor/dockview.css 供 index.html 引入。升级 dockview 后需重跑。
import fs from "node:fs";

const src = fs.readFileSync("node_modules/dockview-core/dist/dockview-core.js", "utf8");
const anchor = src.indexOf(".dv-root");
if (anchor < 0) throw new Error("anchor .dv-root not found");

const QUOTE = '"', BSLASH = "\\";
let start = -1;
for (let i = anchor; i >= 0; i--) {
  if (src[i] === QUOTE && src[i - 1] !== BSLASH) { start = i; break; }
}
let end = -1;
for (let i = start + 1; i < src.length; i++) {
  if (src[i] === QUOTE && src[i - 1] !== BSLASH) { end = i; break; }
}
const raw = src.slice(start + 1, end);
const css = raw
  .replaceAll("\\n", "\n")
  .replaceAll("\\t", "  ")
  .replaceAll('\\"', '"')
  .replaceAll("\\\\", "\\");
fs.writeFileSync("public/vendor/dockview.css", css);
console.log("css bytes:", css.length, "| rules:", (css.match(/\{/g) || []).length);
console.log("has tabs flex:", css.includes(".dv-tabs-container") && css.includes("display: flex"));
