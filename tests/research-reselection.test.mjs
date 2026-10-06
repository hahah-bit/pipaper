import test from "node:test";
import assert from "node:assert/strict";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";

async function call(url, route, { method = "GET", body } = {}) {
  const response = await fetch(url + "/api" + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, value: await response.json().catch(() => null) };
}

async function createProject(url, name) {
  const created = await call(url, "/projects", { method: "POST", body: { name } });
  assert.equal(created.status, 200, "创建项目失败: " + JSON.stringify(created.value));
  return created.value.id;
}

test("二次选题：输入快照、失败不被忽略、候选回写新草稿且不重复", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "二次选题验收");

  // 准备既有成果：一个失败运行 + 一条探索性结论
  const exp = await call(fixture.url, `/research/projects/${projectId}/experiments`, {
    method: "POST", body: { title: "旧实验" },
  });
  const failedRun = await call(fixture.url, `/research/projects/${projectId}/runs`, {
    method: "POST",
    body: { label: "失败尝试", experimentId: exp.value.experiment.id, status: "failed", error: "第 30 轮显存不足" },
  });
  const conclusion = await call(fixture.url, `/research/projects/${projectId}/conclusions`, {
    method: "POST",
    body: { statement: "修正后指标改善，但未做多种子验证", kind: "exploratory" },
  });

  const base = `/research/projects/${projectId}/reselections`;
  const badRef = await call(fixture.url, base, {
    method: "POST",
    body: { title: "坏输入", contextRefs: [{ kind: "hypothesis", id: "hyp_missing" }] },
  });
  assert.equal(badRef.status, 404, "不存在的输入记录应拒绝");

  const created = await call(fixture.url, base, {
    method: "POST",
    body: {
      title: "第二轮方向分析",
      contextRefs: [
        { kind: "run", id: failedRun.value.run.id },
        { kind: "conclusion", id: conclusion.value.conclusion.id },
      ],
      openQuestions: [
        { text: "多种子下修正是否仍有效", category: "open" },
        { text: "失败运行的显存问题能否用梯度累积绕开", category: "failed", sourceRef: { kind: "run", id: failedRun.value.run.id } },
      ],
      candidates: [
        {
          text: "以梯度累积复跑并做多种子验证",
          rationale: "显存失败模式有明确绕开路径；修正效果已有探索性结论",
          basedOn: [{ kind: "run", id: failedRun.value.run.id }, { kind: "conclusion", id: conclusion.value.conclusion.id }],
          verification: "3 个种子 × 2 组对照",
        },
      ],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  let record = created.value.reselection;
  assert.equal(record.contextSnapshot.length, 2, "输入快照保存当时摘要");
  assert.equal(record.contextSnapshot[0].summary.error, "第 30 轮显存不足", "失败运行进入快照");
  assert.equal(record.openQuestions[1].category, "failed");

  // 候选回写 → 新假设草稿
  const draft = await call(fixture.url, base + "/" + record.id + "/draft", {
    method: "POST",
    body: { candidateId: record.candidates[0].id, target: "hypothesis" },
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.value));
  const hypothesisId = draft.value.draft.id;
  assert.equal(draft.value.draft.kind, "hypothesis");

  const again = await call(fixture.url, base + "/" + record.id + "/draft", {
    method: "POST",
    body: { candidateId: record.candidates[0].id, target: "protocol" },
  });
  assert.equal(again.status, 409, "同一候选不能重复建立草稿");

  record = (await call(fixture.url, base + "/" + record.id)).value.reselection;
  assert.equal(record.candidates[0].createdHypothesisId, hypothesisId, "候选记录回写的草稿 ID");

  const hypothesis = await call(fixture.url, `/research/projects/${projectId}/hypotheses/${hypothesisId}`);
  assert.match(hypothesis.value.hypothesis.sourceNote, /二次选题 · 第二轮方向分析/, "新草稿注明来源");

  // 记录决定
  const decided = await call(fixture.url, base + "/" + record.id, {
    method: "PUT",
    body: { ...record, decision: { choice: "shrink", reason: "先验证稳定性再扩展" }, revision: record.revision },
  });
  assert.equal(decided.value.reselection.decision.choice, "shrink");

  const conflict = await call(fixture.url, base + "/" + record.id, {
    method: "PUT",
    body: { ...record, revision: 0 },
  });
  assert.equal(conflict.status, 409);

  const removed = await call(fixture.url, base + "/" + record.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const restored = await call(fixture.url, `/storage/resources/${"research-reselection:" + record.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  const afterRestore = await call(fixture.url, base);
  assert.equal(afterRestore.value.reselections.length, 1);
  assert.equal(afterRestore.value.reselections[0].contextSnapshot[0].summary.error, "第 30 轮显存不足", "恢复保留输入快照");
});
