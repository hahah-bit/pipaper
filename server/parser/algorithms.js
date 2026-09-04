import { readNative, nativeInBox, validBox } from "./document.js";
import { fuseAlgorithmMath } from "./algorithm-math.js";

export const ALGORITHM_VERSION = 4;
export function nativeScriptCandidates(lines) {
  const candidates = [];
  for (const line of lines) {
    let group;
    const flush = () => {
      if (group?.raw.length > group?.base.length) candidates.push([group.raw, group.base + (group.low ? "_{" + group.low + "}" : "") + (group.high ? "^{" + group.high + "}" : "")]);
    };
    for (const token of [...line.items].sort((a, b) => a.seq - b.seq)) {
      const delta = token.bbox[3] - line.anchor.bbox[3];
      const script = token.height < line.anchor.height * 0.86 && Math.abs(delta) > 1;
      if (script && group) {
        const text = token.text.replace(/\s/g, "");
        group.raw += text;
        group[delta < 0 ? "high" : "low"] += text;
      } else {
        flush();
        const base = token.text.trim().match(/([\p{L}∇∑∏])$/u)?.[1];
        group = !script && base ? { base, raw: base, low: "", high: "" } : null;
      }
    }
    flush();
  }
  return candidates;
}
const union = (items) => [Math.min(...items.map((t) => t.bbox[0])), Math.min(...items.map((t) => t.bbox[1])), Math.max(...items.map((t) => t.bbox[2])), Math.max(...items.map((t) => t.bbox[3]))];
function join(items, baseline, scripts = false) {
  let out = "";
  let prev;
  for (const t of [...items].sort((a, b) => a.seq - b.seq)) {
    const text = t.text.trim();
    if (!text) continue;
    const script = scripts && t.height < baseline.height * 0.86 && Math.abs(t.bbox[3] - baseline.bbox[3]) > 1;
    const gap = prev ? t.bbox[0] - prev.bbox[2] : 0;
    if (script) out += (t.bbox[3] < baseline.bbox[3] ? "^{" : "_{") + text + "}";
    else {
      if (out && (gap > 1.6 || t.bbox[0] < (prev?.bbox[0] || 0) - 20) && !/^[,.;:)\]}]/.test(text)) out += " ";
      out += text;
    }
    prev = t;
  }
  return out;
}
export async function extractAlgorithmBlocks(pdfPath, log = () => {}, existingNative) {
  const native = existingNative || await readNative(pdfPath);
  const result = [];
  for (const page of native.pages) {
    const rows = [];
    for (const t of page.items) {
      let row = rows.find((r) => Math.abs(r.y - t.bbox[3]) < 2.5);
      if (!row) { row = { y: t.bbox[3], items: [] }; rows.push(row); }
      row.items.push(t);
    }
    const titles = rows.filter((r) => /^Algorithm\s*\d+\b/i.test(join(r.items, r.items[0]))).sort((a, b) => a.y - b.y);
    for (const title of titles) {
      const next = titles.find((t) => t.y > title.y + 3)?.y || page.height;
      const anchors = page.items.filter((t) => /^\d+:$/.test(t.text.trim()) && t.bbox[3] > title.y && t.bbox[3] < next).sort((a, b) => a.bbox[3] - b.bbox[3]);
      if (!anchors.length || anchors[0].text.trim() !== "1:") continue;
      const aligned = anchors.filter((a) => Math.abs(a.bbox[0] - anchors[0].bbox[0]) < 12);
      const end = rows.find((r) => r.y >= aligned[0].bbox[3] && r.y < next && /end\s+procedure/i.test(join(r.items, r.items[0])));
      if (!end) continue;
      const numbered = aligned.filter((a) => a.bbox[3] <= end.y + 3);
      if (numbered.some((a, i) => Number(a.text.trim().slice(0, -1)) !== i + 1)) continue;
      const endTokens = end.items.filter((t) => t.bbox[0] >= anchors[0].bbox[0] - 2);
      const region = union([...title.items, ...numbered, ...endTokens]);
      region[2] = Math.max(region[2], ...nativeInBox(page, [region[0], region[1], page.width, region[3]]).map((t) => t.bbox[2]));
      const lines = numbered.map((a, i) => {
        const nextSeq = numbered[i + 1]?.seq ?? Math.max(...endTokens.map((t) => t.seq)) + 1;
        const tokens = page.items.filter((t) => t.seq > a.seq && t.seq < nextSeq && t.bbox[0] >= region[0] - 2 && t.bbox[3] <= end.y + 3);
        const endAt = tokens.findIndex((t) => /end\s+procedure/i.test(t.text));
        const items = endAt >= 0 ? tokens.slice(0, endAt + 1) : tokens;
        return { number: i + 1, items, anchor: a, text: join(items, a, true), rawText: join(items, a) };
      });
      if (lines.some((l) => !l.text)) continue;
      const startX = Math.min(...lines.map((l) => l.items[0]?.bbox[0] ?? Infinity));
      const text = lines.map((l) => {
        const indent = Math.max(0, Math.min(12, Math.round(((l.items[0]?.bbox[0] || startX) - startX) / l.anchor.height)));
        return l.number + ": " + "  ".repeat(indent) + l.text;
      }).join("\n");
      const titleText = join(title.items, title.items[0]);
      const number = Number(titleText.match(/^Algorithm\s*(\d+)/i)[1]);
      result.push({ number, title: titleText, text, lines, page: page.page, bbox: region, titleBBox: union(title.items), codeBBox: union(lines.flatMap((l) => [l.anchor, ...l.items])), source: "pdfjs" });
      log("第 " + page.page + " 页 Algorithm " + number + "：" + lines.length + " 行");
    }
  }
  return result;
}
export function replaceAlgorithmBlocks(blocks, algorithms) {
  let result = structuredClone(blocks);
  for (const a of algorithms) {
    const inside = (b) => {
      if (b.page !== a.page || !validBox(b)) return false;
      const intersection = Math.max(0, Math.min(b.bbox[2], a.bbox[2]) - Math.max(b.bbox[0], a.bbox[0])) * Math.max(0, Math.min(b.bbox[3], a.bbox[3]) - Math.max(b.bbox[1], a.bbox[1]));
      return intersection / ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])) > 0.8;
    };
    const hits = result.map((b, i) => inside(b) ? i : -1).filter((i) => i >= 0);
    // A boundary that bisects prose is uncertain; retain the source candidate.
    if (!hits.length) continue;
    const first = hits[0];
    const sourceMath = hits.map((i) => result[i].text || result[i].md || "").join("\n");
    const nativeText = a.lines.map((l) => {
      const nativeLine = a.text.split("\n")[l.number - 1];
      const indent = nativeLine.match(/^\d+:([ ]*)/)?.[1] || " ";
      return l.number + ":" + indent + l.rawText;
    }).join("\n");
    const fused = fuseAlgorithmMath(nativeText, sourceMath, nativeScriptCandidates(a.lines));
    const provenance = { engine: "pdfjs", rawRef: "algorithms/" + a.number, replaced: hits.map((i) => result[i].provenance) };
    const replacement = [
      { type: "heading", level: 3, text: a.title, page: a.page, bbox: a.titleBBox, algorithm: true, provenance },
      { type: "code", lang: "text", text: fused.text, rawText: nativeText, page: a.page, bbox: a.codeBBox, algorithm: true, algorithmNumber: a.number, lineCount: a.lines.length, provenance: { ...provenance, mathSource: hits.map((i) => result[i].provenance), matchedMath: fused.matches }, issues: ["algorithm-math-review"] }
    ];
    result = result.flatMap((b, i) => i === first ? replacement : hits.includes(i) ? [] : [b]);
  }
  return result;
}
