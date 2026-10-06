import test from "node:test";
import assert from "node:assert/strict";
import { decisionLabel, decisionTimeline, DECISION_STATUS_LABEL } from "../src/features/research/hypothesis.js";

test("假设决策历史按记录顺序展开并保留理由", () => {
  const hypothesis = {
    decisionHistory: [
      { at: "2026-10-06T10:00:00.000Z", status: "continue", reason: "预测可低成本验证" },
      { at: "2026-10-07T09:00:00.000Z", status: "hold", reason: "" },
    ],
  };
  const timeline = decisionTimeline(hypothesis);
  assert.deepEqual(timeline.map((t) => t.label), ["继续验证：预测可低成本验证", "搁置"]);
  assert.deepEqual(decisionTimeline(null), []);
  assert.deepEqual(decisionTimeline({}), []);
});

test("决策状态标签覆盖继续、搁置、修改与停止", () => {
  assert.deepEqual(Object.values(DECISION_STATUS_LABEL), ["探索中", "继续验证", "搁置", "修改方向", "停止"]);
  assert.equal(decisionLabel("stop"), "停止");
  assert.equal(decisionLabel(undefined), "探索中");
});
