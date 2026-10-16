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

test("F02/F03/F07/F09：跨项目复制隔离、重试恢复保配置、页码保留、原文可用性", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectA = (await call(fixture.url, "/projects", { method: "POST", body: { name: "原课题 A" } })).value.id;
  const projectB = (await call(fixture.url, "/projects", { method: "POST", body: { name: "副本课题 B" } })).value.id;

  // 准备 A：带页码的论文证据 + 失败运行 + 带完整配置的重试运行
  const evidenceA = await call(fixture.url, `/research/projects/${projectA}/evidence`, {
    method: "POST",
    body: { type: "fact", content: "第 7 页的对比数值", source: { kind: "paper", paperId: "fixture-paper", page: 7 } },
  });
  const evidenceAId = evidenceA.value.evidence.id;
  assert.deepEqual(evidenceA.value.evidence.source.pages, [7], "保存时页码为 [7]");

  const expA = await call(fixture.url, `/research/projects/${projectA}/experiments`, { method: "POST", body: { title: "A 实验" } });
  const run1 = await call(fixture.url, `/research/projects/${projectA}/runs`, {
    method: "POST",
    body: { label: "尝试1", experimentId: expA.value.experiment.id, status: "failed", error: "数据加载失败" },
  });
  const run2 = await call(fixture.url, `/research/projects/${projectA}/runs`, {
    method: "POST",
    body: {
      label: "尝试2-重试", experimentId: expA.value.experiment.id, status: "failed",
      config: { code: "commit-v2", data: "data-v1", environment: "gpu-test", seed: "42", notes: "lower-batch" },
      error: "数据加载失败",
      relation: { type: "retry", ofRunId: run1.value.run.id },
    },
  });

  const bundle = (await call(fixture.url, `/research/projects/${projectA}/export`)).value.export;

  // F02：导入 B 得到新身份
  const restored = await call(fixture.url, `/research/projects/${projectB}/import`, { method: "POST", body: { data: bundle } });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual(restored.value.errors, []);
  assert.equal(restored.value.imported.evidence, 1);
  const evidenceB = (await call(fixture.url, `/research/projects/${projectB}/evidence`)).value.evidence[0];
  assert.notEqual(evidenceB.id, evidenceAId, "B 的证据使用新身份");
  assert.deepEqual(evidenceB.source.pages, [7], "F07：恢复后页码保留");

  // F02：删除 B 的证据不影响 A
  await call(fixture.url, `/research/projects/${projectB}/evidence/${evidenceB.id}`, { method: "DELETE" });
  const stillA = await call(fixture.url, `/research/projects/${projectA}/evidence/${evidenceAId}`);
  assert.equal(stillA.status, 200, "删除副本后原课题证据仍可读");
  const listA = await call(fixture.url, `/research/projects/${projectA}/evidence`);
  assert.equal(listA.value.evidence.length, 1, "原课题证据列表不变");

  // F03：重试运行恢复后配置与失败原因逐字段保留
  const runsB = (await call(fixture.url, `/research/projects/${projectB}/runs`)).value.runs;
  assert.equal(runsB.length, 2);
  const retryB = runsB.find((r) => r.label === "尝试2-重试");
  const run1B = runsB.find((r) => r.label === "尝试1");
  assert.ok(retryB.relation, "重试关系存在");
  assert.notEqual(retryB.relation.ofRunId, run1.value.run.id, "F02：关系指向 B 自己的运行");
  assert.equal(retryB.relation.ofRunId, run1B.id);
  assert.deepEqual(
    {
      code: retryB.config.code, data: retryB.config.data, environment: retryB.config.environment,
      seed: retryB.config.seed, notes: retryB.config.notes, error: retryB.error,
    },
    { code: "commit-v2", data: "data-v1", environment: "gpu-test", seed: "42", notes: "lower-batch", error: "数据加载失败" },
    "F03：配置与失败原因逐字段保留",
  );

  // 同项目重复导入仍幂等（原语义不变）
  const again = await call(fixture.url, `/research/projects/${projectA}/import`, { method: "POST", body: { data: bundle } });
  assert.equal(again.value.imported.evidence, 0, "同项目重复导入跳过");
});

