import { createHash } from "node:crypto";
import { inlineContent } from "../parser/document.js";
import { tableStructure } from "../parser/tables.js";
import { missingTableNumbers, missingGlyphs } from "../parser/evidence.js";
import katex from "katex";
import { marked } from "marked";

const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
export const textOf = (b) => b.md || b.text || b.caption || b.latex || "";
const kindOf = (b) =>
  ({
    image: "image",
    table: "table",
    formula: "formula",
    code: "code",
    page_footnote: "note",
    footnote: "note",
    reference: "reference",
  })[b.type] || "text";
const chrome = new Set([
  "header",
  "footer",
  "page_number",
  "page-header",
  "page-footer",
]);
const marker = /\[\[(image|table|formula|code):([^\]]+)\]\]/g;
export const placeholder = (e) =>
  `[[${e.kind}:${e.id}]]（${e.shortDescription || e.caption || `${e.kind} ${e.label || ""}`}）`;
export function validateCandidate(original, candidate) {
  const issues = [];
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !["text", "image", "table", "formula", "code", "note"].includes(
      candidate.kind,
    )
  )
    return ["invalid-candidate"];
  if (candidate.uncertain === true) issues.push("model-uncertain");
  if (candidate.uncertain !== false && !candidate.humanVerified)
    issues.push("uncertainty-unspecified");
  if (
    original.issues?.some((issue) =>
      ["missing-page", "missing-box", "box-outside-page"].includes(issue),
    )
  )
    issues.push("source-location-unverified");
  if (candidate.kind === "table") {
    try {
      if (!candidate.html?.includes("<table")) throw new Error();
      const table = tableStructure(candidate.html);
      issues.push(...table.issues);
      if (original.nativeText) {
        if (missingTableNumbers(table.cells, original.nativeText).length)
          issues.push("table-numeric-mismatch");
      }
    } catch {
      issues.push("table-invalid-html");
    }
  }
  if (candidate.kind === "formula") {
    try {
      katex.renderToString(candidate.latex || "", {
        throwOnError: true,
        trust: false,
        strict: "ignore",
      });
    } catch {
      issues.push("formula-syntax");
    }
    if (
      original.nativeText &&
      missingGlyphs(candidate.latex || "", original.nativeText).length &&
      !candidate.humanVerified
    )
      issues.push("math-source-conflict");
  }
  if (
    ["text", "code", "note"].includes(candidate.kind) &&
    !String(candidate.text || "").trim()
  )
    issues.push("empty-candidate");
  if (
    ["image", "table", "formula"].includes(candidate.kind) &&
    !candidate.shortDescription?.trim()
  )
    issues.push("missing-description");
  return [...new Set(issues)];
}
function labels(text, kind) {
  const prefix = {
    image: "(?:Figures?|Figs?\\.?|图)",
    table: "(?:Tables?|Tabs?\\.?|表)",
    formula: "(?:Equations?|Eqs?\\.?|式|公式)",
    code: "(?:Algorithms?|算法)",
  }[kind];
  const match = String(text || "").match(
    new RegExp(
      `${prefix}\\s*[:：]?\\s*\\(?([A-Za-z]?\\d+(?:\\.\\d+)*)([a-z])?\\)?`,
      "i",
    ),
  );
  return match
    ? { label: match[1].toLowerCase(), subfigure: match[2] || null }
    : {};
}
export function references(text) {
  const out = [],
    token =
      "\\(?[A-Za-z]?\\d+(?:\\.\\d+)*(?:[a-z](?![A-Za-z])|\\s*\\([a-z]\\))?\\)?";
  const separator =
    "(?:\\s*[-–~至,，、&]\\s*|\\s+(?:and|to)\\s+|\\s*[和及]\\s*)";
  const prefixes = {
    image: "(?:Figures?|Figs?\\.?|图)",
    table: "(?:Tables?|Tabs?\\.?|表)",
    formula: "(?:Equations?|Eqs?\\.?|公式|式)",
    code: "(?:Algorithms?|算法)",
  };
  for (const [kind, prefix] of Object.entries(prefixes))
    for (const m of String(text).matchAll(
      new RegExp(`${prefix}\\s*(${token}(?:${separator}${token})*)`, "gi"),
    )) {
      const numbers = [...m[1].matchAll(new RegExp(token, "gi"))];
      let previous;
      for (const n of numbers) {
        const value = n[0].replace(/^\(|\)$/g, "").trim(),
          parsed = value.match(
            /^([A-Za-z]?\d+(?:\.\d+)*)(?:\s*\(?([a-z])\)?)?$/i,
          );
        if (!parsed) continue;
        const label = parsed[1].toLowerCase(),
          between = previous ? m[1].slice(previous.end, n.index) : "";
        if (
          previous &&
          /[-–~至]|\bto\b/i.test(between) &&
          /^\d+$/.test(previous.label) &&
          /^\d+$/.test(label) &&
          Number(label) > Number(previous.label) &&
          Number(label) - Number(previous.label) <= 30
        )
          for (let i = Number(previous.label) + 1; i <= Number(label); i++)
            out.push({ kind, label: String(i), at: m.index + m[0].length });
        else
          out.push({
            kind,
            label,
            subfigure: parsed[2] || null,
            at: m.index + m[0].length,
          });
        previous = { label, end: n.index + n[0].length };
      }
    }
  return out;
}
export function normalizeDocument(
  document,
  { resourceId, versionId, generationId, repairs = {} },
) {
  const source = Array.isArray(document) ? document : document.blocks || [];
  const sections = [
    {
      id: "root",
      parentId: null,
      level: 0,
      title: document.meta?.title || "文档",
      path: [],
    },
  ];
  const elements = [],
    texts = [],
    reviews = [],
    dropped = [],
    stack = [];
  const repeated = new Map();
  for (const b of source) {
    const text = textOf(b).trim();
    if (text && (b.bbox?.[1] < 45 || b.type === "footer")) {
      const pages = repeated.get(text) || new Set();
      pages.add(b.page);
      repeated.set(text, pages);
    }
  }
  for (const [i, original] of source.entries()) {
    const b = structuredClone(original),
      blockId = b.id || `legacy_${i}`;
    if (b.type === "table" && !b.html && b.md?.trim().startsWith("|"))
      b.html = marked.parse(b.md);
    const repair = repairs[blockId],
      candidateIssues = repair ? validateCandidate(b, repair) : [];
    if (repair?.discard && repair.humanVerified) {
      dropped.push({ blockId, reason: "human-discard" });
      continue;
    }
    const kind = kindOf(b),
      sourceText = textOf(b).trim();
    if (
      chrome.has(b.type) ||
      repeated.get(sourceText)?.size >= 3 ||
      (/^\s*\d+\s*$/.test(sourceText) && b.type === "footer")
    ) {
      dropped.push({ blockId, reason: "page-chrome" });
      continue;
    }
    if (b.type === "heading") {
      const level = Math.max(1, Number(b.level) || 1);
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      const node = {
        id: "s_" + hash([resourceId, versionId, blockId]),
        parentId: stack.at(-1)?.id || "root",
        level,
        title: b.text || b.md || "",
        page: b.page,
        blockId,
      };
      node.path = [...stack.map((s) => s.title), node.title];
      stack.push(node);
      sections.push(node);
      continue;
    }
    const section = stack.at(-1) || sections[0];
    const issues = [...(b.issues || []), ...candidateIssues];
    const accepted = repair && !candidateIssues.length;
    const finalKind = accepted
      ? repair.kind
      : kind === "text" &&
          section.path.some((title) =>
            /^(references|bibliography|参考文献)\s*$/i.test(title),
          )
        ? "reference"
        : kind;
    const origin = {
      blockId,
      page: b.page || null,
      bbox: b.bbox || null,
      assetId: repair?.assetId || b.assetId || null,
      order: i,
      sectionId: section.id,
      sectionPath: section.path,
      resourceId,
      versionId,
    };
    const importantIssues = issues.filter(
      (x) => !["no-text-layer", "algorithm-math-review"].includes(x),
    );
    const pending = Boolean(
      accepted ? repair.uncertain : importantIssues.length,
    );
    if (accepted) issues.length = 0;
    if (finalKind === "text") {
      const text = accepted ? repair.text : sourceText;
      const row = {
        id: "t_" + hash([generationId, blockId]),
        kind: "text",
        text,
        ...origin,
        references: repair?.humanVerified ? repair.references : null,
        issues,
        quality: pending ? "needs_review" : "ready",
      };
      if (text) texts.push(row);
      if (pending || !text)
        reviews.push({
          id: row.id,
          ...origin,
          issues: issues.length ? issues : ["empty-text"],
          candidate: repair || null,
        });
      // Inline math is searchable in the original prose and listed separately.
      for (const [j, math] of inlineContent(text)
        .filter((p) => p.type === "math")
        .entries())
        elements.push({
          id: "e_" + hash([generationId, blockId, j]),
          kind: "formula",
          latex: math.latex,
          inline: true,
          shortDescription: `行内公式：${math.latex}`,
          ...origin,
          quality: row.quality,
          issues,
        });
      continue;
    }
    const labelInfo = labels(b.caption || sourceText || b.latex, finalKind);
    if (finalKind === "formula" && !labelInfo.label)
      labelInfo.label = b.latex?.match(/\\tag\{([^}]+)\}/)?.[1] || null;
    const element = {
      id: "e_" + hash([generationId, blockId]),
      kind: finalKind,
      ...origin,
      ...labelInfo,
      caption: b.caption || "",
      src: b.src || b.sourceImage || null,
      text: accepted ? repair.text || "" : b.text || b.md || "",
      html: accepted ? repair.html || "" : b.html || "",
      latex: accepted ? repair.latex || "" : b.latex || "",
      shortDescription:
        repair?.shortDescription ||
        b.shortDescription ||
        b.caption ||
        (finalKind === "formula"
          ? `公式 ${labelInfo.label || ""}：${b.latex || ""}`
          : `${finalKind} ${labelInfo.label || ""}`),
      description: repair?.description || b.description || b.caption || "",
      candidate: repair || null,
      issues,
      quality: pending ? "needs_review" : "ready",
      assetId: repair?.assetId || b.assetId || null,
    };
    if (finalKind === "image" && !repair?.shortDescription && !b.description) {
      element.quality = "needs_review";
      element.issues = [...issues, "missing-visual-description"];
    }
    elements.push(element);
    if (element.quality !== "ready") reviews.push({ ...element });
  }
  // Notes are attached to their explicit marker, with positional evidence only as fallback.
  for (const note of elements.filter((e) => e.kind === "note")) {
    if (note.quality !== "ready") continue;
    const number = note.text.match(/^\s*(\d+|[*†‡])\s*/)?.[1];
    const matches = number
      ? texts.filter(
          (t) =>
            t.page === note.page &&
            (t.text.includes(`[^${number}]`) ||
              t.text.includes(`<sup>${number}</sup>`)),
        )
      : [];
    const parent =
      matches.length === 1
        ? matches[0]
        : texts
            .filter((t) => t.page === note.page && t.order < note.order)
            .at(-1);
    if (parent) {
      const annotation = `（注：${note.text}）`;
      if (matches.length === 1)
        parent.text = parent.text
          .replace(`[^${number}]`, annotation)
          .replace(`<sup>${number}</sup>`, annotation);
      else parent.text += annotation;
    } else {
      note.quality = "needs_review";
      reviews.push({ ...note, issues: ["unresolved-note"] });
    }
  }
  for (const t of texts) {
    const insertions = [],
      used = new Set();
    for (const ref of references(t.text)) {
      let matches = elements.filter(
        (e) => e.kind === ref.kind && e.label === ref.label && !e.inline,
      );
      const binding =
        t.references?.[`${ref.kind}:${ref.label}${ref.subfigure || ""}`];
      if (binding) matches = matches.filter((e) => e.blockId === binding);
      else if (ref.subfigure) {
        const exact = matches.filter((e) => e.subfigure === ref.subfigure);
        matches = exact.length ? exact : matches.filter((e) => !e.subfigure);
      }
      if (matches.length !== 1) {
        reviews.push({
          id: "ref_" + hash([t.id, ref]),
          ...t,
          ...ref,
          issues: [
            matches.length ? "ambiguous-reference" : "missing-reference",
          ],
        });
        t.quality = "needs_review";
        continue;
      }
      const e = matches[0];
      if (used.has(e.id)) continue;
      used.add(e.id);
      if (e.quality !== "ready") {
        t.quality = "needs_review";
        continue;
      }
      insertions.push({ at: ref.at, text: placeholder(e), id: e.id });
    }
    for (const add of insertions.sort((a, b) => b.at - a.at))
      t.text = t.text.slice(0, add.at) + add.text + t.text.slice(add.at);
    const inline = elements.filter((e) => e.inline && e.blockId === t.blockId);
    let mathIndex = 0;
    t.text = t.text.replace(
      /\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\n])+\$/g,
      (match) => {
        const e = inline[mathIndex++];
        if (!e) return match;
        used.add(e.id);
        return placeholder(e);
      },
    );
    t.elementIds = [...used];
    t.modalities = [
      ...new Set([
        "text",
        ...elements.filter((e) => used.has(e.id)).map((e) => e.kind),
        ...(inlineContent(t.text).some((p) => p.type === "math")
          ? ["formula"]
          : []),
      ]),
    ];
  }
  // Unreferenced elements stay accessible at their original location.
  const referenced = new Set(texts.flatMap((t) => t.elementIds || []));
  const body = [
    ...texts,
    ...elements
      .filter(
        (e) =>
          !e.inline &&
          !referenced.has(e.id) &&
          ["image", "table", "formula", "code"].includes(e.kind),
      )
      .map((e) => ({
        ...e,
        text: placeholder(e),
        elementIds: [e.id],
        modalities: ["text", e.kind],
      })),
  ].sort((a, b) => a.order - b.order);
  return {
    resourceId,
    versionId,
    generationId,
    sections,
    texts,
    elements,
    body,
    reviews,
    dropped,
  };
}
const bytes = (s) => Buffer.byteLength(s, "utf8");
function units(text) {
  const atomic =
    /\[\[(?:image|table|formula|code):[^\]]+\]\]（[^）]*）|\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$\n])+\$|```[\s\S]*?```/g;
  const out = [];
  let at = 0;
  const plain = (s) =>
    out.push(...(s.match(/[^\n。！？.!?]+[。！？.!?]?|[\n。！？.!?]/gu) || []));
  for (const m of String(text).matchAll(atomic)) {
    plain(text.slice(at, m.index));
    out.push(m[0]);
    at = m.index + m[0].length;
  }
  plain(text.slice(at));
  return out;
}
function splitText(text, max) {
  const result = [];
  let current = "";
  for (const unit of units(text)) {
    if (bytes(current + unit) <= max) {
      current += unit;
      continue;
    }
    if (current) result.push(current);
    current = "";
    if (bytes(unit) > max && !/^\[\[|^\$|^```/.test(unit)) {
      for (const char of unit) {
        if (bytes(current + char) > max) {
          result.push(current);
          current = "";
        }
        current += char;
      }
    } else current = unit;
  }
  if (current) result.push(current);
  return result;
}
export function chunkDocument(doc, options = {}) {
  const cfg = {
    targetBytes: 4500,
    maxBytes: 6000,
    overlapBytes: 300,
    ...options,
  };
  if (
    cfg.maxBytes < 256 ||
    cfg.targetBytes > cfg.maxBytes ||
    cfg.overlapBytes >= cfg.maxBytes
  )
    throw new Error("分块预算无效");
  const chunks = [];
  let items = [],
    text = "",
    sectionId = null;
  function flush() {
    if (!text.trim()) {
      items = [];
      text = "";
      return;
    }
    const section = doc.sections.find((s) => s.id === sectionId);
    const elementIds = [
      ...new Set([...text.matchAll(marker)].map((m) => m[2])),
    ];
    const id = "c_" + hash([doc.generationId, sectionId, chunks.length, text]);
    chunks.push({
      id,
      kind: "chunk",
      resourceId: doc.resourceId,
      versionId: doc.versionId,
      sectionId,
      sectionPath: section?.path || [],
      title: section?.title || "",
      text: text.trim(),
      blockIds: [...new Set(items.map((i) => i.blockId))],
      pages: [...new Set(items.map((i) => i.page).filter(Boolean))],
      elementIds,
      modalities: [
        ...new Set([
          "text",
          ...doc.elements
            .filter((e) => elementIds.includes(e.id))
            .map((e) => e.kind),
          ...items.flatMap((i) => i.modalities || []),
        ]),
      ],
      order: chunks.length,
    });
    items = [];
    text = "";
  }
  for (const row of doc.body.filter(
    (r) => r.quality === "ready" && !["note", "reference"].includes(r.kind),
  )) {
    if (sectionId !== row.sectionId) {
      flush();
      sectionId = row.sectionId;
    }
    const titleBudget =
      bytes(
        doc.sections.find((s) => s.id === sectionId)?.path.join(" > ") || "",
      ) + 16;
    const available = cfg.maxBytes - titleBudget;
    if (available < 128) throw new Error("标题路径超过分块预算");
    for (const part of splitText(row.text, available)) {
      if (bytes(part) > available) {
        doc.reviews.push({
          id: "oversize_" + row.id,
          blockId: row.blockId,
          issues: ["atomic-content-too-large"],
        });
        continue;
      }
      if (
        text &&
        (bytes(text + "\n\n" + part) > available ||
          bytes(text) >= cfg.targetBytes)
      ) {
        const overlap =
          units(text)
            .reverse()
            .find((s) => bytes(s) <= cfg.overlapBytes && !s.includes("[[")) ||
          "";
        flush();
        if (overlap && bytes(overlap + "\n\n" + part) <= available)
          text = overlap;
      }
      text += (text ? "\n\n" : "") + part;
      items.push(row);
    }
  }
  flush();
  return chunks;
}
export function hydrate(
  chunk,
  elements,
  { loadImage = () => null, imageBudget = 12 * 1024 * 1024 } = {},
) {
  const parts = [];
  let at = 0,
    usedBytes = 0;
  for (const m of chunk.text.matchAll(marker)) {
    if (m.index > at)
      parts.push({ type: "text", text: chunk.text.slice(at, m.index) });
    const e = elements.find((e) => e.id === m[2]);
    if (!e) throw new Error("占位符对应的元素缺失：" + m[2]);
    const part = {
      type: e.kind,
      elementId: e.id,
      description: e.shortDescription,
      page: e.page,
      versionId: e.versionId,
    };
    if (e.kind === "image") {
      const image = loadImage(e);
      if (
        image &&
        usedBytes + Buffer.byteLength(image.data, "base64") <= imageBudget
      ) {
        Object.assign(part, image);
        usedBytes += Buffer.byteLength(image.data, "base64");
      } else part.pending = true;
    } else if (e.kind === "table") part.html = e.html;
    else if (e.kind === "formula") part.latex = e.latex;
    else part.text = e.text;
    parts.push(part);
    at = m.index + m[0].length;
  }
  if (at < chunk.text.length)
    parts.push({ type: "text", text: chunk.text.slice(at) });
  return parts;
}
