import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-milvus-test-"));
process.env.PIPAPER_DATA_DIR = path.join(root, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(root, "library");
const { VectorIndex, rrf } = await import("../server/rag/milvus.js");
const { closeCatalog } = await import("../server/storage/catalog.js");
const { getConfig } = await import("../server/config.js");
test.after(() => {
  closeCatalog();
  fs.rmSync(root, { recursive: true, force: true });
});
// Offline deterministic lexical vectors isolate storage/ranking from a paid embedding service.
function fixtureVector(text) {
  const out = Array(128).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+|\p{Script=Han}/gu) ||
    []) {
    const n = createHash("sha256").update(word).digest().readUInt16LE(0) % 128;
    out[n]++;
  }
  return out;
}
test(
  "real Milvus validates transport, upsert idempotence, 30 bilingual Recall@10 questions and removal",
  { skip: process.env.PIPAPER_TEST_MILVUS !== "1", timeout: 60000 },
  async () => {
    const cases = JSON.parse(
        fs.readFileSync(
          new URL("./fixtures/rag-recall.json", import.meta.url),
          "utf8",
        ),
      ),
      indexes = [],
      scores = { original: [], expanded: [] };
    try {
      for (const mode of ["original", "expanded"]) {
        const config = structuredClone(getConfig().rag);
        config.embedding = {
          url: "fixture",
          model: "lexical-test",
          dimension: 128,
        };
        config.milvus.collectionPrefix =
          "pipaper_test_" + Date.now() + "_" + mode;
        const index = new VectorIndex({ config });
        indexes.push(index);
        const generation = { id: mode, resourceId: "fixture" },
          rows = [];
        const add = (id, text, variant) =>
          rows.push({
            id: id + "_" + variant,
            canonical_id: id,
            resource_id: "fixture",
            generation_id: mode,
            kind: "chunk",
            variant,
            source_type: "note",
            text,
            dense_vector: fixtureVector(text),
          });
        for (const c of cases) {
          add(c.id, c.text, "original");
          if (mode === "expanded") {
            add(c.id, c.background, "background");
            add(c.id, c.chinese, "question");
          }
        }
        for (let i = 0; i < 40; i++)
          add(
            "distractor_" + i,
            " unrelated observations field sampling logging participant workflow frequency notes monitoring system data records test " +
              i,
            "original",
          );
        await index.write(generation, rows);
        await index.write(generation, rows);
        for (const c of cases)
          for (const [language, query] of [
            ["en", c.english],
            ["zh", c.chinese],
          ]) {
            const lists = await index.search(query, fixtureVector(query), {
              generationIds: [mode],
            });
            const found = rrf(lists, { limit: 10 }).some(
              (r) => r.canonical_id === c.id,
            );
            scores[mode].push({ id: c.id, language, query, hit: found });
          }
        await index.removeResource("fixture");
        assert.equal(
          (
            await index.search(
              cases[0].english,
              fixtureVector(cases[0].english),
              { generationIds: [mode] },
            )
          ).flat().length,
          0,
        );
      }
      const count = (mode) => scores[mode].filter((v) => v.hit).length;
      assert.equal(scores.original.length, 30);
      assert.ok(count("expanded") >= count("original"));
      assert.ok(
        scores.expanded.filter((v) => v.language === "zh" && v.hit).length >
          scores.original.filter((v) => v.language === "zh" && v.hit).length,
      );
      console.log(
        JSON.stringify({
          benchmark: "deterministic-fixture-actual-Milvus",
          questions: 30,
          originalRecallAt10: count("original") / 30,
          expandedRecallAt10: count("expanded") / 30,
        }),
      );
    } finally {
      for (const index of indexes) {
        for (const collection_name of index.collections)
          await index.client
            .dropCollection({ collection_name })
            .catch(() => {});
        await index.close();
      }
    }
  },
);
