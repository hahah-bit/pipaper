import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseDataFile, runStatusLabel, RUN_STATUS_LABEL, parseMetricValue, parseRunStatus, metricsFromRow } from "../src/features/research/lab.js";

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

test("F04：空指标单元格按缺失处理，真正的 0 与负数保留", () => {
  assert.equal(parseMetricValue(""), null, "空字符串不是 0");
  assert.equal(parseMetricValue("   "), null, "空白不是 0");
  assert.equal(parseMetricValue(null), null);
  assert.equal(parseMetricValue(undefined), null);
  assert.equal(parseMetricValue("0"), 0, "真正的 0 保留");
  assert.equal(parseMetricValue(0), 0);
  assert.equal(parseMetricValue("-1.5"), -1.5, "负数保留");
  assert.equal(parseMetricValue("9.7e-2"), 0.097, "科学计数法保留");
  assert.equal(parseMetricValue("NaN"), null, "NaN 文本无效");
  assert.equal(parseMetricValue("abc"), null);

  const row = { iou: "", acc: "0", loss: "0.31", note: "n/a", missing: undefined };
  const metrics = metricsFromRow(row, ["iou", "acc", "loss", "missing"], "test.csv");
  assert.deepEqual(
    metrics.map((m) => [m.name, m.value]),
    [["acc", 0], ["loss", 0.31]],
    "空与缺键的列被跳过；0 保留为真实指标",
  );
});

test("F06：状态列中英文词表解析，未知状态显式标记", () => {
  assert.equal(parseRunStatus("succeeded").status, "succeeded");
  assert.equal(parseRunStatus("Succeeded ").status, "succeeded");
  assert.equal(parseRunStatus("失败").status, "failed");
  assert.equal(parseRunStatus("failed").status, "failed");
  assert.equal(parseRunStatus("stopped").status, "stopped");
  assert.equal(parseRunStatus("中止").status, "stopped");
  assert.equal(parseRunStatus("").status, null, "空值交给默认逻辑");
  const unknown = parseRunStatus("banana");
  assert.equal(unknown.known, false, "未知状态不静默回退");
});
