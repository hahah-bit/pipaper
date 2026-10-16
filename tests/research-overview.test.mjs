import test from "node:test";
import assert from "node:assert/strict";
import { actionStatusLabel, buildTimeline, openActions } from "../src/features/research/overview.js";

test("研究概览时间线只汇总真实记录时间并按时间倒序截断", () => {
  const profile = {
    updatedAt: "2026-10-06T10:00:00.000Z",
    actions: [
      { id: "a1", text: "导入基线结果", status: "done", createdAt: "2026-10-05T09:00:00.000Z", doneAt: "2026-10-06T09:30:00.000Z" },
      { id: "a2", text: "核对指标列", status: "blocked", createdAt: "2026-10-06T08:00:00.000Z" },
      { id: "a3", text: "整理对比表", status: "todo", createdAt: "2026-10-06T11:00:00.000Z" },
    ],
    outcomes: [
      { refId: "paper:p1", title: "基线论文", kind: "paper", linkedAt: "2026-10-05T12:00:00.000Z" },
      { refId: "file:n1", title: "缺时间戳的成果", kind: "note" },
    ],
  };
  const timeline = buildTimeline(profile);
  assert.deepEqual(timeline.map((e) => e.kind), ["profile", "action", "action", "outcome"]);
  assert.equal(timeline[0].label, "研究档案更新");
  assert.match(timeline[1].label, /完成行动：导入基线结果/);
  assert.match(timeline[2].label, /受阻行动：核对指标列/);
  assert.equal(timeline.some((e) => e.label.includes("整理对比表")), false, "普通待办不进时间线");
  assert.equal(timeline.some((e) => e.label.includes("缺时间戳")), false, "缺关联时间的成果不进时间线");

  const limited = buildTimeline(profile, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.deepEqual(buildTimeline(null), []);
});

test("未完成行动统计与状态标签回退", () => {
  const profile = {
    actions: [
      { id: "a1", text: "x", status: "done" },
      { id: "a2", text: "y", status: "blocked" },
      { id: "a3", text: "z", status: "todo" },
    ],
  };
  assert.deepEqual(openActions(profile).map((a) => a.id), ["a2", "a3"]);
  assert.deepEqual(openActions(null), []);
  assert.equal(actionStatusLabel("doing"), "进行中");
  assert.equal(actionStatusLabel("unknown"), "unknown");
});

test("比较摘要只汇总快照中的可比较值", async () => {
  const { comparisonSummary } = await import("../src/features/research/findings.js");
  assert.equal(
    comparisonSummary({ metricName: "iou", rows: [
      { status: "value", value: 0.81 },
      { status: "missing", value: null },
      { status: "value", value: 0.87 },
    ] }),
    "iou：0.81 / 0.87",
  );
  assert.equal(comparisonSummary({ metricName: "iou", rows: [{ status: "missing", value: null }] }), "无可比较值");
  assert.equal(comparisonSummary(null), "无可比较值");
});
