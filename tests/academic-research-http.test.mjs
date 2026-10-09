import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";

test("学术检索接入研究匹配，分类经待读和导入持久化，增强失败保留搜索", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-search-http-"));
  process.env.PIPAPER_DATA_DIR = path.join(directory, "data");
  process.env.PIPAPER_LIBRARY_DIR = path.join(directory, "library");
  const store = await import("../server/store.js");
  const { closeCatalog } = await import("../server/storage/catalog.js");
  const { registerAcademicRoutes } = await import("../server/modules/academic/routes.js");
  const project = store.createProject("视觉异常检测");
  const secondProject = store.createProject("另一个研究");
  const app = express(); app.use(express.json());
  const api = express.Router();
  let failMatch = false, matchCalls = 0, aggregateOptions, remoteCalls = 0, deleteProjectDuringDownload;
  const match = { projectId: project.id, score: 78, level: "moderate", basis: "project+rag", confidence: "medium",
    reasons: ["可比较局部特征模块"], categories: [{ id: "module", label: "改模块", reason: "局部特征" }],
    evidence: [{ resourceId: "paper:p1", generationId: "g1", recordId: "c1", title: "基线", pages: [4], text: "证据原文" }] };
  registerAcademicRoutes(api, {
    aggregateSearch: async (_query, options) => {
      aggregateOptions = options;
      return { results: [{ title: "Weak result", authors: [], readScore: 90 }, { title: "Local feature adaptation", authors: [], readScore: 50 }], total: 2,
        errors: ["semanticscholar: HTTP 429"], status: "partial", sourceStatus: [{ id: "semanticscholar", status: "error" }] };
    },
    enrichResearchResults: async (results, _query, options) => {
      matchCalls++; if (failMatch) throw new Error("test retrieval failure");
      return { results: results.map((result, index) => ({ ...result, researchMatch: { ...match, score: index ? 78 : 4 } })),
        researchContext: { enabled: true, projectId: options.projectId, question: "改进异常检测", profileAvailable: true, indexReady: true, evidenceCount: 1 } };
    },
    remote: async () => {
      remoteCalls++;
      const buffer = Buffer.alloc(12000, 32); buffer.write("%PDF-1.4\n");
      if (deleteProjectDuringDownload) {
        buffer.write("different PDF for deleted project", 100);
        store.deleteProject(deleteProjectDuringDownload);
        deleteProjectDuringDownload = null;
      }
      return { buffer };
    },
  });
  app.use("/api", api);
  const server = await new Promise(resolve => { const handle = app.listen(0, "127.0.0.1", () => resolve(handle)); });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    store.flushStore(); closeCatalog();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("pipaper-search-http-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  async function call(route, method = "GET", body) {
    const response = await fetch(url + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json() };
  }
  const search = await call(`/search?q=anomaly&projectId=${project.id}&sort=research&sources=arxiv&limit=10000`);
  assert.equal(search.status, 200);
  assert.equal(search.value.results[0].title, "Local feature adaptation", "研究匹配分应覆盖综合推荐排序");
  assert.equal(search.value.researchContext.question, "改进异常检测");
  assert.equal(search.value.status, "partial");
  assert.equal(aggregateOptions.limit, 60);
  assert.deepEqual(aggregateOptions.sources, ["arxiv"]);
  await call(`/search?q=anomaly&projectId=${project.id}&research=0&sources=`);
  assert.equal(matchCalls, 1, "关闭研究匹配不调用知识库");
  assert.deepEqual(aggregateOptions.sources, [], "未选源应传递空列表而非默认所有源");
  failMatch = true;
  const degraded = await call(`/search?q=anomaly&projectId=${project.id}`);
  assert.equal(degraded.status, 200);
  assert.equal(degraded.value.results.length, 2);
  assert.equal(degraded.value.researchContext.status, "unavailable");
  assert.equal((await call("/search?q=anomaly&projectId=missing")).status, 404);
  const added = await call("/search/toread", "POST", { title: "Local feature adaptation", authors: [], researchMatch: match });
  assert.equal(added.status, 200);
  const readingId = added.value.entry.id;
  const changed = await call(`/search/toread/${readingId}`, "PATCH", { purposeCategories: ["innovation", "topic"] });
  assert.deepEqual(changed.value.entry.purposeCategories, ["innovation", "topic"]);
  assert.equal((await call(`/search/toread/${readingId}`, "PATCH", { purposeCategories: ["invalid"] })).status, 400);
  assert.equal((await call("/search/toread/missing", "PATCH", { purposeCategories: [] })).status, 404);
  const imported = await call("/search/import", "POST", { pdfUrl: "https://arxiv.org/pdf/2601.00001", title: "Local feature adaptation", projectId: project.id, researchMatch: match, purposeCategories: ["module"] });
  assert.equal(imported.status, 200);
  assert.deepEqual(store.getPaper(imported.value.id).literatureContexts[project.id].purposeCategories, ["module"]);
  assert.deepEqual(store.getPaper(imported.value.id).literatureContexts[project.id].researchMatch.evidence[0].pages, [4]);
  const { buildLocalProfile } = await import("../server/search/readscore.js");
  const emptyProfile = buildLocalProfile({ projectId: secondProject.id, anchorPaperId: imported.value.id });
  assert.equal(emptyProfile.scope, "project");
  assert.deepEqual(emptyProfile.docs, [], "空项目的综合推荐画像也不能回退全库");
  assert.equal(emptyProfile.anchor, null, "其他项目打开的论文不能作为当前项目参照");
  const reused = await call("/search/import", "POST", { pdfUrl: "https://arxiv.org/pdf/2601.00001", title: "Local feature adaptation", projectId: secondProject.id, researchMatch: match, purposeCategories: ["topic"] });
  assert.equal(reused.value.id, imported.value.id);
  assert.deepEqual(store.getPaper(imported.value.id).literatureContexts[project.id].purposeCategories, ["module"], "不同项目分类独立");
  assert.deepEqual(store.getPaper(imported.value.id).literatureContexts[secondProject.id].purposeCategories, ["topic"]);
  assert.equal(reused.value.matchDiscarded, true);
  assert.equal(store.getPaper(imported.value.id).literatureContexts[secondProject.id].researchMatch, undefined, "不得将A项目原文证据重新标记为B项目匹配");
  assert.equal((await call("/search/import", "POST", { pdfUrl: "https://arxiv.org/pdf/2601.00001", projectId: "missing" })).status, 404);
  assert.equal(remoteCalls, 2, "无效项目不得下载");
  const deletedProject = store.createProject("下载期间删除的研究");
  const paperCountBefore = store.listPapers().length;
  const pdfFilesBefore = fs.readdirSync(path.join(directory, "library"));
  deleteProjectDuringDownload = deletedProject.id;
  const cancelledImport = await call("/search/import", "POST", { pdfUrl: "https://arxiv.org/pdf/2601.00002", title: "Deleted target", projectId: deletedProject.id, purposeCategories: ["background"] });
  assert.equal(cancelledImport.status, 404, "下载结束时必须再次核对项目是否仍存在");
  assert.match(cancelledImport.value.error, /项目已删除/);
  assert.equal(store.listPapers().length, paperCountBefore, "项目已删除时不能先将新PDF入库");
  assert.deepEqual(fs.readdirSync(path.join(directory, "library")), pdfFilesBefore, "不能留下下载的新PDF文件");
  assert.equal(store.getPaper(imported.value.id).literatureContexts[deletedProject.id], undefined);
  const semantic = await call("/search/sources/add", "POST", { url: "https://api.semanticscholar.org", apiKey: "private-test-key" });
  assert.equal(semantic.value.source.type, "semanticscholar", "Semantic Scholar应正确识别为API而非镜像");
  assert.ok(!JSON.stringify(semantic.value).includes("private-test-key"));
  const alex = await call("/search/sources/add", "POST", { url: "https://api.openalex.org", apiKey: "private-alex-key" });
  assert.equal(alex.value.source.type, "openalex");
  assert.equal(alex.value.source.enabled, true);
  assert.ok(!JSON.stringify(alex.value).includes("private-alex-key"));
});
