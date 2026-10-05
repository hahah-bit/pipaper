import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-cas-test-"));
process.env.PIPAPER_DATA_DIR = path.join(dir, "data");
const { parseCsv, importCsv, lookup, clear, status } = await import("../server/topics/cas-table.js");
const { verifyCAS } = await import("../server/topics/quality.js");

const HEAD = "序号,英文刊名,ISSN,eISSN,大类学科,大类分区,是否Top";
const MAIN = [
  "1,Nature,0028-0836,1476-4687,综合期刊,1区,是",
  "2,Sensors,1424-8220,1424-8220,工程技术,2区,否",
  "3,IEEE Transactions on Pattern Analysis and Machine Intelligence,0162-8828,1939-3539,计算机科学,1区,是",
  '4,"Journal with, comma",0000-0001,,数学,一区,否',
];
const filler = n => Array.from({ length: n }, (_, i) => `${i + 10},Filler Journal ${i},1000-000${i % 10},,工程技术,${(i % 4) + 1}区,否`);
const CSV = [HEAD, ...MAIN, ...filler(55)].join("\n");

test("parseCsv handles quoted commas, CRLF and BOM", () => {
  const rows = parseCsv("\uFEFFa,b\r\n\"x,1\",\"y\"\"z\"\"\nw\"\r\n");
  assert.deepEqual(rows, [["a", "b"], ["x,1", 'y"z"\nw']]);
});

test("import maps columns, dedupes and answers ISSN-first lookups", () => {
  const s = importCsv(CSV, { edition: 2025, fileName: "cas2025.csv" });
  assert.equal(s.imported, true); assert.equal(s.edition, 2025); assert.equal(s.count, 59);
  assert.equal(lookup(["1424-8220"], "Sensors").zone, 2);
  assert.equal(lookup(["1476-4687"], null).name, "Nature");
  assert.equal(lookup([], "IEEE Transactions on Pattern Analysis and Machine Intelligence").zone, 1);
  assert.equal(lookup([], "journal with comma").zone, 1);
  assert.equal(lookup([], "SENSORS").zone, 2);
  assert.equal(lookup(["9999-9999"], "Unknown Journal"), null);
});

test("import rejects header-less or thin tables with actionable messages", () => {
  assert.throws(() => importCsv("only one line"), /CSV 内容为空/);
  assert.throws(() => importCsv(CSV.replace("英文刊名,", "名称,")), /期刊名/);
  assert.throws(() => importCsv(CSV.replace("大类分区,是否Top", "大类评级的备注,是否Top")), /分区/);
  const thin = [HEAD, ...filler(30)].join("\n");
  assert.throws(() => importCsv(thin), /≥50 条/);
});

test("verifyCAS accepts table zone-1 baselines without fenqubiao documents and keeps zone-2 on the conference path", () => {
  importCsv(CSV, { edition: 2025, fileName: "cas2025.csv" });
  const tpami = { venue: { name: "IEEE Transactions on Pattern Analysis and Machine Intelligence", issns: ["0162-8828"] }, doi: "https://doi.org/x", type: "article" };
  const q = verifyCAS(tpami, []);
  assert.equal(q.eligible, true); assert.equal(q.rank, 1); assert.equal(q.sourceTable, true);
  assert.match(q.quote, /中科院2025年版分区表/);
  assert.equal(verifyCAS({ venue: { name: "Sensors", issns: ["1424-8220"] }, type: "article" }, []), null);
  assert.equal(verifyCAS({ venue: { name: "Nature", issns: ["0028-0836"] }, type: "preprint" }, []), null);
  importCsv(CSV, { edition: 2023, fileName: "old.csv" });
  assert.equal(verifyCAS(tpami, []), null);
});

test("clear removes the table and lookups go cold", () => {
  clear();
  assert.equal(status().imported, false);
  assert.equal(lookup(["1424-8220"], "Sensors"), null);
  assert.equal(verifyCAS({ venue: { name: "Nature", issns: ["0028-0836"] }, type: "article" }, []), null);
});
