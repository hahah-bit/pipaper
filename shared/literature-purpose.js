export const LITERATURE_PURPOSES = Object.freeze([
  { id: "innovation", label: "找创新点" },
  { id: "module", label: "改模块" },
  { id: "topic", label: "选题必读" },
  { id: "background", label: "背景参考" },
]);

// An empty list restores automatic suggestions; a non-empty list is a manual choice.
export function normalizePurposeCategories(value) {
  if (!Array.isArray(value) || value.length > LITERATURE_PURPOSES.length ||
      value.some(id => !LITERATURE_PURPOSES.some(purpose => purpose.id === id))) {
    throw Object.assign(new Error("文献用途必须是有效的分类列表"), { status: 400 });
  }
  return [...new Set(value)];
}
