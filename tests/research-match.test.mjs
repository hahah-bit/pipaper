import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-research-match-"));
process.env.PIPAPER_DATA_DIR = path.join(temp, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(temp, "library");
const { enrichResearchResults } = await import("../server/search/research-match.js");
const store = await import("../server/store.js");
const research = await import("../server/modules/research/store.js");
const catalog = await import("../server/storage/catalog.js");
const { getConfig } = await import("../server/config.js");
const { searchKnowledge } = await import("../server/rag/search.js");
test.after(() => {
  store.flushStore();
  catalog.closeCatalog();
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
});

const profile = { question: "多模态时序光伏预测", scope: "", goal: "", constraints: "" };
const candidates = [
  { title: "Multimodal temporal photovoltaic forecasting with attention fusion", abstract: "A multimodal attention module combines time series of solar power and images for photovoltaic forecasting." },
  { title: "A survey of multimodal time-series photovoltaic forecasting", abstract: "This review compares multimodal solar forecasting methods and temporal prediction benchmarks." },
  { title: "Open problems in multimodal solar time-series forecasting", abstract: "We discuss limitations and unresolved gaps in photovoltaic prediction using multimodal temporal data." },
  { title: "Protein folding mechanisms", abstract: "Molecular structures reveal amino acid interactions." },
];
function services(overrides = {}) {
  return {
    getProject: () => ({ id: "prj_test", name: "多模态时序光伏预测", paperIds: [] }),
    getPaper: () => null,
    loadProfile: () => profile,
    listEvidence: () => [], listHypotheses: () => [], listConclusions: () => [], listReselections: () => [],
    listKnowledgeSources: () => [],
    searchKnowledge: async () => ({ results: [], warnings: [], retrieval: { routes: [] } }),
    ...overrides,
  };
}
const hit = (text = "Multimodal temporal photovoltaic forecasting uses an attention fusion module. Existing models have generalization limitations.") => ({
  resourceId: "file:project-note", generationId: "g_original", chunkId: "ch_1", title: "光伏研究原文",
  text, pages: [3], sectionPath: ["Methods", "Fusion"], retrieval: [{ route: "catalog-bm25" }],
});

test("未选项目或失效项目不召回全库，保留候选并明确待判断", async () => {
  let calls = 0;
  const injected = services({ searchKnowledge: async () => { calls++; throw new Error("不应检索"); } });
  const missing = await enrichResearchResults(candidates, "solar", { services: injected });
  assert.equal(calls, 0);
  assert.equal(missing.researchContext.projectId, null);
  assert.match(missing.researchContext.reason, /选择.*项目/);
  assert.ok(missing.results.every((row) => row.researchMatch.level === "pending" && !row.researchMatch.categories.length));
  assert.ok(missing.results.every((row) => row.researchMatch.projectId === null));
  const invalid = await enrichResearchResults(candidates, "solar", { projectId: "missing", services: services({ getProject: () => null, searchKnowledge: injected.searchKnowledge }) });
  assert.equal(calls, 0);
  assert.equal(invalid.researchContext.status, "unavailable");
  assert.ok(invalid.results.every((row) => row.researchMatch.projectId === "missing"));
});

test("首次使用：中文研究档案与英文光伏论文匹配，无本地论文仍有低置信用途分类且不伪造RAG证据", async () => {
  let calls = 0;
  const result = await enrichResearchResults(candidates, "multimodal solar forecasting", {
    projectId: "prj_test", services: services({ searchKnowledge: async (query, options) => {
      calls++;
      assert.equal(options.projectId, "prj_test");
      assert.equal(options.selfRag, false);
      assert.match(query, /photovoltaic|solar/);
      assert.match(query, /time series/);
      return { results: [] };
    } }),
  });
  assert.equal(calls, 1);
  assert.equal(result.researchContext.profileAvailable, true);
  assert.equal(result.researchContext.question, profile.question);
  assert.equal(result.researchContext.questionSource, "profile");
  assert.equal(result.researchContext.paperCount, 0);
  assert.equal(result.researchContext.indexReady, false);
  assert.equal(result.researchContext.evidenceCount, 0);
  const [method, survey, gaps, unrelated] = result.results.map((row) => row.researchMatch);
  assert.ok(result.results.every((row) => row.researchMatch.projectId === "prj_test"));
  assert.ok(method.score >= 40, String(method.score));
  assert.ok(method.categories.some((category) => category.id === "module"));
  assert.ok(survey.categories.some((category) => category.id === "topic"));
  assert.ok(gaps.categories.some((category) => category.id === "innovation"));
  for (const match of [method, survey, gaps]) {
    assert.equal(match.confidence, "low");
    assert.deepEqual(match.evidence, []);
    assert.match(match.basis, /仅据.*标题\/摘要/);
    assert.ok(match.categories.every((category) => /低置信|仅据/.test(category.reason)));
  }
  assert.match(gaps.categories.find((category) => category.id === "innovation").reason, /尚未验证创新性/);
  assert.equal(unrelated.score, 0);
  assert.deepEqual(unrelated.categories, []);
  assert.deepEqual(unrelated.evidence, []);
  assert.deepEqual(candidates[0].researchMatch, undefined, "不修改调用者的原始候选");
});

test("已有项目RAG为候选逐项筛选真实相关片段，不给无关论文套用批次证据", async () => {
  const source = hit();
  const result = await enrichResearchResults(candidates, "forecasting", {
    projectId: "prj_test", services: services({
      listKnowledgeSources: () => [{ resourceId: source.resourceId, generationId: source.generationId, title: source.title }],
      searchKnowledge: async () => ({ results: [source], warnings: ["向量不可用，已使用本地词法"], retrieval: { routes: [{ name: "catalog-bm25", count: 1 }] } }),
    }),
  });
  assert.equal(result.researchContext.status, "ready");
  assert.equal(result.researchContext.indexReady, true);
  assert.equal(result.researchContext.retrievalMode, "local-lexical");
  assert.equal(result.results[0].researchMatch.confidence, "medium");
  assert.deepEqual(result.results[0].researchMatch.evidence[0], {
    resourceId: source.resourceId, generationId: source.generationId, recordId: source.chunkId,
    title: source.title, pages: [3], sectionPath: ["Methods", "Fusion"], text: source.text,
  });
  assert.match(result.results[0].researchMatch.reasons.join("\n"), /第 3 页/);
  assert.deepEqual(result.results[3].researchMatch.evidence, []);
  assert.deepEqual(result.results[3].researchMatch.categories, []);
});

test("真实标题回归：首用中等匹配的CNN-GRU、SkyNet和双注意力方法仍提供低置信模块建议", async () => {
  const titles = [
    "CNN-GRU framework for multimodal solar photovoltaic forecasting",
    "SkyNet: A Deep Learning Architecture for Intra-hour Multimodal Solar Forecasting",
    "Dual-Attention Transformer with Cross-Modal Fusion for Multimodal Solar Photovoltaic Forecasting",
  ];
  const result = await enrichResearchResults(titles.map((title) => ({ title })), "multimodal solar forecasting", { projectId: "prj_test", services: services() });
  for (const row of result.results) {
    assert.ok(row.researchMatch.categories.some((category) => category.id === "module"), row.title + " : " + row.researchMatch.score);
    assert.equal(row.researchMatch.confidence, "low");
    assert.deepEqual(row.researchMatch.evidence, []);
  }
});

test("真实标题回归：Controlled Visual-Backbone Benchmark归为选题必读建议", async () => {
  const title = "A Controlled Visual-Backbone Benchmark for Multimodal Solar Forecasting";
  const result = await enrichResearchResults([{ title }], "multimodal solar forecasting", { projectId: "prj_test", services: services() });
  assert.ok(result.results[0].researchMatch.categories.some((category) => category.id === "topic"), String(result.results[0].researchMatch.score));
  assert.equal(result.results[0].researchMatch.confidence, "low");
});

test("太阳耀斑预测不因solar一词归为光伏；明确空间天气任务冲突不作模块建议", async () => {
  const titles = [
    "Solar Flare Forecasting with a Deep Learning Architecture",
    "Multimodal Temporal Solar Flare Forecasting with Attention Fusion",
    "Protein Folding with an Attention Encoder Module",
  ];
  const result = await enrichResearchResults(titles.map((title) => ({ title })), "multimodal solar forecasting", { projectId: "prj_test", services: services() });
  assert.ok(result.results.every((row) => row.researchMatch.score < 30 && !row.researchMatch.categories.length));
  assert.ok(result.results.slice(0, 2).every((row) => /空间天气/.test(row.researchMatch.reasons.join(" "))));
  assert.ok(result.results.every((row) => !row.researchMatch.evidence.length));
});

test("RAG段落可桥接候选方法与当前研究主题，且来源不是凭空的语义宣称", async () => {
  const candidate = { title: "Attention encoder decoder architecture", abstract: "A fusion module with attention encoder and decoder layers." };
  const result = await enrichResearchResults([candidate], "attention", {
    projectId: "prj_test", services: services({ searchKnowledge: async () => ({ results: [hit()] }) }),
  });
  const match = result.results[0].researchMatch;
  assert.equal(match.evidence.length, 1);
  assert.ok(match.score > 0);
  assert.match(match.reasons.join(" "), /项目原文/);
  assert.match(match.evidence[0].text, /photovoltaic/);
});

test("空项目不借用全库元数据，跨项目参照和检索证据被忽略", async () => {
  let calls = 0;
  const empty = await enrichResearchResults(candidates, "solar", {
    projectId: "prj_test", anchorPaperId: "other-paper", services: services({ loadProfile: () => null, getPaper: () => ({ id: "other-paper", title: "Solar" }), searchKnowledge: async () => { calls++; return { results: [hit()] }; } }),
  });
  assert.equal(calls, 0);
  assert.equal(empty.researchContext.paperCount, 0);
  assert.ok(empty.results.every((row) => row.researchMatch.score === 0));
  const scoped = await enrichResearchResults(candidates, "solar", {
    projectId: "prj_test", anchorPaperId: "other-paper", services: services({
      listKnowledgeSources: () => [{ resourceId: "file:allowed", generationId: "g_allowed" }],
      searchKnowledge: async () => ({ results: [hit()] }),
    }),
  });
  assert.equal(scoped.researchContext.evidenceCount, 0);
  assert.match(scoped.researchContext.warnings.join(" "), /不属于当前项目/);
  assert.ok(scoped.results.every((row) => !row.researchMatch.evidence.length));
});

test("研究记录可充当当前研究来源，检索故障公开原因且保留可用的元数据匹配", async () => {
  const result = await enrichResearchResults(candidates, "solar", {
    projectId: "prj_test", services: services({
      loadProfile: () => null,
      listHypotheses: () => [{ id: "hyp_original", title: "当前研究假设", statement: "多模态时序光伏预测" }],
      searchKnowledge: async () => { throw new Error("knowledge unavailable"); },
    }),
  });
  assert.equal(result.researchContext.questionSource, "records");
  assert.equal(result.researchContext.recordCount, 1);
  assert.equal(result.researchContext.status, "unavailable");
  assert.match(result.researchContext.reason, /knowledge unavailable/);
  assert.ok(result.results[0].researchMatch.score > result.results[3].researchMatch.score);
  assert.equal(result.results[0].researchMatch.sources[0].resourceId, "research-hypothesis:hyp_original");
  assert.ok(result.results[0].researchMatch.categories.some((category) => category.id === "module"));
  assert.deepEqual(result.results[0].researchMatch.evidence, []);
});

function indexedNote(projectId, name, text) {
  const resource = catalog.putResource({ id: "file:" + name, kind: "knowledge", title: name, sourceType: "note", projectId });
  const config = getConfig().rag;
  const generationId = "g_" + name;
  catalog.saveGeneration({ id: generationId, resourceId: resource.id, config, sourceCreatedAt: "2026-01-01T00:00:00Z", sourceMetadata: {}, coverage: {} }, [{
    id: "ch_" + name, kind: "chunk", text, sectionPath: ["Methods"], pages: [2], elementIds: [], modalities: ["text"],
  }]);
  catalog.publish(generationId, resource.revision);
  return { resourceId: resource.id, generationId, title: name };
}

test("真实searchKnowledge：凭据不可用仍从当前项目的已发布原文召回，并排除另一个项目", async () => {
  const own = store.createProject("光伏实验");
  const other = store.createProject("另一个项目");
  research.saveProfile(own.id, profile);
  const local = indexedNote(own.id, "solar-local", hit().text);
  indexedNote(other.id, "solar-other", hit().text);
  let calls = 0;
  const result = await enrichResearchResults(candidates, "solar multimodal forecasting", {
    projectId: own.id,
    services: { searchKnowledge: async (...args) => { calls++; return searchKnowledge(...args); }, knowledgeServices: {
      embed: async () => { throw new Error("未配置测试凭据"); },
      rerank: async () => { throw new Error("未配置测试重排凭据"); },
    } },
  });
  assert.equal(calls, 1);
  assert.equal(result.researchContext.retrievalMode, "local-lexical");
  assert.equal(result.researchContext.evidenceCount, 1);
  assert.match(result.researchContext.warnings.join(" "), /词法证据/);
  assert.ok(result.results[0].researchMatch.evidence.length > 0);
  assert.ok(result.results.flatMap((row) => row.researchMatch.evidence).every((evidence) => evidence.resourceId === local.resourceId));
});

test("向量服务复用受共享预算约束：成功返回hybrid，悬挂服务仍及时回退词法", async () => {
  const project = store.createProject("光伏预算");
  research.saveProfile(project.id, profile);
  const local = indexedNote(project.id, "solar-budget", hit().text);
  let embeddings = 0;
  const hybrid = await enrichResearchResults(candidates.slice(0, 1), "solar", {
    projectId: project.id, services: { knowledgeServices: {
      embed: async (texts) => { embeddings++; return texts.map(() => [1, 0]); },
      index: { searchRoutes: async () => [{ name: "dense-vector", hits: [{ resource_id: local.resourceId, generation_id: local.generationId, canonical_id: "ch_solar-budget", score: 0.9 }] }] },
      rerank: async (query, documents) => documents.map((_, index) => ({ index, score: 0.9 })),
    } },
  });
  assert.ok(embeddings > 0);
  assert.equal(hybrid.researchContext.retrievalMode, "hybrid");
  const started = Date.now();
  const timedOut = await enrichResearchResults(candidates.slice(0, 1), "solar", {
    projectId: project.id, services: { networkBudgetMs: 20, knowledgeServices: {
      embed: async () => new Promise(() => {}),
      rerank: async () => new Promise(() => {}),
    } },
  });
  assert.ok(Date.now() - started < 1000, "悬挂服务必须在预算内结束等待");
  assert.equal(timedOut.researchContext.retrievalMode, "local-lexical");
  assert.ok(timedOut.results[0].researchMatch.evidence.length > 0);
  assert.match(timedOut.researchContext.warnings.join(" "), /超时|时间预算/);
});

test("调用方取消应传播，不能当作检索降级吞掉", async () => {
  const controller = new AbortController();
  controller.abort(new Error("用户取消"));
  await assert.rejects(enrichResearchResults(candidates, "solar", { projectId: "prj_test", services: services(), signal: controller.signal }), /用户取消/);
});
