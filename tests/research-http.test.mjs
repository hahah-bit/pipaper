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
  const projectId = created.value.id;
  // 服务器 health 就绪后 bootstrap 的清单恢复可能仍在进行，等待项目在列表中稳定可见。
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = await call(url, "/projects");
    if (list.value?.projects?.some((p) => p.id === projectId)) return projectId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail("项目创建后未出现在项目列表（启动恢复未完成或项目被覆盖）");
}

test("研究档案：未启用为空，保存后可读取与更新，冲突返回 409", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "研究档案验收");

  const empty = await call(fixture.url, `/research/projects/${projectId}/profile`);
  assert.equal(empty.status, 200);
  assert.equal(empty.value.profile, null, "未启用的档案应为空");

  const saved = await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: {
      question: "在当前复现条件下出现哪些检测失败模式？",
      scope: "线缆接头检测复现",
      goal: "完成基线对齐并登记探索性发现",
      constraints: "单卡 8G 显存",
      outcomes: [{ refId: "paper:fixture-paper" }],
      actions: [
        { text: "导入基线结果", status: "doing" },
        { text: "核对指标列映射", status: "blocked", blockedReason: "缺原始日志" },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const profile = saved.value.profile;
  assert.equal(profile.revision, 1);
  assert.equal(profile.outcomes[0].title, "本地验收论文", "成果关联应解析论文标题");
  assert.equal(profile.actions.length, 2);
  assert.equal(profile.actions[1].blockedReason, "缺原始日志");
  assert.ok(profile.actions[0].id, "行动项应生成稳定 id");

  const conflict = await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: { question: "过期修改", revision: 0 },
  });
  assert.equal(conflict.status, 409, "过期 revision 应返回 409");

  const updated = await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: { question: "更新后的问题", revision: profile.revision },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.value.profile.revision, 2);
  assert.equal(updated.value.profile.actions.length, 0, "未提交的行动项不应保留");
  assert.equal(updated.value.profile.createdAt, profile.createdAt, "创建时间应保持");
});

test("研究档案：无效输入与未知项目得到明确错误", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "错误处理验收");

  const missing = await call(fixture.url, "/research/projects/prj_nope/profile");
  assert.equal(missing.status, 404);

  const badRef = await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: { outcomes: [{ refId: "paper:missing-paper" }] },
  });
  assert.equal(badRef.status, 400);

  const badAction = await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: { actions: [{ text: "   " }] },
  });
  assert.equal(badAction.status, 400);
});

test("研究档案：删除进入回收站，可从回收站恢复；重启后数据保持", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "恢复验收");
  const saved = await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: { question: "待恢复的问题", actions: [{ text: "恢复后继续" }] },
  });
  const resourceId = "research-profile:" + projectId;

  const removed = await call(fixture.url, `/research/projects/${projectId}/profile`, { method: "DELETE" });
  assert.equal(removed.status, 200, JSON.stringify(removed.value));
  const afterDelete = await call(fixture.url, `/research/projects/${projectId}/profile`);
  assert.equal(afterDelete.value.profile, null, "删除后档案应视为未启用");

  const trashed = await call(fixture.url, "/storage/resources?kind=research-profile");
  const entry = trashed.value.resources.find((r) => r.id === resourceId);
  assert.ok(entry, "回收站列表应包含研究档案");
  assert.equal(entry.lifecycle, "trashed");

  const restored = await call(fixture.url, `/storage/resources/${resourceId}/restore`, { method: "POST" });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  const afterRestore = await call(fixture.url, `/research/projects/${projectId}/profile`);
  assert.equal(afterRestore.value.profile.question, "待恢复的问题");
  assert.equal(afterRestore.value.profile.actions[0].text, "恢复后继续");

  await fixture.restart();
  const afterRestart = await call(fixture.url, `/research/projects/${projectId}/profile`);
  assert.equal(afterRestart.value.profile.question, "待恢复的问题", "重启后档案数据应保持");
});

