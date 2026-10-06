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
  assert.equal(created.status, 200);
  return created.value.id;
}

test("投稿台账：轮次、意见拆解、处置引用与检查清单；改投不覆盖上一轮", async (t) => {
  const fixture = await nativeHttpFixture();
  t.after(() => fixture.dispose());
  const projectId = await createProject(fixture.url, "投稿验收");

  const manuscript = await call(fixture.url, `/research/projects/${projectId}/manuscripts`, {
    method: "POST",
    body: { title: "待投稿稿件" },
  });
  const manuscriptId = manuscript.value.manuscript.id;

  const base = `/research/projects/${projectId}/submissions`;
  const noTarget = await call(fixture.url, base, { method: "POST", body: {} });
  assert.equal(noTarget.status, 400, "投稿目标必填");

  const badManuscript = await call(fixture.url, base, {
    method: "POST",
    body: { target: "某会议", manuscriptId: "man_missing" },
  });
  assert.equal(badManuscript.status, 404);

  const round1 = await call(fixture.url, base, {
    method: "POST",
    body: {
      target: "某会议",
      round: 1,
      manuscriptId,
      status: "submitted",
      dates: { submittedAt: "2026-10-01" },
      materials: [
        { label: "正文 PDF", kind: "submitted" },
        { label: "补充材料", kind: "prepared", note: "等待上传" },
      ],
    },
  });
  assert.equal(round1.status, 200, JSON.stringify(round1.value));
  let submission = round1.value.submission;
  assert.equal(submission.status, "submitted");

  // 粘贴审稿意见 → 拆解为草稿
  const imported = await call(fixture.url, base + "/" + submission.id + "/comments", {
    method: "POST",
    body: { text: "意见1：需要解释批量差异的影响。\n\n意见2：请补充多种子实验。\n\n意见3：图3 的坐标轴标签不清。" },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.value));
  submission = imported.value.submission;
  assert.equal(submission.comments.length, 3, "按空行拆解为 3 条意见");
  assert.equal(submission.comments[0].disposition.status, "pending");

  // 补充实验（运行）作为处置引用
  const exp = await call(fixture.url, `/research/projects/${projectId}/experiments`, {
    method: "POST", body: { title: "补实验" },
  });
  const run = await call(fixture.url, `/research/projects/${projectId}/runs`, {
    method: "POST",
    body: { label: "种子=1 补充运行", experimentId: exp.value.experiment.id, status: "succeeded", metrics: [{ name: "iou", value: 0.84, source: "csv" }] },
  });
  const updatedComments = submission.comments.map((comment, index) =>
    index === 1
      ? { ...comment, category: "experiment", disposition: { status: "done", note: "已补 3 个种子", refs: [{ kind: "run", id: run.value.run.id }] } }
      : index === 0
        ? { ...comment, category: "explain", disposition: { status: "done", note: "回复中解释", refs: [] } }
        : comment,
  );
  const updated = await call(fixture.url, base + "/" + submission.id, {
    method: "PUT",
    body: { ...submission, comments: updatedComments, revision: submission.revision },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.value));
  submission = updated.value.submission;

  const checklist = await call(fixture.url, base + "/" + submission.id + "/checklist");
  assert.deepEqual(checklist.value.pending, [submission.comments[2].id], "只剩未处置意见");
  assert.deepEqual(checklist.value.preparedNotSubmitted, ["补充材料"], "准备完成与已提交分开显示");

  const badRef = await call(fixture.url, base + "/" + submission.id, {
    method: "PUT",
    body: {
      ...submission,
      comments: submission.comments.map((c, i) => i === 2 ? { ...c, disposition: { status: "done", note: "", refs: [{ kind: "run", id: "run_missing" }] } } : c),
      revision: submission.revision,
    },
  });
  assert.equal(badRef.status, 404, "处置引用不存在的记录应拒绝");

  // 改投 = 新一轮次记录，上一轮保留
  const round2 = await call(fixture.url, base, {
    method: "POST",
    body: { target: "另一期刊", round: 2, manuscriptId, status: "preparing" },
  });
  assert.equal(round2.status, 200);
  const list = await call(fixture.url, base);
  assert.equal(list.value.submissions.length, 2, "两轮独立保留");
  assert.equal(list.value.submissions.find((s) => s.round === 1).comments.length, 3, "第 1 轮意见不被覆盖");

  const conflict = await call(fixture.url, base + "/" + submission.id, {
    method: "PUT",
    body: { ...submission, revision: 0 },
  });
  assert.equal(conflict.status, 409);

  const removed = await call(fixture.url, base + "/" + submission.id, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const restored = await call(fixture.url, `/storage/resources/${"research-submission:" + submission.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  const afterRestore = await call(fixture.url, base);
  assert.equal(afterRestore.value.submissions.find((s) => s.id === submission.id).comments[1].disposition.refs.length, 1, "恢复保留处置引用");
});
