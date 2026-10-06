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
  assert.deepEqual(again.value.imported, { profile: 0, evidence: 0, matrices: 0, hypotheses: 0 }, "重复导入应全部跳过");

  const target = await createProject(fixture.url, "恢复验收");
  const restored = await call(fixture.url, `/research/projects/${target}/import`, {
    method: "POST",
    body: { data: bundle },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert.deepEqual(restored.value.imported, { profile: 1, evidence: 1, matrices: 1, hypotheses: 1 });
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
