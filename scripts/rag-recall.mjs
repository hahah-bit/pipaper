import fs from "node:fs";
import path from "node:path";
import { getConfig, DATA_DIR } from "../server/config.js";
import { embed, expand } from "../server/rag/providers.js";
import { VectorIndex, rrf } from "../server/rag/milvus.js";
import { closeCatalog, digest } from "../server/storage/catalog.js";
import { writeJson } from "../server/storage/files.js";

// Opt-in cloud validation. Held-out questions are never sent to the expansion model.
const cases = JSON.parse(
  fs.readFileSync(
    new URL("../tests/fixtures/rag-recall.json", import.meta.url),
    "utf8",
  ),
);
const report = {
  benchmark: "Bailian-DeepSeek-Milvus-fixed-fixture",
  createdAt: new Date().toISOString(),
  datasetHash: digest(cases),
  questions: 30,
  scores: {},
  expansions: {},
};
const indexes = [],
  cfg = structuredClone(getConfig().rag),
  run = Date.now();
try {
  for (const [n, c] of cases.entries()) {
    report.expansions[c.id] = await expand(
      { text: c.text, sectionPath: [c.id] },
      c.text,
    );
    console.log(`语义扩写 ${n + 1}/${cases.length}`);
  }
  const questions = cases.flatMap((c) => [
    { id: c.id, language: "en", query: c.english },
    { id: c.id, language: "zh", query: c.chinese },
  ]);
  const queryVectors = await embed(
    questions.map((q) => q.query),
    { type: "query", config: cfg.embedding },
  );
  for (const mode of ["original", "expanded"]) {
    const config = structuredClone(cfg);
    config.milvus.collectionPrefix = `pipaper_eval_${run}_${mode}`;
    const index = new VectorIndex({ config });
    indexes.push(index);
    const rows = [],
      add = (id, text, variant) =>
        rows.push({
          id: `${id}_${variant}`,
          canonical_id: id,
          resource_id: "validation-fixture",
          generation_id: mode,
          kind: "chunk",
          variant,
          source_type: "note",
          text,
        });
    for (const c of cases) {
      add(c.id, c.text, "original");
      if (mode === "expanded") {
        const value = report.expansions[c.id];
        add(c.id, value.background, "background");
        value.questions.forEach((q, n) => add(c.id, q.text, "question_" + n));
      }
    }
    for (let i = 0; i < 40; i++)
      add(
        "distractor_" + i,
        "Unrelated field sampling observations, participant workflow, frequency monitoring and data logging records. Record " +
          i,
        "original",
      );
    const vectors = await embed(
      rows.map((row) => row.text),
      { type: "document", config: cfg.embedding },
    );
    rows.forEach((row, n) => (row.dense_vector = vectors[n]));
    await index.write({ id: mode, resourceId: "validation-fixture" }, rows);
    const scores = [];
    for (const [n, q] of questions.entries()) {
      const hits = rrf(
        await index.search(q.query, queryVectors[n], { generationIds: [mode] }),
        { limit: 10 },
      );
      scores.push({
        ...q,
        hit: hits.some((hit) => hit.canonical_id === q.id),
        returned: hits.map((hit) => hit.canonical_id),
      });
    }
    report.scores[mode] = scores;
    report[mode + "RecallAt10"] =
      scores.filter((q) => q.hit).length / questions.length;
    console.log(`${mode} Recall@10=${report[mode + "RecallAt10"]}`);
  }
  report.regressed = report.expandedRecallAt10 < report.originalRecallAt10;
  report.improvedQuestions = report.scores.expanded
    .filter((q, n) => q.hit && !report.scores.original[n].hit)
    .map((q) => ({ id: q.id, language: q.language }));
  report.embedding = cfg.embedding;
  report.limitation =
    "固定技术知识夹具与干扰项；使用真实百炼向量和模型扩写，不代表整库科学文献质量。基线达到 1 时，该夹具无法证明召回提升。";
  const output = path.join(DATA_DIR, "validation", `rag-recall-${run}.json`);
  writeJson(output, report, { kind: "validation", independent: true });
  console.log(
    JSON.stringify({
      output,
      questions: report.questions,
      originalRecallAt10: report.originalRecallAt10,
      expandedRecallAt10: report.expandedRecallAt10,
      regressed: report.regressed,
    }),
  );
  if (report.regressed) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  for (const index of indexes) {
    for (const name of index.collections) {
      if (!name.startsWith(`pipaper_eval_${run}_`))
        throw new Error("拒绝清理非验收集合");
      await index.client
        .dropCollection({ collection_name: name })
        .catch(() => {});
    }
    await index.close();
  }
  closeCatalog();
}
