// Opt-in real Bailian/Milvus ranking benchmark. No personal documents or indexes are changed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalData = process.env.PIPAPER_DATA_DIR || path.join(app, "data");
let apiKey =
  process.env.PIPAPER_EMBEDDING_API_KEY || process.env.DASHSCOPE_API_KEY;
try {
  apiKey ||= JSON.parse(
    fs.readFileSync(
      path.join(originalData, "credentials", "embedding.json"),
      "utf8",
    ),
  ).apiKey;
} catch {}
if (apiKey) process.env.PIPAPER_EMBEDDING_API_KEY = apiKey;
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-ranking-"));
process.env.PIPAPER_DATA_DIR = path.join(isolated, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(isolated, "library");
const { getConfig } = await import("../server/config.js");
const { embed } = await import("../server/rag/providers.js");
const { rerank } = await import("../server/rag/rerank.js");
const { VectorIndex } = await import("../server/rag/milvus.js");
const { fuseRoutes } = await import("../server/rag/retrieval.js");
const { closeCatalog } = await import("../server/storage/catalog.js");
const cases = JSON.parse(
  fs.readFileSync(path.join(app, "tests/fixtures/rag-recall.json"), "utf8"),
);
const config = structuredClone(getConfig().rag);
config.milvus.collectionPrefix = "pipaper_rank_eval_" + Date.now();
const index = new VectorIndex({ config }),
  generation = {
    id: config.milvus.collectionPrefix,
    resourceId: "ranking-fixture",
  };
const documents = cases.map((c) => ({ id: c.id, text: c.text }));
for (let i = 0; i < 40; i++)
  documents.push({
    id: "noise_" + i,
    text:
      "Unrelated field sampling observations, frequency monitoring and data logging. Record " +
      i,
  });
const report = {
  benchmark: "real-Bailian-Milvus-reranking",
  createdAt: new Date().toISOString(),
  embedding: config.embedding.model,
  rerank: config.rerank.model,
  questions: [],
};
try {
  const vectors = await embed(
    documents.map((d) => d.text),
    { config: config.embedding },
  );
  await index.write(
    generation,
    documents.map((d, n) => ({
      id: d.id,
      canonical_id: d.id,
      resource_id: generation.resourceId,
      generation_id: generation.id,
      kind: "chunk",
      variant: "original",
      source_type: "note",
      text: d.text,
      dense_vector: vectors[n],
    })),
  );
  const questions = cases.flatMap((c) => [
    { expected: c.id, query: c.english, language: "en" },
    { expected: c.id, query: c.chinese, language: "zh" },
  ]);
  const queryVectors = await embed(
    questions.map((q) => q.query),
    { type: "query", config: config.embedding },
  );
  for (const [n, q] of questions.entries()) {
    const routes = await index.searchRoutes(q.query, queryVectors[n], {
      generationIds: [generation.id],
    });
    if (routes.some((r) => r.error))
      throw new Error(routes.find((r) => r.error).error);
    const fused = fuseRoutes(routes, () => true, 32);
    const ranked = await rerank(
      q.query,
      fused.map((h) => documents.find((d) => d.id === h.canonical_id).text),
      { config: config.rerank },
    );
    const reordered = ranked
      .sort((a, b) => b.score - a.score)
      .map((r) => fused[r.index]);
    const rank = (rows) => {
      const i = rows.findIndex((h) => h.canonical_id === q.expected);
      return i < 0 ? 0 : i + 1;
    };
    report.questions.push({
      ...q,
      fusedRank: rank(fused),
      rerankedRank: rank(reordered),
    });
    console.log(`重排验证 ${n + 1}/${questions.length}`);
  }
  const metric = (key) => ({
    recallAt10:
      report.questions.filter((q) => q[key] && q[key] <= 10).length /
      report.questions.length,
    mrrAt10:
      report.questions.reduce(
        (sum, q) => sum + (q[key] && q[key] <= 10 ? 1 / q[key] : 0),
        0,
      ) / report.questions.length,
  });
  report.fusion = metric("fusedRank");
  report.reranked = metric("rerankedRank");
  fs.mkdirSync(path.join(originalData, "validation"), { recursive: true });
  fs.writeFileSync(
    path.join(originalData, "validation/self-rag-ranking.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      questions: report.questions.length,
      fusion: report.fusion,
      reranked: report.reranked,
    }),
  );
  if (report.reranked.recallAt10 < report.fusion.recallAt10)
    throw new Error("重排 Recall@10 退步，需调整模型或融合策略");
} finally {
  for (const collection_name of index.collections)
    await index.client.dropCollection({ collection_name }).catch(() => {});
  await index.close();
  closeCatalog();
  if (
    path.dirname(path.resolve(isolated)) !== path.resolve(os.tmpdir()) ||
    !path.basename(isolated).startsWith("pipaper-ranking-")
  )
    throw new Error("Invalid evaluation cleanup path");
  fs.rmSync(isolated, { recursive: true, force: true });
}
