// Prompt templates for selections / box annotations. Stored in localStorage,
// editable from the annotation popup (⚙) — defaults provided below.
// Placeholder {{选区}} is replaced with the selected region content;
// {{批注}} with the user's note. Missing placeholders get context appended.

const LS_KEY = "pipaper.templates";

export const DEFAULT_TEMPLATES = [
  { name: "解释所选", content: "请解释选区（截图）中的内容，结合论文上下文说明它的含义与作用。\n\n{{选区}}" },
  { name: "翻译选区", content: "请把选区中的英文内容翻译成中文，保留专业术语的英文原词。\n\n{{选区}}" },
  { name: "总结要点", content: "请总结选区内容的要点，用不超过 5 条列出。\n\n{{选区}}" },
  { name: "公式推导", content: "请逐步推导并解释选区中的公式，说明每一项的含义。\n\n{{选区}}" },
  { name: "审稿视角", content: "请以审稿人视角评价选区内容：方法是否合理、论证是否充分、有何改进建议。\n\n{{选区}}" },
  {
    name: "分析图片",
    content:
      "你是论文图表解读专家。请结合附图（框选原图）分析这张论文插图：\n" +
      "1. 它展示的流程/框架是什么？各模块如何衔接；\n" +
      "2. 图中的专业数据、符号、坐标轴分别代表什么；\n" +
      "3. 这张图在论文中承担什么论证任务（想证明/说明什么）。\n" +
      "回答用中文，结构化分点。\n\n选区内容：\n{{选区}}",
  },
  {
    name: "分析表格",
    content:
      "你是论文实验表格解读专家。请结合原表格（见附表）分析：\n" +
      "1. 行列结构与实验设置是怎么设计的（变量、对照、评价指标）；\n" +
      "2. 数据反映的趋势与关键数值对比（指出最优/最差的行）；\n" +
      "3. 能得出什么结论？实验是怎么做的？有何局限。\n" +
      "回答用中文，先给结论再展开。\n\n表格内容：\n{{选区}}",
  },
  {
    name: "分析公式",
    content:
      "你是数理公式解读专家。请分析这个公式：\n" +
      "1. 每个变量的含义与量纲；\n" +
      "2. 公式的目的与使用场景；\n" +
      "3. 若是多步推导，给出完整计算过程；\n" +
      "4. 从算法/数学本质解释为什么要这样构造，相对原本的数学做法改变了什么。\n" +
      "回答用中文，公式用 LaTeX。\n\n公式：\n{{选区}}",
  },
];

export function getTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
}

export function saveTemplates(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

// Apply a template: replace {{选区}} / {{批注}} placeholders; if placeholders
// are missing (or the user cleared them), append the context at the end.
export function applyTemplate(tpl, regionBody, note) {
  let text = tpl || "";
  if (regionBody) text = text.split("{{选区}}").join(regionBody);
  if (note) text = text.split("{{批注}}").join(note);
  if (text.includes("{{")) {
    text = text.replace(new RegExp("\\n?\\n?{{[^}]*}}", "g"), "");
    if (regionBody) text += "\n\n选区内容：\n" + regionBody;
  }
  if (note && !text.includes(note)) text += "\n\n用户批注：" + note;
  return text.trim();
}

export function templateNames() {
  return getTemplates().map((t) => t.name);
}
