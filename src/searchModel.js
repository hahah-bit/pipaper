import { LITERATURE_PURPOSES } from "../shared/literature-purpose.js";
export const PURPOSES = LITERATURE_PURPOSES;

export function purposeCategories(entry) {
  const suggested = entry?.researchMatch?.categories || [];
  // 空的人工分类代表恢复自动建议；非空人工分类优先。
  const ids = Array.isArray(entry?.purposeCategories) && entry.purposeCategories.length
    ? entry.purposeCategories : suggested.map((item) => typeof item === "string" ? item : item.id);
  return PURPOSES.filter((purpose) => ids.includes(purpose.id)).map((purpose) => ({
    ...purpose,
    reason: suggested.find((item) => item?.id === purpose.id)?.reason || "",
  }));
}

export function filterSearchResults(results = [], purpose = "", sort = "") {
  const filtered = results.filter((entry) => !purpose || purposeCategories(entry).some((item) => item.id === purpose));
  if (sort === "research") filtered.sort((a, b) => (Number(b.researchMatch?.score) || 0) - (Number(a.researchMatch?.score) || 0)
    || (Number(b.readScore) || 0) - (Number(a.readScore) || 0));
  return filtered;
}

export function evidenceLabel(evidence = {}) {
  const pages = Array.isArray(evidence.pages) ? evidence.pages : evidence.pages == null ? [] : [evidence.pages];
  const pageText = pages.filter((page) => page !== "" && page != null).join("、");
  const section = Array.isArray(evidence.sectionPath) ? evidence.sectionPath.join(" › ") : evidence.sectionPath;
  return [evidence.title || evidence.resourceId || "项目证据", pageText ? "第 " + pageText + " 页" : "未提供页码", section].filter(Boolean).join(" · ");
}

// Abort 降低重复请求开销；序号同时防止不响应 Abort 的旧请求覆盖新结果。
export function createRequestGate() {
  let revision = 0, current;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return { revision: ++revision, signal: current.signal };
    },
    isCurrent(request) { return request?.revision === revision && !request.signal.aborted; },
    cancel() { current?.abort(); revision += 1; },
  };
}