test("F09：仅元数据论文的报告不再显示为可用", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  // fixture 的论文只有元数据，没有 pdfPath —— 元数据匹配应为 metadata-only
  const projectA = (await call(fixture.url, "/projects", { method: "POST", body: { name: "元数据课题" } })).value.id;
  await fetch(fixture.url + "/api/projects/" + projectA, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addPaper: "fixture-paper" }),
  });
  const bundle = (await call(fixture.url, `/research/projects/${projectA}/export?scope=project`)).value.export;
  const target = (await call(fixture.url, "/projects", { method: "POST", body: { name: "元数据恢复目标" } })).value.id;
  const restored = await call(fixture.url, `/research/projects/${target}/import`, { method: "POST", body: { data: bundle } });
  assert.equal(restored.status, 200);
  assert.equal(restored.value.papers[0].status, "metadata-only", "无 PDF 的论文报告为仅元数据");
  assert.equal(restored.value.papers[0].matchedBy, "id");
});

test("F08：实验创建时绑定方案冻结版本，后续冻结不自动改绑", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = (await call(fixture.url, "/projects", { method: "POST", body: { name: "版本绑定验收" } })).value.id;
  const base = `/research/projects/${projectId}`;

  // 未冻结的方案 → 引用草稿
  const protocol = await call(fixture.url, base + "/protocols", {
    method: "POST",
    body: { title: "版本方案", budget: "单卡，最多 3 次" },
  });
  const protocolId = protocol.value.protocol.id;
  const expDraft = await call(fixture.url, base + "/experiments", {
    method: "POST",
    body: { title: "草稿期实验", protocolId },
  });
  assert.equal(expDraft.value.experiment.protocolVersion.kind, "draft", "引用未冻结方案标为草稿");

  // 冻结 V1 后建实验 → 绑定 V1
  await call(fixture.url, base + "/protocols/" + protocolId + "/freeze", { method: "POST", body: { reason: "V1 执行" } });
  const expV1 = await call(fixture.url, base + "/experiments", {
    method: "POST",
    body: { title: "V1 实验", protocolId },
  });
  const binding = expV1.value.experiment.protocolVersion;
  assert.equal(binding.kind, "frozen");
  assert.equal(binding.index, 1, "绑定冻结版本 V1");

  // 方案修改并冻结 V2 → 原 V1 实验不被改绑
  const updated = await call(fixture.url, base + "/protocols/" + protocolId, {
    method: "PUT",
    body: { ...protocol.value.protocol, status: "draft", budget: "追加 1 次尝试", revision: protocol.value.protocol.revision },
  });
  await call(fixture.url, base + "/protocols/" + protocolId + "/freeze", { method: "POST", body: { reason: "V2 调整" } });
  const stillV1 = await call(fixture.url, base + "/experiments");
  const v1Record = stillV1.value.experiments.find((e) => e.id === expV1.value.experiment.id);
  assert.equal(v1Record.protocolVersion.index, 1, "后续冻结 V2 不改绑 V1 实验");
  const protocols = await call(fixture.url, base + "/protocols");
  assert.equal(protocols.value.protocols[0].versions.length, 2, "V2 已存在");

  // 无方案实验保持未绑定
  const expFree = await call(fixture.url, base + "/experiments", { method: "POST", body: { title: "无方案实验" } });
  assert.equal(expFree.value.experiment.protocolVersion, null);

  // 旧实验（无 protocolVersion 字段）显示语义由前端 label 兜底，导入导出保留绑定
  const bundle = (await call(fixture.url, base + "/export")).value.export;
  const target = (await call(fixture.url, "/projects", { method: "POST", body: { name: "版本恢复目标" } })).value.id;
  const restored = await call(fixture.url, `/research/projects/${target}/import`, { method: "POST", body: { data: bundle } });
  assert.equal(restored.value.errors.length, 0);
  const restoredExp = (await call(fixture.url, `/research/projects/${target}/experiments`)).value.experiments
    .find((e) => e.title === "V1 实验");
  assert.equal(restoredExp.protocolVersion.index, 1, "恢复保留版本绑定");
});
