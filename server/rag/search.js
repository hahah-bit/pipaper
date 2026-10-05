import { retrieveEvidence } from "./selfrag.js";
import { loadAsset } from "./ingestion.js";
import { hydrate } from "./document.js";
import {
  resources,
  resource,
  published,
  record,
  records,
  generation as getGeneration,
  fault,
} from "../storage/catalog.js";
import { getProject } from "../store.js";

export function getKnowledgeElement(id, { generationId, imageBudget } = {}) {
  const row = record(id);
  if (!row) throw fault("元素不存在", 404);
  const r = resource(row.resourceId),
    generation = published(row.resourceId);
  if (
    !["image", "table", "formula", "code", "note", "reference"].includes(
      row.kind,
    )
  )
    throw fault("该记录不是知识元素", 422);
  const requested = generationId ? getGeneration(generationId) : generation;
  if (
    r?.lifecycle !== "active" ||
    !requested ||
    requested.resourceId !== row.resourceId ||
    !records(requested.id).some((x) => x.id === id)
  )
    throw fault("元素版本不可用", 404);
  if (!generationId && !records(generation.id).some((x) => x.id === id))
    throw fault("元素不属于当前发布版本", 404);
  const element = { ...row };
  if (row.assetId) {
    const image = loadAsset(row.assetId);
    if (
      image &&
      (imageBudget == null ||
        Buffer.byteLength(image.data, "base64") <= imageBudget)
    )
      Object.assign(element, image);
    else element.pending = true;
  }
  return element;
}
export async function searchKnowledge(
  query,
  {
    resourceIds,
    projectId,
    sourceType,
    elementType,
    limit = 10,
    imageBudget = 12 * 1024 * 1024,
    services = {},
    selfRag,
    temporal,
    signal,
    onProgress,
  } = {},
) {
  query = String(query || "").trim();
  if (!query) return { results: [], total: 0 };
  if (Buffer.byteLength(query) > 8192) throw fault("查询过长", 422);
  if (
    resourceIds != null &&
    (!Array.isArray(resourceIds) ||
      resourceIds.some((id) => typeof id !== "string"))
  )
    throw fault("资源范围无效", 422);
  if (
    (selfRag != null && typeof selfRag !== "boolean") ||
    (temporal != null &&
      (typeof temporal !== "object" || Array.isArray(temporal)))
  )
    throw fault("检索选项无效", 422);
  limit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 10)));
  imageBudget = Math.max(
    0,
    Math.min(12 * 1024 * 1024, Number(imageBudget) || 0),
  );
  const project = projectId ? getProject(projectId) : null;
  if (projectId && !project) throw fault("项目不存在", 404);
  const selected = resources().filter(
    (r) =>
      r.lifecycle === "active" &&
      published(r.id) &&
      (!resourceIds?.length || resourceIds.includes(r.id)) &&
      (!sourceType || r.sourceType === sourceType) &&
      (!project ||
        project.paperIds?.includes(r.paperId) ||
        project.paperIds?.includes(r.sourcePaperId) ||
        r.projectId === projectId),
  );
  const active = new Map(selected.map((r) => [r.id, published(r.id)]));
  if (!active.size) return { results: [], total: 0 };
  const response = await retrieveEvidence(query, selected, active, {
    services,
    selfRag,
    temporal,
    elementType,
    limit,
    signal,
    onProgress,
  });
  let remaining = imageBudget;
  const results = response.chosen
    .map((candidate) => {
      const hit = candidate.hit;
      const r = resource(hit.resource_id),
        g = active.get(r.id),
        all = records(g.id),
        canonical = all.find((row) => row.id === hit.canonical_id);
      if (!canonical) return null;
      const base = {
        resourceId: r.id,
        generationId: g.id,
        versionId: g.versionId,
        parseVersion: g.parseVersion,
        title: r.title,
        sourceType: r.sourceType,
        stale: Boolean(r.indexStale),
        id: candidate.id,
        citationId: candidate.citationId,
        score: candidate.relevance,
        scores: candidate.scores,
        retrieval: candidate.retrieval,
        reflection: candidate.reflection,
        date: candidate.date,
        temporal: candidate.temporal,
        coverage: g.coverage,
      };
      const parts = (c) =>
        hydrate(c, all, {
          loadImage: (e) => (e.assetId ? loadAsset(e.assetId) : null),
          imageBudget: remaining,
        });
      if (canonical.kind === "chunk") {
        const rendered = parts(canonical);
        remaining -= rendered
          .filter((p) => p.data)
          .reduce((n, p) => n + Buffer.byteLength(p.data, "base64"), 0);
        return {
          ...base,
          kind: "chunk",
          chunkId: canonical.id,
          text: canonical.text,
          sectionPath: canonical.sectionPath,
          pages: canonical.pages,
          modalities: canonical.modalities,
          parts: rendered,
          evidence: rendered.filter((p) => p.type !== "text"),
        };
      }
      const element = getKnowledgeElement(canonical.id, {
        generationId: g.id,
        imageBudget: remaining,
      });
      if (element.data) remaining -= Buffer.byteLength(element.data, "base64");
      const contexts = all.filter(
        (row) => row.kind === "chunk" && row.elementIds.includes(element.id),
      );
      return {
        ...base,
        kind: "element",
        element,
        evidence: [{ ...element, type: element.kind }],
        contexts: contexts.map((c) => {
          const rendered = parts(c);
          remaining -= rendered
            .filter((p) => p.data)
            .reduce((n, p) => n + Buffer.byteLength(p.data, "base64"), 0);
          return { ...c, parts: rendered };
        }),
        sectionPath: canonical.sectionPath,
        pages: [canonical.page].filter(Boolean),
      };
    })
    .filter(Boolean);
  const { chosen, ...details } = response;
  return { ...details, results, total: results.length };
}