test("证据卡：从论文与知识检索保存，可更新、冲突检测与回收站恢复", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "证据卡验收");
  const base = `/research/projects/${projectId}/evidence`;

  const missingSource = await call(fixture.url, base, { method: "POST", body: { content: "没有来源", source: { kind: "retrieval" } } });
  assert.equal(missingSource.status, 400, "检索证据缺 resourceId/recordId 应拒绝");

  const manualNoLabel = await call(fixture.url, base, { method: "POST", body: { content: "手工记录", source: { kind: "manual" } } });
  assert.equal(manualNoLabel.status, 400, "手工证据必须说明来源");

  const paperCard = await call(fixture.url, base, {
    method: "POST",
    body: {
      type: "author-claim",
      content: "原文表 2 报告 AUROC 0.976",
      conditions: "仅在批次 32、轮次 40 条件下",
      source: { kind: "paper", paperId: "fixture-paper", page: 6 },
    },
  });
  assert.equal(paperCard.status, 200, JSON.stringify(paperCard.value));
  const card = paperCard.value.evidence;
  assert.equal(card.source.label, "本地验收论文", "论文来源应自动补充标题");
  assert.deepEqual(card.source.pages, [6]);
  assert.equal(card.revision, 1);

  const conflict = await call(fixture.url, `${base}/${card.id}`, { method: "PUT", body: { content: "过期更新", revision: 0 } });
  assert.equal(conflict.status, 409);

  const updated = await call(fixture.url, `${base}/${card.id}`, {
    method: "PUT",
    body: { content: card.content, checked: true, revision: card.revision },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.value.evidence.checked, true, "人工核对状态应可更新");

  const retrievalCard = await call(fixture.url, base, {
    method: "POST",
    body: {
      type: "fact",
      content: "知识检索发现的对比数值",
      source: { kind: "retrieval", resourceId: "file:missing", recordId: "rec_1", pages: [3, 4], sectionPath: ["实验", "表格"] },
    },
  });
  assert.equal(retrievalCard.status, 400, "resourceId 不存在时应拒绝");

  const list = await call(fixture.url, base);
  assert.equal(list.value.evidence.length, 1);
  assert.equal(list.value.evidence[0].id, card.id);

  const removed = await call(fixture.url, `${base}/${card.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const afterDelete = await call(fixture.url, base);
  assert.equal(afterDelete.value.evidence.length, 0, "删除后列表不应包含证据");

  const trashed = await call(fixture.url, "/storage/resources?kind=research-evidence");
  const entry = trashed.value.resources.find((r) => r.id === "research-evidence:" + card.id);
  assert.equal(entry?.lifecycle, "trashed");
  const restored = await call(fixture.url, `/storage/resources/${"research-evidence:" + card.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  const afterRestore = await call(fixture.url, base);
  assert.equal(afterRestore.value.evidence.length, 1, "恢复后证据应重新出现");
  assert.equal(afterRestore.value.evidence[0].checked, true, "恢复保留核对状态");

  const detail = await call(fixture.url, `${base}/${card.id}`);
  assert.equal(detail.status, 200);
  const missingDetail = await call(fixture.url, `${base}/ev_nope`);
  assert.equal(missingDetail.status, 404);
});

test("文献对比表：创建、单元格来源状态、冲突检测与回收站恢复", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "对比表验收");
  const base = `/research/projects/${projectId}/matrices`;

  const badPaper = await call(fixture.url, base, { method: "POST", body: { title: "缺论文", paperIds: ["nope"], columns: ["指标"] } });
  assert.equal(badPaper.status, 400, "不存在的论文应拒绝");

  const created = await call(fixture.url, base, {
    method: "POST",
    body: {
      title: "失败模式对比",
      conditions: "复现条件与原文存在批次差异",
      paperIds: ["fixture-paper"],
      columns: [{ id: "col_1", name: "AUROC" }, { id: "col_2", name: "训练轮次" }],
      cells: {
        "fixture-paper|col_1": { value: "0.976", status: "unverified", sourceLabel: "表2", page: 6 },
        "fixture-paper|col_2": { status: "not-reported" },
      },
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const matrix = created.value.matrix;
  assert.equal(matrix.revision, 1);
  assert.equal(matrix.cells["fixture-paper|col_1"].sourceLabel, "表2");
  assert.equal(matrix.cells["fixture-paper|col_2"].value, "", "未报告不需要值");
  assert.equal(matrix.cells["fixture-paper|col_2"].status, "not-reported");

  const badCell = await call(fixture.url, base + "/" + matrix.id, {
    method: "PUT",
    body: { title: matrix.title, paperIds: matrix.paperIds, columns: matrix.columns, cells: { "other|col_1": { value: "x" } }, revision: matrix.revision },
  });
  assert.equal(badCell.status, 400, "不属于矩阵的单元格应拒绝");

  const conflict = await call(fixture.url, base + "/" + matrix.id, {
    method: "PUT",
    body: { title: matrix.title, paperIds: matrix.paperIds, columns: matrix.columns, cells: {}, revision: 0 },
  });
  assert.equal(conflict.status, 409);

  const updated = await call(fixture.url, base + "/" + matrix.id, {
    method: "PUT",
    body: { title: matrix.title, conditions: matrix.conditions, paperIds: matrix.paperIds, columns: matrix.columns, cells: matrix.cells, revision: matrix.revision },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.value.matrix.revision, 2);

  const list = await call(fixture.url, base);
  assert.equal(list.value.matrices.length, 1);

  const removed = await call(fixture.url, base + "/" + matrix.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const afterDelete = await call(fixture.url, base);
  assert.equal(afterDelete.value.matrices.length, 0);

  const restored = await call(fixture.url, `/storage/resources/${"research-matrix:" + matrix.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  const afterRestore = await call(fixture.url, base);
  assert.equal(afterRestore.value.matrices.length, 1);
  assert.equal(afterRestore.value.matrices[0].cells["fixture-paper|col_1"].page, 6, "恢复后单元格来源保留");
});

test("研究假设：登记、证据依据校验、决策历史与回收站恢复", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "假设验收");
  const hypBase = `/research/projects/${projectId}/hypotheses`;
  const evBase = `/research/projects/${projectId}/evidence`;

  const evidence = await call(fixture.url, evBase, {
    method: "POST",
    body: { type: "fact", content: "修正掩码后 IoU 提升", source: { kind: "paper", paperId: "fixture-paper" } },
  });
  const evidenceId = evidence.value.evidence.id;

  const badRef = await call(fixture.url, hypBase, {
    method: "POST",
    body: { title: "缺依据", statement: "x", support: ["ev_missing"] },
  });
  assert.equal(badRef.status, 400, "不存在的证据不能作为依据");

  const created = await call(fixture.url, hypBase, {
    method: "POST",
    body: {
      title: "掩码修正解释指标差异",
      statement: "失败样本主要来自掩码口径不一致",
      prediction: "修正后 IoU 与原文差距缩小",
      counterExamples: "也可能是阈值选择差异",
      support: [evidenceId],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const hyp = created.value.hypothesis;
  assert.equal(hyp.decision, null, "未做决策时应为空");
  assert.deepEqual(hyp.decisionHistory, []);

  const decide = await call(fixture.url, hypBase + "/" + hyp.id, {
    method: "PUT",
    body: { ...hyp, decision: { status: "continue", reason: "预测可低成本验证" }, revision: hyp.revision },
  });
  assert.equal(decide.status, 200);
  assert.equal(decide.value.hypothesis.decision.status, "continue");
  assert.equal(decide.value.hypothesis.decisionHistory.length, 1);
  assert.match(decide.value.hypothesis.decisionHistory[0].reason, /低成本验证/);

  const again = await call(fixture.url, hypBase + "/" + hyp.id, {
    method: "PUT",
    body: { ...decide.value.hypothesis, revision: decide.value.hypothesis.revision },
  });
  assert.equal(again.value.hypothesis.decisionHistory.length, 1, "未改变状态的保存不应重复记录历史");

  const stopped = await call(fixture.url, hypBase + "/" + hyp.id, {
    method: "PUT",
    body: { ...again.value.hypothesis, decision: { status: "hold", reason: "等待更多数据" }, revision: again.value.hypothesis.revision },
  });
  assert.equal(stopped.value.hypothesis.decisionHistory.length, 2, "状态变化应追加历史");

  const conflict = await call(fixture.url, hypBase + "/" + hyp.id, {
    method: "PUT",
    body: { ...stopped.value.hypothesis, revision: 0 },
  });
  assert.equal(conflict.status, 409);

  const removed = await call(fixture.url, hypBase + "/" + hyp.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const list = await call(fixture.url, hypBase);
  assert.equal(list.value.hypotheses.length, 0);
  const restored = await call(fixture.url, `/storage/resources/${"research-hypothesis:" + hyp.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  const afterRestore = await call(fixture.url, hypBase);
  assert.equal(afterRestore.value.hypotheses.length, 1);
  assert.equal(afterRestore.value.hypotheses[0].decisionHistory.length, 2, "恢复保留决策历史");
});

test("研究记录导出与导入：整体打包、重复导入幂等、恢复到新项目", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "导出验收");
  await call(fixture.url, `/research/projects/${projectId}/profile`, {
    method: "PUT",
    body: { question: "导出验收问题", actions: [{ text: "恢复后继续行动" }] },
  });
  const evidence = await call(fixture.url, `/research/projects/${projectId}/evidence`, {
    method: "POST",
    body: { type: "fact", content: "导出验收证据", source: { kind: "paper", paperId: "fixture-paper" } },
  });
  const evidenceId = evidence.value.evidence.id;
  await call(fixture.url, `/research/projects/${projectId}/matrices`, {
    method: "POST",
    body: { title: "导出验收对比表", paperIds: ["fixture-paper"], columns: [{ name: "指标" }], cells: {} },
  });
  await call(fixture.url, `/research/projects/${projectId}/hypotheses`, {
    method: "POST",
    body: { title: "导出验收假设", statement: "内容", support: [evidenceId] },
  });

  const exported = await call(fixture.url, `/research/projects/${projectId}/export`);
  assert.equal(exported.status, 200);
  const bundle = exported.value.export;
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.profile.question, "导出验收问题");
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.matrices.length, 1);
  assert.equal(bundle.hypotheses.length, 1);

  const badVersion = await call(fixture.url, `/research/projects/${projectId}/import`, {
    method: "POST",
    body: { data: { schemaVersion: 99 } },
  });
  assert.equal(badVersion.status, 400);

  const again = await call(fixture.url, `/research/projects/${projectId}/import`, {
    method: "POST",
    body: { data: bundle },
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.value.imported, {
    profile: 0, evidence: 0, matrices: 0, hypotheses: 0, protocols: 0, experiments: 0, runs: 0, comparisons: 0, conclusions: 0, manuscripts: 0,
  }, "重复导入应全部跳过");

  const target = await createProject(fixture.url, "恢复验收");
  const restored = await call(fixture.url, `/research/projects/${target}/import`, {
    method: "POST",
    body: { data: bundle },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual(restored.value.imported, {
    profile: 1, evidence: 1, matrices: 1, hypotheses: 1, protocols: 0, experiments: 0, runs: 0, comparisons: 0, conclusions: 0, manuscripts: 0,
  });
  assert.deepEqual(restored.value.errors, [], "完整恢复不应有错误");

  const targetProfile = await call(fixture.url, `/research/projects/${target}/profile`);
  assert.equal(targetProfile.value.profile.question, "导出验收问题");
  assert.equal(targetProfile.value.profile.actions[0].text, "恢复后继续行动", "恢复保留行动项");
  const targetEvidence = await call(fixture.url, `/research/projects/${target}/evidence`);
  assert.equal(targetEvidence.value.evidence[0].id, evidenceId, "恢复保留证据标识");
  const targetHypotheses = await call(fixture.url, `/research/projects/${target}/hypotheses`);
  assert.deepEqual(targetHypotheses.value.hypotheses[0].support, [evidenceId], "恢复保留假设与证据的关联");
});

test("研究方案：创建、基线对齐表、冻结版本与修订", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "方案验收");
  const base = `/research/projects/${projectId}/protocols`;

  const badBaseline = await call(fixture.url, base, {
    method: "POST",
    body: { title: "缺基线名", baselines: [{ paperSetup: "原文批次 32" }] },
  });
  assert.equal(badBaseline.status, 400, "基线行必须有名称");

  const created = await call(fixture.url, base, {
    method: "POST",
    body: {
      title: "基线对齐与改进验证",
      sourceNote: "来自研读实验计划",
      objective: "验证掩码修正是否缩小与原文差距",
      datasets: "CFM 本地复现集，train/val 8:2",
      metrics: "IoU（0.5 阈值）、AUROC（全 PRO 范围）",
      budget: "单卡 8G，最多 3 次尝试",
      baselines: [
        { name: "原始论文", paperSetup: "batch 32 / 40 轮", repoSetup: "官方仓库默认", actualSetup: "batch 8 / 续训", status: "partial", note: "优化器状态不完整" },
        { name: "阈值口径", status: "na" },
      ],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  let protocol = created.value.protocol;
  assert.equal(protocol.status, "draft");
  assert.equal(protocol.baselines[1].status, "na", "不适用基线允许保留");
  assert.equal(protocol.baselines[0].status, "partial");

  const frozen = await call(fixture.url, base + "/" + protocol.id + "/freeze", {
    method: "POST",
    body: { reason: "开始本轮执行" },
  });
  assert.equal(frozen.status, 200);
  protocol = frozen.value.protocol;
  assert.equal(protocol.status, "frozen");
  assert.equal(protocol.versions.length, 1);
  assert.equal(protocol.versions[0].index, 1);
  assert.deepEqual(protocol.versions[0].snapshot.baselines, protocol.baselines, "版本快照固定当时内容");

  // 冻结后仍可修订（产生新草稿状态），历史版本保留
  const revised = await call(fixture.url, base + "/" + protocol.id, {
    method: "PUT",
    body: { ...protocol, status: "draft", budget: "追加 1 次尝试", revision: protocol.revision },
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.value.protocol.versions.length, 1, "修订不清除历史版本");
  assert.equal(revised.value.protocol.versions[0].snapshot.budget, "单卡 8G，最多 3 次尝试", "历史快照不被改写");

  const conflict = await call(fixture.url, base + "/" + protocol.id, {
    method: "PUT",
    body: { ...protocol, revision: 0 },
  });
  assert.equal(conflict.status, 409);

  const list = await call(fixture.url, base);
  assert.equal(list.value.protocols.length, 1);

  const removed = await call(fixture.url, base + "/" + protocol.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const restored = await call(fixture.url, `/storage/resources/${"research-protocol:" + protocol.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  const afterRestore = await call(fixture.url, base);
  assert.equal(afterRestore.value.protocols[0].versions.length, 1, "恢复保留冻结版本");
});

test("实验台账：实验与运行登记、失败保留、重试关系与导入指标来源校验", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "实验台账验收");

  const protocol = await call(fixture.url, `/research/projects/${projectId}/protocols`, {
    method: "POST",
    body: { title: "台账验收方案" },
  });
  const protocolId = protocol.value.protocol.id;

  const expBase = `/research/projects/${projectId}/experiments`;
  const created = await call(fixture.url, expBase, {
    method: "POST",
    body: { title: "掩码修正对比", purpose: "验证修正对 IoU 的影响", protocolId, groups: [{ name: "基线" }, { name: "修正" }] },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const experiment = created.value.experiment;
  assert.equal(experiment.groups.length, 2);

  const badProtocol = await call(fixture.url, expBase, {
    method: "POST",
    body: { title: "坏引用", protocolId: "prt_missing" },
  });
  assert.equal(badProtocol.status, 404, "引用不存在的方案应拒绝");

  const runBase = `/research/projects/${projectId}/runs`;
  const importedNoSource = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "csv-行1", experimentId: experiment.id, status: "succeeded", imported: true, metrics: [{ name: "auroc", value: 0.97 }] },
  });
  assert.equal(importedNoSource.status, 400, "导入指标必须说明来源列");

  const first = await call(fixture.url, runBase, {
    method: "POST",
    body: {
      label: "尝试1",
      experimentId: experiment.id,
      status: "failed",
      config: { code: "commit a1b2", data: "复现集 8:2", environment: "RTX 5060 8G", seed: "42" },
      error: "第 30 轮显存不足中止",
      startedAt: "2026-10-06T08:00:00Z",
      finishedAt: "2026-10-06T09:00:00Z",
    },
  });
  assert.equal(first.status, 200, JSON.stringify(first.value));
  const firstRun = first.value.run;
  assert.equal(firstRun.status, "failed", "失败运行应可登记");
  assert.equal(firstRun.experimentTitle, "掩码修正对比");

  const second = await call(fixture.url, runBase, {
    method: "POST",
    body: {
      label: "尝试2-续跑",
      experimentId: experiment.id,
      status: "succeeded",
      imported: true,
      config: { code: "commit a1b2", notes: "降低批量后继续" },
      metrics: [{ name: "auroc", value: 0.976, unit: "", source: "results.csv:auroc 列" }],
      relation: { type: "resume", ofRunId: firstRun.id },
    },
  });
  assert.equal(second.status, 200, JSON.stringify(second.value));
  const secondRun = second.value.run;
  assert.equal(secondRun.relation.type, "resume");
  assert.equal(secondRun.relation.ofRunId, firstRun.id, "续跑应关联上次尝试");

  const selfRelation = await call(fixture.url, runBase + "/" + secondRun.id, {
    method: "PUT",
    body: { ...secondRun, relation: { type: "retry", ofRunId: secondRun.id }, revision: secondRun.revision },
  });
  assert.equal(selfRelation.status, 400, "运行不能关联自身");

  const conflict = await call(fixture.url, runBase + "/" + secondRun.id, {
    method: "PUT",
    body: { ...secondRun, revision: 0 },
  });
  assert.equal(conflict.status, 409);

  const allRuns = await call(fixture.url, runBase);
  assert.equal(allRuns.value.runs.length, 2, "两次尝试都保留且不互相覆盖");
  const byExperiment = await call(fixture.url, `/research/projects/${projectId}/runs?experimentId=${experiment.id}`);
  assert.equal(byExperiment.value.runs.length, 2);

  const removed = await call(fixture.url, expBase + "/" + experiment.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const orphanRuns = await call(fixture.url, runBase);
  assert.equal(orphanRuns.value.runs.length, 2, "删除实验不影响运行记录");
  const restoredExp = await call(fixture.url, `/storage/resources/${"research-experiment:" + experiment.id}/restore`, { method: "POST" });
  assert.equal(restoredExp.status, 200);

  const removedRun = await call(fixture.url, runBase + "/" + firstRun.id, { method: "DELETE" });
  assert.equal(removedRun.status, 200);
  const restoredRun = await call(fixture.url, `/storage/resources/${"research-run:" + firstRun.id}/restore`, { method: "POST" });
  assert.equal(restoredRun.status, 200);
  const afterRestore = await call(fixture.url, runBase);
  assert.equal(afterRestore.value.runs.length, 2);
  assert.equal(afterRestore.value.runs.find((r) => r.id === firstRun.id).error, "第 30 轮显存不足中止", "恢复保留失败原因");
});

test("结果比较与结论卡：快照固定运行值、口径说明、结论分类与依据校验", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "比较结论验收");
  const exp = await call(fixture.url, `/research/projects/${projectId}/experiments`, {
    method: "POST",
    body: { title: "比较验收实验" },
  });
  const experimentId = exp.value.experiment.id;
  const runBase = `/research/projects/${projectId}/runs`;
  const runA = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "基线", experimentId, status: "succeeded", metrics: [{ name: "iou", value: 0.81, source: "results.csv" }] },
  });
  const runB = await call(fixture.url, runBase, {
    method: "POST",
    body: { label: "修正", experimentId, status: "succeeded", metrics: [{ name: "iou", value: 0.87, source: "results.csv" }] },
  });
  const runAId = runA.value.run.id, runBId = runB.value.run.id;

  const cmpBase = `/research/projects/${projectId}/comparisons`;
  const noRuns = await call(fixture.url, cmpBase, { method: "POST", body: { title: "空比较", metricName: "iou", runIds: [] } });
  assert.equal(noRuns.status, 400, "比较至少需要一个运行");

  const created = await call(fixture.url, cmpBase, {
    method: "POST",
    body: {
      title: "基线 vs 修正 IoU",
      metricName: "iou",
      runIds: [runAId, runBId],
      inclusionNote: "只纳入同数据划分的成功运行",
      comparabilityNote: "修正运行批量较小，比较为并排参考",
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  let comparison = created.value.comparison;
  assert.equal(comparison.rows.length, 2);
  assert.equal(comparison.rows.find((r) => r.runId === runAId).value, 0.81);

  // 更新运行值后，已保存的快照不变
  await call(fixture.url, runBase + "/" + runAId, {
    method: "PUT",
    body: { ...runA.value.run, metrics: [{ name: "iou", value: 0.99, source: "results.csv" }], revision: runA.value.run.revision },
  });
  const still = await call(fixture.url, cmpBase + "/" + comparison.id);
  assert.equal(still.value.comparison.rows.find((r) => r.runId === runAId).value, 0.81, "快照不随后续运行更新变化");

  const conBase = `/research/projects/${projectId}/conclusions`;
  const badSupport = await call(fixture.url, conBase, {
    method: "POST",
    body: { statement: "x", kind: "supported", support: [{ kind: "run", id: "run_missing" }] },
  });
  assert.equal(badSupport.status, 400);
  const badKind = await call(fixture.url, conBase, {
    method: "POST",
    body: { statement: "x", kind: "proven" },
  });
  assert.equal(badKind.status, 400, "结论类型受控，不允许宣称已证实");

  const conclusion = await call(fixture.url, conBase, {
    method: "POST",
    body: {
      statement: "掩码修正后 IoU 由 0.81 提升至 0.87",
      kind: "exploratory",
      scope: "本地复现集，单次运行",
      limits: "未做多种子重复；比较口径存在批量差异",
      support: [
        { kind: "comparison", id: comparison.id },
        { kind: "evidence", id: "ev_missing" },
      ],
    },
  });
  assert.equal(conclusion.status, 400, "缺失证据应整体拒绝");

  const okConclusion = await call(fixture.url, conBase, {
    method: "POST",
    body: {
      statement: "掩码修正后 IoU 由 0.81 提升至 0.87",
      kind: "exploratory",
      scope: "本地复现集，单次运行",
      limits: "未做多种子重复",
      support: [{ kind: "comparison", id: comparison.id }],
    },
  });
  assert.equal(okConclusion.status, 200, JSON.stringify(okConclusion.value));
  const con = okConclusion.value.conclusion;
  assert.equal(con.kind, "exploratory", "探索性观察不写成已证实结论");

  const checked = await call(fixture.url, conBase + "/" + con.id, {
    method: "PUT",
    body: { ...con, checked: true, revision: con.revision },
  });
  assert.equal(checked.value.conclusion.checked, true, "人工核对状态独立记录");

  const removed = await call(fixture.url, cmpBase + "/" + comparison.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const restored = await call(fixture.url, `/storage/resources/${"research-comparison:" + comparison.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  const afterRestore = await call(fixture.url, cmpBase);
  assert.equal(afterRestore.value.comparisons.length, 1);
  assert.equal(afterRestore.value.comparisons[0].rows[0].snapshottedAt, comparison.rows[0].snapshottedAt, "恢复保留快照时间");
});

test("第二批研究记录随导出包整体恢复（方案/实验/运行/比较/结论）", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "二批导出验收");
  const base = `/research/projects/${projectId}`;

  const protocol = await call(fixture.url, base + "/protocols", { method: "POST", body: { title: "二批方案" } });
  const protocolId = protocol.value.protocol.id;
  await call(fixture.url, base + "/protocols/" + protocolId + "/freeze", { method: "POST", body: { reason: "执行" } });
  const exp = await call(fixture.url, base + "/experiments", { method: "POST", body: { title: "二批实验", protocolId } });
  const experimentId = exp.value.experiment.id;
  const run1 = await call(fixture.url, base + "/runs", {
    method: "POST",
    body: { label: "尝试1", experimentId, status: "failed", error: "显存不足" },
  });
  const run2 = await call(fixture.url, base + "/runs", {
    method: "POST",
    body: { label: "尝试2-续跑", experimentId, status: "succeeded", imported: true, metrics: [{ name: "iou", value: 0.87, source: "csv" }], relation: { type: "resume", ofRunId: run1.value.run.id } },
  });
  const cmp = await call(fixture.url, base + "/comparisons", {
    method: "POST",
    body: { title: "二批比较", metricName: "iou", runIds: [run2.value.run.id], inclusionNote: "仅成功运行" },
  });
  const con = await call(fixture.url, base + "/conclusions", {
    method: "POST",
    body: { statement: "续跑后 IoU 0.87", kind: "exploratory", support: [{ kind: "comparison", id: cmp.value.comparison.id }] },
  });

  const exported = await call(fixture.url, base + "/export");
  const bundle = exported.value.export;
  assert.equal(bundle.protocols.length, 1);
  assert.equal(bundle.experiments.length, 1);
  assert.equal(bundle.runs.length, 2);
  assert.equal(bundle.comparisons.length, 1);
  assert.equal(bundle.conclusions.length, 1);
  assert.deepEqual(bundle.comparisons[0].rows[0].value, 0.87, "导出包含比较快照值");

  const target = await createProject(fixture.url, "二批恢复验收");
  const restored = await call(fixture.url, `/research/projects/${target}/import`, { method: "POST", body: { data: bundle } });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual(restored.value.errors, [], "完整恢复不应有错误");
  assert.equal(restored.value.imported.protocols, 1);
  assert.equal(restored.value.imported.runs, 2);
  assert.equal(restored.value.imported.comparisons, 1);
  assert.equal(restored.value.imported.conclusions, 1);

  // 恢复后的链路：结论 → 比较 → 运行 → 实验 → 方案
  const targetCons = await call(fixture.url, `/research/projects/${target}/conclusions`);
  assert.equal(targetCons.value.conclusions[0].support[0].id, cmp.value.comparison.id);
  const targetCmp = await call(fixture.url, `/research/projects/${target}/comparisons`);
  assert.equal(targetCmp.value.comparisons[0].rows[0].runId, run2.value.run.id);
  const targetRuns = await call(fixture.url, `/research/projects/${target}/runs`);
  const restoredRun2 = targetRuns.value.runs.find((r) => r.id === run2.value.run.id);
  assert.equal(restoredRun2.relation.ofRunId, run1.value.run.id, "批内续跑关系恢复");
  assert.equal(restoredRun2.metrics[0].source, "csv", "导入指标来源保留");
  const targetProtocols = await call(fixture.url, `/research/projects/${target}/protocols`);
  assert.equal(targetProtocols.value.protocols[0].versions.length, 1, "冻结版本随包恢复");
});

test("写作引用助手：稿件登记、引用键稳定、bib 导出、检查与快照", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "稿件验收");
  const base = `/research/projects/${projectId}/manuscripts`;

  const created = await call(fixture.url, base, {
    method: "POST",
    body: { title: "CFM 失败模式分析", filePath: "papers/cfm-draft.md", fileKind: "markdown" },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const manuscript = created.value.manuscript;
  assert.equal(manuscript.citations.length, 0);

  const add1 = await call(fixture.url, base + "/" + manuscript.id + "/citations", {
    method: "POST",
    body: { paperId: "fixture-paper" },
  });
  assert.equal(add1.status, 200, JSON.stringify(add1.value));
  const firstKey = add1.value.manuscript.citations[0].key;
  assert.ok(firstKey, "应自动生成引用键");
  assert.equal(add1.value.manuscript.citations[0].title, "本地验收论文");

  // 同一键显式重复添加 → 409 不静默覆盖
  const duplicate = await call(fixture.url, base + "/" + manuscript.id + "/citations", {
    method: "POST",
    body: { paperId: "fixture-paper", key: firstKey },
  });
  assert.equal(duplicate.status, 409, "重复引用键应拒绝");

  const add2 = await call(fixture.url, base + "/" + manuscript.id + "/citations", {
    method: "POST",
    body: { paperId: "fixture-paper", key: "custom2026key" },
  });
  assert.equal(add2.status, 200);
  assert.equal(add2.value.manuscript.citations.length, 2);

  const badPaper = await call(fixture.url, base + "/" + manuscript.id + "/citations", {
    method: "POST",
    body: { paperId: "no-such-paper" },
  });
  assert.equal(badPaper.status, 404);

  const bib = await call(fixture.url, base + "/" + manuscript.id + "/bib");
  assert.equal(bib.status, 200);
  assert.match(bib.value.bib, /@misc\{custom2026key,/);
  assert.match(bib.value.bib, /title = \{本地验收论文\}/);

  // 结论关联
  const con = await call(fixture.url, `/research/projects/${projectId}/conclusions`, {
    method: "POST",
    body: { statement: "稿件验收结论", kind: "observation" },
  });
  const linked = await call(fixture.url, base + "/" + manuscript.id + "/conclusion-links", {
    method: "POST",
    body: { conclusionId: con.value.conclusion.id },
  });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.value.manuscript.linkedConclusions, [con.value.conclusion.id]);

  const checks = await call(fixture.url, base + "/" + manuscript.id + "/checks");
  assert.equal(checks.status, 200);
  assert.deepEqual(checks.value.duplicates, []);
  assert.deepEqual(checks.value.missing, []);

  const snapshot = await call(fixture.url, base + "/" + manuscript.id + "/snapshot", { method: "POST" });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.value.manuscript.snapshots.length, 1);
  assert.match(snapshot.value.manuscript.snapshots[0].bib, /custom2026key/);

  // 删除一条引用
  const removed = await call(fixture.url, base + "/" + manuscript.id + "/citations/" + encodeURIComponent(firstKey), { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.value.manuscript.citations.length, 1);

  const manuscriptRemoved = await call(fixture.url, base + "/" + manuscript.id, { method: "DELETE" });
  assert.equal(manuscriptRemoved.status, 200);
  const restored = await call(fixture.url, `/storage/resources/${"research-manuscript:" + manuscript.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  const afterRestore = await call(fixture.url, base);
  assert.equal(afterRestore.value.manuscripts.length, 1);
  assert.equal(afterRestore.value.manuscripts[0].snapshots.length, 1, "恢复保留稿件快照");
});

test("完整课题包：包含/排除清单、校验和、恢复报告明示外部缺口", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "课题包验收");
  const base = `/research/projects/${projectId}`;
  await call(fixture.url, base + "/profile", { method: "PUT", body: { question: "课题包验收" } });
  await call(fixture.url, base + "/projects/" + projectId, { method: "PUT", headersSkipped: true }).catch(() => {});
  // 给项目加论文
  await fetch(fixture.url + "/api/projects/" + projectId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addPaper: "fixture-paper" }) });
  await call(fixture.url, base + "/manuscripts", {
    method: "POST",
    body: { title: "课题包稿件", filePath: "papers/draft.md", fileKind: "markdown" },
  });

  const exported = await call(fixture.url, base + "/export?scope=project");
  assert.equal(exported.status, 200, JSON.stringify(exported.value));
  const bundle = exported.value.export;
  assert.equal(bundle.scope, "project");
  assert.equal(bundle.papers.length, 1);
  assert.ok(bundle.manifest.checksums, "课题包含校验和");
  assert.ok(bundle.manifest.excluded.some((e) => e.kind === "PDF 原文"), "排除清单明示 PDF 原文不含");
  assert.ok(bundle.manifest.included.some((i) => i.kind === "文献元数据"));

  // 篡改检测：改动数据后校验失败
  const tampered = structuredClone(bundle);
  tampered.profile.question = "被篡改的问题";
  const tamperedResult = await call(fixture.url, `/research/projects/${await createProject(fixture.url, "篡改检测")}/import`, {
    method: "POST", body: { data: tampered },
  });
  assert.equal(tamperedResult.status, 400, "被篡改的课题包应拒绝导入");

  // 恢复到新项目：研究记录恢复，论文按 contentHash 匹配，报告明示可用性
  const target = await createProject(fixture.url, "课题包恢复");
  const restored = await call(fixture.url, `/research/projects/${target}/import`, { method: "POST", body: { data: bundle } });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual(restored.value.errors, []);
  assert.equal(restored.value.imported.manuscripts, 1);
  assert.equal(restored.value.papers[0].status, "available", "fixture 论文在目标库可用");
  assert.equal(restored.value.papers[0].matchedBy, "id", "无 contentHash 的论文按 ID 匹配");

  // 未知论文的恢复报告
  const bundle2 = structuredClone(bundle);
  bundle2.papers.push({ id: "lib_unknown", title: "只存在于原设备的论文", contentHash: "deadbeef" });
  delete bundle2.manifest;
  const restored2 = await call(fixture.url, `/research/projects/${await createProject(fixture.url, "缺口报告")}/import`, {
    method: "POST", body: { data: bundle2 },
  });
  assert.equal(restored2.status, 200, JSON.stringify(restored2.value));
  assert.equal(restored2.value.papers.find((p) => p.id === "lib_unknown").status, "missing", "未知论文标记缺失");
});
