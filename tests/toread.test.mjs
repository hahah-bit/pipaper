import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("待读去重保留本地 ID、PDF 和完整标题区分，持久化后可删除", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-toread-"));
  process.env.PIPAPER_DATA_DIR = directory;
  t.after(async () => {
    (await import("../server/storage/catalog.js")).closeCatalog();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("pipaper-toread-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = await import("../server/toread.js");
  const first = store.toreadAdd({ id: "external-one", title: "One paper", doi: "10.1000/example", pdfUrl: "https://example.test/paper.pdf" });
  const duplicate = store.toreadAdd({ id: "external-two", title: "One paper", doi: " https://doi.org/10.1000/EXAMPLE " });
  assert.equal(duplicate.dup, true);
  assert.equal(duplicate.entry.id, first.entry.id);
  assert.equal(duplicate.entry.pdfUrl, "https://example.test/paper.pdf");
  assert.equal(store.toreadList().length, 1);
  const match = { projectId: "project-test", score: 72, level: "moderate", confidence: "medium", basis: "project+rag",
    categories: [{ id: "module", label: "改模块", reason: "可比较特征提取模块" }], reasons: ["与研究目标相关"],
    evidence: [{ resourceId: "paper:local", generationId: "g1", recordId: "c1", title: "项目基线", pages: [3], text: "来源原文", data: "do-not-store" }],
    vector: [1, 2, 3], apiKey: "do-not-store" };
  const withMatch = store.toreadAdd({ title: "One paper", doi: "10.1000/example", researchMatch: match });
  assert.equal(withMatch.entry.researchMatch.categories[0].id, "module");
  assert.deepEqual(withMatch.entry.researchMatch.evidence[0].pages, [3]);
  assert.equal(withMatch.entry.researchMatch.apiKey, undefined);
  assert.equal(withMatch.entry.researchMatch.evidence[0].data, undefined);
  assert.equal(store.toreadUpdate(first.entry.id, { purposeCategories: ["topic", "topic"] }).purposeCategories.length, 1);
  store.toreadAdd({ title: "One paper", doi: "10.1000/example" });
  assert.deepEqual(store.toreadList()[0].purposeCategories, ["topic"], "重新收集不能覆盖人工分类");
  assert.throws(() => store.toreadUpdate(first.entry.id, { purposeCategories: ["unknown"] }), /有效的分类/);
  assert.throws(() => store.toreadUpdate("missing", { purposeCategories: [] }), error => error.status === 404);
  store.toreadUpdate(first.entry.id, { purposeCategories: [] });
  assert.deepEqual(store.toreadList()[0].purposeCategories, [], "空列表恢复自动建议");
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "to-read.json"), "utf8"));
  assert.equal(saved[0].id, first.entry.id);
  assert.ok(store.toreadDelete(first.entry.id));
  assert.equal(store.toreadList().length, 0);
  const prefix = "Long research topic ".repeat(6);
  store.toreadAdd({ title: prefix + "Part One" });
  store.toreadAdd({ title: prefix + "Part Two" });
  assert.equal(store.toreadList().length, 2);
});
