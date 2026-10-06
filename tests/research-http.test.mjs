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
