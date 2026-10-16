import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 第四批导出/导入验收：直接驱动 store 层（在真实数据目录上），
// 覆盖课题包校验和、恢复与篡改检测。
test("第四批研究记录随课题包导出、恢复与篡改检测", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "pipaper-b4-"));
  process.env.PIPAPER_DATA_DIR = dataDir;
  const { createProject } = await import("../server/store.js");
  const {
    createReselection, createSubmission, updateSubmission,
    exportProjectBundle, importBundle, listReselections, listSubmissions,
  } = await import("../server/modules/research/store.js");

  try {
    const projectId = createProject("四批包验收").id;
    const reselection = createReselection(projectId, {
      title: "第二轮方向",
      contextRefs: [],
      candidates: [{ text: "候选A", rationale: "来自失败模式", basedOn: [] }],
    });
    const submission = createSubmission(projectId, { target: "某会议", round: 1 });
    updateSubmission(projectId, submission.id, {
      ...submission,
      comments: [{ text: "意见1", category: "revise", disposition: { status: "done", note: "已改", refs: [] } }],
    });

    const bundle = exportProjectBundle(projectId);
    assert.equal(bundle.reselections.length, 1, "导出包含二次选题");
    assert.equal(bundle.submissions.length, 1, "导出包含投稿轮次");
    assert.equal(Object.keys(bundle.manifest.checksums).length, 12, "校验和覆盖 12 段");

    const round = JSON.parse(JSON.stringify(bundle));
    const targetProject = createProject("四批恢复").id;
    const result = importBundle(targetProject, round);
    assert.equal(result.imported.reselections, 1, "二次选题恢复");
    assert.equal(result.imported.submissions, 1, "投稿轮次恢复");
    assert.deepEqual(result.errors, [], "无恢复错误");
    // F02：跨项目恢复分配新身份——按内容找回而非旧 ID。
    const restoredReselections = listReselections(targetProject);
    assert.equal(restoredReselections[0].candidates[0].text, "候选A", "候选保留");
    const restoredSubmissions = listSubmissions(targetProject);
    assert.equal(restoredSubmissions[0].comments[0].disposition.status, "done", "意见处置保留");
    assert.notEqual(restoredReselections[0].id, reselection.id, "新身份");
    assert.notEqual(restoredSubmissions[0].id, submission.id, "新身份");

    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.submissions[0].target = "被篡改的目标";
    assert.throws(() => importBundle(createProject("篡改").id, tampered), /校验失败/, "篡改包被拒绝");
  } finally {
    // Windows 上 SQLite 句柄可能延迟释放；清理失败不影响结果。
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
});
