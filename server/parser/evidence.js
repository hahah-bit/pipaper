import katex from "katex";
import { DOMParser } from "@xmldom/xmldom";

const normalize = (value) => String(value).normalize("NFKC").replace(/[−–]/g, "-").replace(/[⋅·]/g, ".").replace(/∣/g, "|").replace(/∗/g, "*").replace(/[‘’′]/g, "'").replace(/[\s\u2061-\u2064\u200b]/g, "");
export function mathGlyphs(latex) {
  // Equation numbers often have a separate source box; do not compare them
  // with the equation-body region. The stored LaTeX remains unchanged.
  const html = katex.renderToString(latex.replace(/\\tag\*?\s*\{[^{}]*\}/g, ""), { output: "mathml", displayMode: true, throwOnError: true, strict: "ignore", trust: false });
  const doc = new DOMParser().parseFromString(html, "text/xml");
  for (const node of Array.from(doc.getElementsByTagName("annotation"))) node.parentNode.removeChild(node);
  return normalize(doc.documentElement.textContent);
}
export function missingGlyphs(latex, nativeText) {
  const available = new Map();
  for (const char of normalize(nativeText)) available.set(char, (available.get(char) || 0) + 1);
  const missing = [];
  for (const char of mathGlyphs(latex)) {
    if (available.get(char)) available.set(char, available.get(char) - 1);
    else missing.push(char);
  }
  return missing;
}
export function missingTableNumbers(cells, nativeText) {
  const numbers = (text) => text.match(/\d+\.\d+/g) || [];
  const actual = numbers(cells.map((c) => c.text).join(" "));
  const counts = new Map();
  for (const n of actual) counts.set(n, (counts.get(n) || 0) + 1);
  return numbers(nativeText).filter((n) => {
    if (counts.get(n)) { counts.set(n, counts.get(n) - 1); return false; }
    return true;
  });
}
