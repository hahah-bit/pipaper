import { LITERATURE_PURPOSES } from "../../shared/literature-purpose.js";

const text = (value, length) => typeof value === "string" ? value.slice(0, length) : "";
const list = (value, length) => Array.isArray(value) ? value.slice(0, length) : [];

// Keep the useful, reviewable match snapshot without storing images, credentials,
// embedding vectors or the full retrieval response in the reading list.
export function pickResearchMatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const score = Number(value.score);
  return {
    projectId: text(value.projectId, 100),
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    level: text(value.level, 30),
    confidence: text(value.confidence, 30),
    basis: text(value.basis, 300),
    reasons: list(value.reasons, 8).map(reason => text(reason, 600)).filter(Boolean),
    categories: list(value.categories, 4).flatMap(category => {
      const purpose = LITERATURE_PURPOSES.find(item => item.id === category?.id);
      return purpose ? [{ ...purpose, reason: text(category.reason, 600) }] : [];
    }),
    evidence: list(value.evidence, 5).map(evidence => ({
      resourceId: text(evidence?.resourceId, 200),
      generationId: text(evidence?.generationId, 200),
      recordId: text(evidence?.recordId, 200),
      title: text(evidence?.title, 400),
      pages: list(evidence?.pages, 20).filter(page => Number.isInteger(page) && page > 0),
      sectionPath: list(evidence?.sectionPath, 12).map(section => text(section, 200)).filter(Boolean),
      text: text(evidence?.text, 1400),
    })).filter(evidence => evidence.resourceId && evidence.generationId),
  };
}
