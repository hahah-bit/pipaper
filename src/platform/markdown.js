import { marked } from "marked";
import DOMPurify from "dompurify";
import renderMathInElement from "katex/contrib/auto-render";
// ---------------- markdown / math rendering ----------------
marked.setOptions({ gfm: true, breaks: false });

export function renderMd(mdText, container) {
  const { text, math } = protectMath(mdText || "");
  const html = marked.parse(text);
  container.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  restoreMath(container, math);
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
    });
  } catch {}
}

// Markdown treats underscores and dollar signs as formatting before KaTeX can
// see them. Replace complete math spans with inert ASCII tokens, then restore
// them as text nodes so the math renderer receives the original delimiters.
// MinerU 提取的 LaTeX 常把相邻单字符用空格隔开（"$4 \times 1 0 ^ { - 4 }$"、
// "\mathrm { F i x e d }"），KaTeX 渲染出来符号散开；数学模式里单字符链的空格
// 是冗余的（a b 与 ab 输出一致），这里统一收拢。命令名（\log x）前后的空格不动。
function tightenMathSpaces(token) {
  return String(token).replace(/(?<![A-Za-z0-9\\])((?:[A-Za-z0-9] )+[A-Za-z0-9])(?![A-Za-z0-9])/g, (chain) => chain.replace(/ /g, ""));
}

function protectMath(source) {
  const math = [];
  const text = String(source || "").replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+(?<!\\)\$)/g, (part) => {
    const i = math.push(tightenMathSpaces(part)) - 1;
    return `MATHTOKEN${i}END`;
  });
  return { text, math };
}

function restoreMath(container, math) {
  if (!math.length) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const value = node.nodeValue || "";
    if (!/MATHTOKEN\d+END/.test(value)) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    value.replace(/MATHTOKEN(\d+)END/g, (token, index, offset) => {
      frag.append(document.createTextNode(value.slice(cursor, offset)));
      frag.append(document.createTextNode(math[Number(index)] || token));
      cursor = offset + token.length;
      return token;
    });
    frag.append(document.createTextNode(value.slice(cursor)));
    node.replaceWith(frag);
  }
}
