import test from "node:test";
import assert from "node:assert/strict";
import { purposeCategories, filterSearchResults, evidenceLabel, createRequestGate } from "../src/searchModel.js";

test("研究用途可多分类；人工调整优先，清空恢复建议且未知分类不进入界面", () => {
  const entry = { researchMatch: { categories: [
    { id: "innovation", label: "任意外部文本", reason: "研究瓶颈相近" },
    { id: "module", reason: "可核对模块接口" },
    { id: "unknown" },
  ] } };
  assert.deepEqual(purposeCategories(entry), [
    { id: "innovation", label: "找创新点", reason: "研究瓶颈相近" },
    { id: "module", label: "改模块", reason: "可核对模块接口" },
  ]);
  assert.deepEqual(purposeCategories({ ...entry, purposeCategories: ["topic"] }).map(item => item.id), ["topic"]);
  assert.deepEqual(purposeCategories({ ...entry, purposeCategories: [] }), purposeCategories(entry));
  assert.deepEqual(purposeCategories(null), []);
});

test("用途筛选区分待判断结果，研究匹配排序不修改原结果", () => {
  const results = [
    { title: "pending", researchMatch: { score: 99, categories: [] } },
    { title: "lower", readScore: 95, researchMatch: { score: 40, categories: [{ id: "module" }] } },
    { title: "higher", readScore: 50, researchMatch: { score: 80, categories: [{ id: "module" }, { id: "innovation" }] } },
  ];
  assert.deepEqual(filterSearchResults(results, "module", "research").map(item => item.title), ["higher", "lower"]);
  assert.deepEqual(filterSearchResults(results, "innovation").map(item => item.title), ["higher"]);
  assert.equal(filterSearchResults(results).length, 3);
  assert.equal(results[0].title, "pending");
  assert.deepEqual(filterSearchResults(results, "topic"), []);
});

test("证据引用使用真实页码和章节，缺失页码明确标注", () => {
  assert.equal(evidenceLabel({ title: "Baseline", pages: [2, 7], sectionPath: ["Methods", "Encoder"] }), "Baseline · 第 2、7 页 · Methods › Encoder");
  assert.equal(evidenceLabel({ resourceId: "paper:p1", pages: [] }), "paper:p1 · 未提供页码");
  assert.equal(evidenceLabel({ title: "档案记录", pages: 0 }), "档案记录 · 第 0 页");
});

test("新搜索和取消使旧请求失效，即使旧响应忽略 abort 后返回也不能更新 UI", async () => {
  const gate = createRequestGate();
  const first = gate.begin();
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  let displayed = "";
  const firstResult = delayed.then(() => { if (gate.isCurrent(first)) displayed = "old"; });
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  if (gate.isCurrent(second)) displayed = "new";
  finish();
  await firstResult;
  assert.equal(displayed, "new");
  gate.cancel();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(second.signal.aborted, true);
  assert.equal(gate.isCurrent(gate.begin()), true);
});
