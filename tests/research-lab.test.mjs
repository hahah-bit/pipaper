import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseDataFile, runStatusLabel, RUN_STATUS_LABEL } from "../src/features/research/lab.js";

test("CSV 解析处理引号、逗号与换行，并映射为列名行对象", () => {
  const csv = 'run,auroc,note\r\n"尝试1",0.976,"含,逗号"\n尝试2,"含\n换行",ok\n';
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.columns, ["run", "auroc", "note"]);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], { run: "尝试1", auroc: "0.976", note: "含,逗号" });
  assert.deepEqual(parsed.rows[1], { run: "尝试2", auroc: "含\n换行", note: "ok" });
  assert.deepEqual(parseCsv(""), { columns: [], rows: [] });
});

test("数据文件解析兼容 JSON 数组并回退 CSV", () => {
  const json = '[{"run":"r1","iou":0.81},{"run":"r2","iou":0.83}]';
  const parsed = parseDataFile(json);
  assert.deepEqual(parsed.columns, ["run", "iou"]);
  assert.equal(parsed.rows[1].iou, "0.83");
  const fallback = parseDataFile("run,iou\nr3,0.9\n");
  assert.deepEqual(fallback.columns, ["run", "iou"]);
  assert.equal(fallback.rows[0].run, "r3");
});

test("运行状态标签覆盖成功、失败、中止与不完整", () => {
  assert.deepEqual(Object.values(RUN_STATUS_LABEL), ["成功", "失败", "中止", "不完整"]);
  assert.equal(runStatusLabel("failed"), "失败");
  assert.equal(runStatusLabel(undefined), "不完整");
});
