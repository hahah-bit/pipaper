// Presentation for both current and already-published generations. The catalog
// remains untouched: legacy inline equations can be recognized by their caption.
export function formulaIsInline(part) {
  if (/\\tag\s*\{|\\begin\s*\{(?:align|equation|gather)/.test(part.latex || "")) return false;
  if (part.display != null) return !part.display;
  return part.inline === true || /^行内公式[：:]/.test(part.description || part.shortDescription || "");
}

function withoutGeneratedCaption(text, previous) {
  if (!previous) return text;
  const description = previous.description || previous.shortDescription;
  const caption = description && `（${description}）`;
  // Only remove the exact machine-generated caption; retain real annotations.
  return caption && text.startsWith(caption) ? text.slice(caption.length) : text;
}

export function knowledgeSegments(parts = []) {
  return parts.map((part, index) => part.type === "text"
    ? { ...part, text: withoutGeneratedCaption(part.text || "", parts[index - 1]) }
    : { ...part });
}

export function knowledgeMarkdown(parts = []) {
  return knowledgeSegments(parts).map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "formula") {
      const latex = (part.latex || "").trim();
      return formulaIsInline(part) ? `$${latex}$` : `\n\n$$\n${latex}\n$$\n\n`;
    }
    return `［${{image:"图",table:"表",code:"算法"}[part.type] || "附件"}证据见下］`;
  }).join("");
}

export function standaloneEvidence(parts = []) {
  return parts.filter(part => part.type !== "text" && !(part.type === "formula" && formulaIsInline(part)));
}
