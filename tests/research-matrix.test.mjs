import test from "node:test";
import assert from "node:assert/strict";
import { toMarkdown, cellKey, CELL_STATUS_LABEL } from "../src/features/research/matrix.js";

const matrix = {
  id: "mtx_x",
  title: "失败模式对比",
  conditions: "复现条件与原文存在批次差异",
  paperIds: ["p1", "p2"],
  columns: [
    { id: "c1", name: "AU|ROC" },
    { id: "c2", name: "训练轮次" },
  ],
  cells: {
    [cellKey("p1", "c1")]: { value: "0.976", status: "unverified", sourceLabel: "表2", page: 6, aiCandidate: true },
    [cellKey("p1", "c2")]: { value: "", status: "not-reported" },
    [cellKey("p2", "c1")]: { value: "0", status: "zero" },
  },
};

test("对比表导出 Markdown 保留状态、来源与 AI 候选标记", () => {
  const md = toMarkdown(matrix, (id) => (id === "p1" ? "基线论文" : "对比论文"));
  assert.match(md, /## 失败模式对比/);
  assert.match(md, /比较条件说明：复现条件与原文存在批次差异/);
  assert.match(md, /AU\\\|ROC/, "列名中的竖线应转义");
  assert.match(md, /\| 基线论文 \| 0\.976 （未核对） \[AI 候选\] \[表2 第6页\] \| （未报告） \|/);
  assert.match(md, /\| 对比论文 \| 0 （零值） \|  \|/);
});

test("单元格状态标签覆盖零值、未报告、未核对与不适用", () => {
  assert.deepEqual(Object.values(CELL_STATUS_LABEL), ["值", "零值", "未报告", "未核对", "不适用"]);
  assert.equal(cellKey("p1", "c1"), "p1|c1");
});
