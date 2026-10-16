import { el } from "./platform/dom.js";
import { renderMd } from "./platform/markdown.js";
import { formulaIsInline, knowledgeSegments } from "../shared/knowledge-content.js";

export function renderKnowledgeSnippet(parts, container, metadata, selection, findElement) {
  const links = [];
  const markdown = knowledgeSegments(parts).map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "formula" && formulaIsInline(part)) return `$${part.latex || ""}$`;
    const index = links.push(part) - 1;
    return ` KNOWLEDGEEVIDENCE${index}END `;
  }).join("");
  renderMd(markdown, container);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!/KNOWLEDGEEVIDENCE\d+END/.test(node.nodeValue)) continue;
    const fragment = document.createDocumentFragment(); let cursor = 0;
    node.nodeValue.replace(/KNOWLEDGEEVIDENCE(\d+)END/g, (token, index, offset) => {
      fragment.append(document.createTextNode(node.nodeValue.slice(cursor, offset)));
      const part = links[Number(index)];
      const name = { image: "图", table: "表", formula: "公式", code: "算法" }[part.type] || "附件";
      const link = el("span", { class: "knowledge-placeholder", role: "link", tabindex: "0",
        "data-element-id": part.elementId || part.id }, `［${name}${part.label ? " " + part.label : ""}证据见下］`);
      const activate = () => {
        const target = findElement?.(part);
        if (!target) return;
        for (let parent = target.parentElement; parent; parent = parent.parentElement)
          if (parent.tagName === "DETAILS") parent.open = true;
        target.scrollIntoView({ behavior: "smooth", block: "center" }); target.focus({ preventScroll: true });
      };
      link.addEventListener("click", activate);
      link.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); } });
      fragment.append(link);
      if (part.type !== "formula" && part.description) fragment.append(document.createTextNode(`（${part.description}）`));
      cursor = offset + token.length; return token;
    });
    fragment.append(document.createTextNode(node.nodeValue.slice(cursor))); node.replaceWith(fragment);
  }
  // A translation unfolds directly underneath the selected paragraph/list,
  // rather than at the bottom of an entire retrieval card.
  for (const child of [...container.children]) {
    const wrapper = el("div", { class: "knowledge-text-block" });
    child.replaceWith(wrapper);
    const source = el("div", { class: "knowledge-block-source" }, child);
    wrapper.append(source); selection?.register(source, metadata);
  }
}
