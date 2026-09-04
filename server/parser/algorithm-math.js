import katex from "katex";
import { DOMParser } from "@xmldom/xmldom";
import { inlineContent } from "./document.js";

// Restore notation only when the native glyph sequence agrees with a math
// subtree from the independent structured source. No paper-specific variables.
export function fuseAlgorithmMath(nativeText, sourceText, nativeCandidates = []) {
  const candidates = new Map();
  const add = (raw, code) => {
    if (!raw || raw.length < 2) return;
    if (!candidates.has(raw)) candidates.set(raw, code);
    else if (candidates.get(raw) !== code) candidates.set(raw, null);
  };
  const visit = (node) => {
    if (node.nodeType === 3) return { code: node.data.trim(), flat: node.data.replace(/\s/g, "") };
    if (node.nodeType !== 1 || ["annotation", "mspace"].includes(node.localName)) return { code: "", flat: "" };
    const parts = Array.from(node.childNodes).filter((n) => n.nodeType === 1 || n.nodeType === 3).map(visit).filter((p) => p.code);
    const [base, low, high] = parts;
    if (["mi", "mn", "mo", "mtext"].includes(node.localName)) return { code: node.textContent.replace(/\s/g, ""), flat: node.textContent.replace(/\s/g, "") };
    let code;
    if (base && low && ["msub", "munder"].includes(node.localName)) code = base.code + "_{" + low.code + "}";
    if (base && low && ["msup", "mover"].includes(node.localName)) code = base.code + "^{" + low.code + "}";
    if (base && low && high && ["msubsup", "munderover"].includes(node.localName)) {
      code = base.code + "_{" + low.code + "}^{" + high.code + "}";
      add(base.flat + high.flat + low.flat, code);
    }
    if (base && low && node.localName === "mfrac") code = "(" + base.code + ")/(" + low.code + ")";
    const flat = parts.map((p) => p.flat).join("");
    // A punctuation mark at the end of a script is typically an OCR boundary
    // error, not part of the index. Keep the native candidate in that case.
    if (code && !(low && /[,;:]$/.test(low.code))) add(flat, code);
    return { code: code || parts.map((p) => p.code).join(""), flat };
  };
  for (const math of inlineContent(sourceText).filter((s) => s.type === "math")) {
    try {
      const xml = katex.renderToString(math.latex, { output: "mathml", displayMode: true, throwOnError: true, strict: "ignore", trust: false });
      visit(new DOMParser().parseFromString(xml, "text/xml").documentElement);
    } catch {}
  }
  for (const [raw, code] of nativeCandidates) if (!candidates.has(raw)) candidates.set(raw, code);
  const choices = [...candidates].filter(([, value]) => value).sort((a, b) => b[0].length - a[0].length);
  if (!choices.length) return { text: nativeText, matches: 0 };
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(choices.map(([raw]) =>
    (/^[A-Za-z0-9]/.test(raw) ? "(?<![A-Za-z0-9])" : "") +
    Array.from(raw).map(escape).join("[ \\t]*") +
    (/[A-Za-z0-9]$/.test(raw) ? "(?![A-Za-z0-9])" : "")
  ).join("|"), "gu");
  let matches = 0;
  const text = nativeText.replace(pattern, (part) => {
    const value = candidates.get(part.replace(/[ \t]/g, ""));
    if (!value) return part;
    matches++;
    return value;
  });
  return { text, matches };
}
