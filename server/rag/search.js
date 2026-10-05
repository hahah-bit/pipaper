import { embed } from "./providers.js";
import { vectorIndex, rrf } from "./milvus.js";
import { loadAsset } from "./ingestion.js";
import { hydrate } from "./document.js";
import {
  resources,
  resource,
  published,
  record,
  records,
  generation as getGeneration,
  digest,
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
      (!imageBudget || Buffer.byteLength(image.data, "base64") <= imageBudget)
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
  } = {},
) {
  query = String(query || "").trim();
  if (!query) return { results: [], total: 0 };
  if (Buffer.byteLength(query) > 8192) throw fault("查询过长", 422);
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
  const groups = new Map();
  for (const g of active.values()) {
    const key = digest([g.config.embedding, g.config.milvus]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const lists = [];
  for (const group of groups.values()) {
    const [vector] = await (services.embed || embed)([query], {
      type: "query",
      config: group[0].config.embedding,
    });
    lists.push(
      ...(await (services.index || vectorIndex(group[0].config)).search(
        query,
        vector,
        {
          generationIds: group.map((g) => g.id),
          sourceType,
          elementType,
          limit: 50,
        },
      )),
    );
  }
  const hits = rrf(lists, {
    limit: Math.max(1, Math.min(50, Number(limit) || 10)),
    valid: (hit) =>
      resource(hit.resource_id)?.lifecycle === "active" &&
      active.get(hit.resource_id)?.id === hit.generation_id,
  });
  let remaining = imageBudget;
  const results = hits
    .map((hit) => {
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
        score: hit.score,
        coverage: g.coverage,
      };
      const parts = (c) =>
        hydrate(c, all, {
          loadImage: (e) => loadAsset(e.assetId),
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
  return { results, total: results.length };
}
