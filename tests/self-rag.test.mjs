import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-selfrag-"));
process.env.PIPAPER_DATA_DIR = path.join(root, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(root, "library");
const catalog = await import("../server/storage/catalog.js");
const { getConfig, saveConfig } = await import("../server/config.js");
const { searchKnowledge } = await import("../server/rag/search.js");
const { registerRetrievalProvider } = await import("../server/rag/selfrag.js");
const { rerank, rerankUrl } = await import("../server/rag/rerank.js");
const {
  bm25,
  fuseRoutes,
  temporalIntent,
  sourceDate,
  parseDate,
  timeFit,
  temporalPairs,
  diversify,
} = await import("../server/rag/retrieval.js");
const { flushStore } = await import("../server/store.js");
test.after(() => {
  flushStore();
  catalog.closeCatalog();
  fs.rmSync(root, { recursive: true, force: true });
});
let sequence = 0;
function fixture(
  year = 2024,
  text = "The routing model uses adaptive node embeddings and an encoder decoder. Figure 2 shows the architecture.",
) {
  const id = "selfrag-" + ++sequence;
  const r = catalog.putResource({
    id,
    kind: "original",
    sourceType: "original",
    title: "Routing model",
    metadata: { year },
    versionId: String(year),
  });
  const generation = {
    id: "g-" + id,
    resourceId: id,
    versionId: String(year),
    config: structuredClone(getConfig().rag),
    coverage: { partial: false },
  };
  const element = {
    id: "img-" + id,
    resourceId: id,
    kind: "image",
    label: "2",
    quality: "ready",
    shortDescription: "Routing model architecture",
    page: 2,
    sectionPath: ["Method"],
  };
  const chunk = {
    id: "chunk-" + id,
    resourceId: id,
    kind: "chunk",
    text: text + ` [[image:${element.id}]]（Figure 2: architecture）`,
    pages: [2],
    sectionPath: ["Method"],
    elementIds: [element.id],
    modalities: ["text", "image"],
  };
  catalog.saveGeneration(generation, [chunk, element]);
  catalog.publish(generation.id, r.revision);
  return { r, generation, chunk, element };
}
function services(overrides = {}) {
  return {
    embed: async (texts) => texts.map(() => [1, 0.2]),
    index: {
      searchRoutes: async () => [
        { name: "body-dense", hits: [] },
        { name: "body-bm25", hits: [] },
      ],
    },
    rerank: async (_q, docs) => docs.map((_, index) => ({ index, score: 0.8 })),
    modelJson: async ({ system, text }) => {
      const input = JSON.parse(text);
      let value;
      if (system.includes("改写"))
        value = {
          queries: ["adaptive routing model architecture", "路由模型编码器"],
          rationale: "双语互补",
        };
      else if (system.includes("评估每条"))
        value = {
          sufficient: true,
          evaluations: input.evidence.map((e) => ({
            id: e.id,
            relevant: true,
            reason: "直接描述方法",
          })),
          missing: [],
          followupQueries: [],
        };
      else if (system.includes("独立核对"))
        value = {
          checks: input.claims.map((_, index) => ({
            index,
            supported: true,
            reason: "引用支持",
          })),
        };
      else
        value = {
          claims: [
            {
              text: "模型使用自适应节点嵌入。",
              citations: [input.evidence[0].id],
            },
          ],
          gaps: [],
          comparisons: [],
        };
      return { value };
    },
    ...overrides,
  };
}
test("BM25 bilingual tokenization and weighted RRF deduplicate within each route, preserving version identity", () => {
  const docs = [
    {
      searchText: "自适应节点嵌入 adaptive embedding",
      hit: { canonical_id: "a" },
    },
    { searchText: "weather temperature", hit: { canonical_id: "b" } },
  ];
  assert.equal(bm25("节点嵌入", docs)[0].canonical_id, "a");
  assert.equal(bm25("adaptive embedding", docs)[0].canonical_id, "a");
  const a = { generation_id: "v1", canonical_id: "a" },
    b = { ...a, generation_id: "v2" };
  const rows = fuseRoutes(
    [
      { name: "dense", hits: [a, a, b], weight: 1 },
      { name: "bm25", hits: [b, a], weight: 2 },
    ],
    () => true,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].generation_id, "v2");
  assert.equal(rows[0].retrieval.length, 2);
});
test("date precision, cutoff and historical policies do not treat imports or filename years as publication dates", () => {
  assert.equal(parseDate("2024-02-29").end, "2024-02-29");
  assert.equal(parseDate("2023-02-29"), null);
  assert.equal(parseDate("2024").end, "2024-12-31");
  const intent = temporalIntent("截至2023年的模型", {}, new Date("2026-10-05"));
  assert.equal(intent.mode, "as_of");
  assert.equal(intent.to, "2023-12-31");
  assert.equal(timeFit(parseDate("2024"), intent).eligible, false);
  assert.equal(timeFit(parseDate("2027"), intent).eligible, false);
  assert.equal(
    sourceDate({
      sourceType: "original",
      title: "2026 paper",
      createdAt: "2026-01-01",
    }).value,
    null,
  );
  assert.equal(
    sourceDate({ sourceType: "note", createdAt: "2026-01-01" }).basis,
    "artifactCreatedAt",
  );
  const latest = temporalIntent("最新方法", {}, new Date("2026-10-05"));
  const noteDate = sourceDate(
    { sourceType: "note", createdAt: "2026-01-01" },
    { sourceType: "original", metadata: { year: 2020 } },
  );
  assert.ok(timeFit(noteDate, latest).score < 0.2);
  assert.match(timeFit(noteDate, latest).warning, /成果生成时间/);
  assert.throws(() =>
    temporalIntent("test", { mode: "range", from: "2025", to: "2024" }),
  );
});
test("similar vectors retain temporal comparisons and latest favors recent only with valid source dates", () => {
  const intent = temporalIntent("最新路由模型", {}, new Date("2026-10-05"));
  const rows = [2020, 2025].map((year, i) => ({
    id: String(i),
    resourceId: String(i),
    evidenceText: "routing model",
    vector: [1, 0],
    date: sourceDate({ sourceType: "original", metadata: { year } }),
    relevance: 0.9,
  }));
  rows.forEach((r) => {
    r.temporal = timeFit(r.date, intent);
  });
  const pair = temporalPairs(rows, intent)[0];
  assert.equal(pair.preferred, "1");
  assert.equal(
    temporalPairs(rows, { ...intent, mode: "compare" })[0].preferred,
    null,
  );
  assert.equal(diversify(rows, 2, { ...intent, mode: "compare" }).length, 2);
});
test("Bailian reranker honors workspace endpoint, complete indices and relative score schema", async () => {
  const config = {
    model: "qwen3-rerank",
    url: "https://rerank.example/api",
    timeoutMs: 1000,
  };
  assert.equal(
    rerankUrl(
      { ...config, url: "" },
      { url: "https://ws.cn-beijing.maas.aliyuncs.com/api/v1/embeddings" },
    ),
    "https://ws.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks",
  );
  const rows = await rerank("model", ["adaptive model", "weather"], {
    config,
    key: "fixture",
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.documents.length, 2);
      return Response.json({
        results: [
          { index: 1, relevance_score: 0.1 },
          { index: 0, relevance_score: 0.9 },
        ],
      });
    },
  });
  assert.equal(rows[1].score, 0.9);
  await assert.rejects(
    rerank("model", ["a", "b"], {
      config,
      key: "fixture",
      fetchImpl: async () =>
        Response.json({
          results: [
            { index: 0, relevance_score: 1 },
            { index: 0, relevance_score: 1 },
          ],
        }),
    }),
    /索引/,
  );
});
test("Self-RAG performs bounded complementary recall and returns verified analysis with versioned image evidence", async () => {
  const f = fixture(),
    stages = [];
  const result = await searchKnowledge("routing model Figure 2", {
    resourceIds: [f.r.id],
    services: services(),
    onProgress: (p) => stages.push(p.stage),
  });
  assert.equal(result.analysis.status, "supported");
  assert.ok(result.analysis.claims[0].verified);
  assert.ok(result.retrieval.routes.some((r) => r.name === "element-number"));
  assert.equal(result.retrieval.queries.length, 3);
  assert.ok(stages.includes("verify"));
  assert.ok(
    result.results.some((r) =>
      r.evidence.some(
        (e) => e.elementId === f.element.id || e.id === f.element.id,
      ),
    ),
  );
  assert.ok(
    result.analysis.claims.every((c) =>
      c.citations.every((id) => result.results.some((r) => r.id === id)),
    ),
  );
});
test("insufficient evidence retries once, preserves original recall and withdraws unsupported claims", async () => {
  const f = fixture();
  let reflectionCalls = 0;
  const base = services();
  base.modelJson = async (args) => {
    const input = JSON.parse(args.text);
    if (args.system.includes("评估每条"))
      return {
        value: {
          sufficient: ++reflectionCalls > 1,
          evaluations: input.evidence.map((e) => ({
            id: e.id,
            relevant: true,
            reason: "相关",
          })),
          missing: reflectionCalls === 1 ? ["编码器信息"] : [],
          followupQueries: ["adaptive encoder decoder"],
        },
      };
    if (args.system.includes("独立核对"))
      return {
        value: {
          checks: input.claims.map((_, index) => ({
            index,
            supported: false,
            reason: "没有来源支持该数值",
          })),
        },
      };
    return services().modelJson(args);
  };
  const result = await searchKnowledge("routing model", {
    resourceIds: [f.r.id],
    services: base,
  });
  assert.equal(result.retrieval.rounds, 2);
  assert.equal(reflectionCalls, 2);
  assert.ok(result.retrieval.queries.includes("routing model"));
  assert.equal(result.analysis.claims.length, 0);
  assert.equal(result.analysis.status, "insufficient");
  assert.ok(result.warnings.some((w) => w.includes("撤回")));
});
test("long original queries retain their entities and full text alongside bounded rewrites", async () => {
  const f = fixture(),
    query = "routing model " + "background ".repeat(250) + "Figure 2";
  const result = await searchKnowledge(query, {
    resourceIds: [f.r.id],
    services: services(),
  });
  assert.equal(result.retrieval.queries[0], query);
  assert.ok(
    result.retrieval.routes.some(
      (r) => r.name === "element-number" && r.query === query,
    ),
  );
});
test("time windows exclude newer evidence and comparison never collapses distinct dated sources", async () => {
  const old = fixture(2020),
    newer = fixture(2025);
  const cutoff = await searchKnowledge("routing model 截至2023年", {
    resourceIds: [old.r.id, newer.r.id],
    services: services(),
  });
  assert.ok(cutoff.results.length);
  assert.ok(cutoff.results.every((r) => r.resourceId === old.r.id));
  const compare = await searchKnowledge("routing model 历史演变", {
    resourceIds: [old.r.id, newer.r.id],
    services: services(),
  });
  assert.equal(new Set(compare.results.map((r) => r.resourceId)).size, 2);
  assert.ok(compare.temporal.pairs.length);
});
test("provider outages return lexical evidence with explicit degradation and no fabricated analysis", async () => {
  const f = fixture();
  const fail = async () => {
    throw new Error("offline");
  };
  const result = await searchKnowledge("routing model", {
    resourceIds: [f.r.id],
    services: services({ embed: fail, rerank: fail, modelJson: fail }),
  });
  assert.ok(result.results.length);
  assert.equal(result.analysis.status, "unavailable");
  assert.equal(result.analysis.claims.length, 0);
  assert.ok(result.warnings.length >= 3);
});
test("late deletion retracts evidence and analysis after model verification", async () => {
  const f = fixture(),
    base = services();
  base.modelJson = async (args) => {
    const response = await services().modelJson(args);
    if (args.system.includes("独立核对"))
      catalog.putResource({
        ...catalog.resource(f.r.id),
        lifecycle: "trashed",
      });
    return response;
  };
  const result = await searchKnowledge("routing model", {
    resourceIds: [f.r.id],
    services: base,
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.analysis.claims.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("撤回")));
});
test("old published evidence keeps its original source date after a content update", async () => {
  const f = fixture(2020);
  catalog.putResource({
    ...catalog.resource(f.r.id),
    versionId: "2025",
    metadata: { year: 2025 },
    indexStale: true,
  });
  const result = await searchKnowledge("routing model", {
    resourceIds: [f.r.id],
    services: services(),
  });
  assert.ok(result.results.length);
  assert.ok(
    result.results.every((r) => r.date.value === "2020-01-01" && r.stale),
  );
  assert.ok(result.warnings.some((w) => w.includes("旧发布版本")));
});
test("unsupported model temporal preferences are withdrawn while source comparison warnings remain", async () => {
  const old = fixture(2020),
    recent = fixture(2025),
    base = services();
  base.modelJson = async (args) => {
    const input = JSON.parse(args.text);
    if (args.system.includes("独立核对"))
      return {
        value: {
          checks: input.claims.map((c, index) => ({
            index,
            supported: !c.text.startsWith("时间适用性判断"),
            reason: "日期不能证明模型效果更好",
          })),
        },
      };
    if (args.system.includes("依据证据回答"))
      return {
        value: {
          claims: [
            { text: "模型使用自适应嵌入。", citations: [input.evidence[0].id] },
          ],
          gaps: [],
          comparisons: input.similarEvidence.slice(0, 1).map((p) => ({
            ids: p.ids,
            preferred: p.ids[1],
            reason: "新模型一定效果更好",
          })),
        },
      };
    return services().modelJson(args);
  };
  const result = await searchKnowledge("最新 routing model", {
    resourceIds: [old.r.id, recent.r.id],
    services: base,
  });
  assert.ok(result.temporal.pairs.length);
  assert.equal(result.analysis.comparisons.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("日期不能证明")));
});
test("future provider interface cannot inject outside-scope or unpublished evidence", async () => {
  const f = fixture(),
    outside = fixture();
  const unregister = registerRetrievalProvider("future-graph", async () => [
    {
      canonical_id: outside.chunk.id,
      resource_id: outside.r.id,
      generation_id: outside.generation.id,
    },
  ]);
  try {
    const result = await searchKnowledge("routing model", {
      resourceIds: [f.r.id],
      services: services(),
    });
    assert.ok(result.results.every((r) => r.resourceId === f.r.id));
  } finally {
    unregister();
  }
});
test("retrieval-only configuration updates preserve valid indexed generations and reject unbounded budgets", () => {
  assert.throws(
    () => saveConfig({ rag: { retrieval: { maxRounds: 3 } } }),
    /预算/,
  );
  assert.throws(
    () => saveConfig({ rag: { rerank: { url: "file:///private" } } }),
    /重排/,
  );
});
