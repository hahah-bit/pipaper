import test from "node:test";
import assert from "node:assert/strict";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";

// 对应验收报告 F01/F05：局部操作不得清空其他已保存字段。
async function call(url, route, { method = "GET", body } = {}) {
  const response = await fetch(url + "/api" + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, value: await response.json().catch(() => null) };
}

test("F01：行动与成果的局部操作不清空研究问题、范围、目标与约束", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const created = await call(fixture.url, "/projects", { method: "POST", body: { name: "F01 验收" } });
  const projectId = created.value.id;
  const base = `/research/projects/${projectId}/profile`;

  // 等待启动恢复完成（清单恢复可能滞后于 health）
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await call(fixture.url, "/projects");
    if (list.value?.projects?.some((p) => p.id === projectId)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const saved = await call(fixture.url, base, {
    method: "PUT",
    body: {
      question: "在当前复现条件下出现哪些失败模式？",
      scope: "线缆接头检测复现",
      goal: "完成基线对齐",
      constraints: "单卡 8G",
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const revision = saved.value.profile.revision;

  // 依次：添加行动 → 改状态 → 删除行动 → 关联成果 → 解除关联
  const withAction = await call(fixture.url, base, {
    method: "PUT",
    body: { actions: [{ text: "导入基线结果", status: "todo" }], revision },
  });
  assert.equal(withAction.status, 200, JSON.stringify(withAction.value));
  const action = withAction.value.profile.actions[0];

  const statusChanged = await call(fixture.url, base, {
    method: "PUT",
    body: { actions: [{ ...action, status: "blocked", blockedReason: "缺原始日志" }] },
  });
  assert.equal(statusChanged.status, 200, JSON.stringify(statusChanged.value));

  const outcomeAdded = await call(fixture.url, base, {
    method: "PUT",
    body: { outcomes: [{ refId: "paper:fixture-paper" }] },
  });
  assert.equal(outcomeAdded.status, 200, JSON.stringify(outcomeAdded.value));

  const outcomeRemoved = await call(fixture.url, base, {
    method: "PUT",
    body: { outcomes: [] },
  });
  assert.equal(outcomeRemoved.status, 200, JSON.stringify(outcomeRemoved.value));

  const actionDeleted = await call(fixture.url, base, {
    method: "PUT",
    body: { actions: [] },
  });
  assert.equal(actionDeleted.status, 200, JSON.stringify(actionDeleted.value));

  // 每一步之后四项文本必须保持（报告验收条件）
  for (const step of [withAction, statusChanged, outcomeAdded, outcomeRemoved, actionDeleted]) {
    assert.equal(step.value.profile.question, "在当前复现条件下出现哪些失败模式？", "question 被局部操作清空");
    assert.equal(step.value.profile.scope, "线缆接头检测复现", "scope 被局部操作清空");
    assert.equal(step.value.profile.goal, "完成基线对齐", "goal 被局部操作清空");
    assert.equal(step.value.profile.constraints, "单卡 8G", "constraints 被局部操作清空");
  }

  // 显式清空仍然有效（省略≠清空，传空字符串才是清空）
  const cleared = await call(fixture.url, base, { method: "PUT", body: { question: "" } });
  assert.equal(cleared.value.profile.question, "");
  assert.equal(cleared.value.profile.scope, "线缆接头检测复现", "清空 question 不影响 scope");
});

test("F04/F06：后端拒绝空值指标、状态词表归一且未知状态报错", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const created = await call(fixture.url, "/projects", { method: "POST", body: { name: "导入语义验收" } });
  const projectId = created.value.id;
  const exp = await call(fixture.url, `/research/projects/${projectId}/experiments`, {
    method: "POST", body: { title: "导入语义实验" },
  });
  const runBase = `/research/projects/${projectId}/runs`;

  // 空字符串指标 → 400，而不是 0
  const emptyMetric = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "空指标行", experimentId: exp.value.experiment.id, metrics: [{ name: "accuracy", value: "" }] },
  });
  assert.equal(emptyMetric.status, 400);
  assert.match(emptyMetric.value.error, /不能记为 0/);

  // null 指标同样拒绝
  const nullMetric = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "null 指标", experimentId: exp.value.experiment.id, metrics: [{ name: "a", value: null }] },
  });
  assert.equal(nullMetric.status, 400);

  // 真正的 0 与负数保留
  const zero = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "真零", experimentId: exp.value.experiment.id, status: "succeeded", metrics: [{ name: "a", value: 0 }, { name: "b", value: "-1.5" }] },
  });
  assert.equal(zero.status, 200);
  assert.deepEqual(zero.value.run.metrics.map((m) => m.value), [0, -1.5]);

  // 中英文状态词表
  for (const [word, expected] of [["succeeded", "succeeded"], ["Succeeded", "succeeded"], ["失败", "failed"], ["failed", "failed"], ["中止", "stopped"]]) {
    const run = await call(fixture.url, runBase, {
      method: "POST",
      body: { label: "状态-" + word, experimentId: exp.value.experiment.id, status: word },
    });
    assert.equal(run.status, 200, word + ": " + JSON.stringify(run.value));
    assert.equal(run.value.run.status, expected, word + " 应解析为 " + expected);
  }

  // 未知状态 → 400 明确报错
  const unknown = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "未知状态", experimentId: exp.value.experiment.id, status: "banana" },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.value.error, /无法识别的运行状态/);
});
