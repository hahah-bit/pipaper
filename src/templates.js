// Prompt templates for selections / box annotations. Stored in localStorage,
// editable from the annotation popup (⚙) — defaults provided below.

const LS_KEY = "pipaper.templates";

export const DEFAULT_TEMPLATES = [
  { name: "解释所选", content: "请解释选区（截图）中的内容，结合论文上下文说明它的含义与作用。" },
  { name: "翻译选区", content: "请把选区中的英文内容翻译成中文，保留专业术语的英文原词。" },
  { name: "总结要点", content: "请总结选区内容的要点，用不超过 5 条列出。" },
  { name: "公式推导", content: "请逐步推导并解释选区中的公式，说明每一项的含义。" },
  { name: "审稿视角", content: "请以审稿人视角评价选区内容：方法是否合理、论证是否充分、有何改进建议。" },
];

export function getTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return [...DEFAULT_TEMPLATES];
}

export function saveTemplates(list) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}

export function templateNames() {
  return getTemplates().map((t) => t.name);
}
