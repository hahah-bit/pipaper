import test from "node:test";
import assert from "node:assert/strict";
import { keywordFrequency, yearly, journalMetrics, supported, validateDirections, validateVenueEvidence } from "../server/topics/analysis.js";
import { years, privateAddress, safeURL, mergePapers, arxivExpression } from "../server/topics/sources.js";

test("topic statistics separate complete years, partial year and missing data; broad labels are excluded", () => {
  const period = years(new Date("2026-09-22T00:00:00Z")); assert.deepEqual(period.complete, [2023, 2024, 2025]); assert.equal(period.baselineFrom, "2023-09-22");
  const words = keywordFrequency([{ year: 2025, keywords: ["Machine learning", "Anomaly localization", "Anomaly localization"] }, { year: 2026, keywords: ["Anomaly localization"] }], period);
  assert.equal(words.length, 1); assert.equal(words[0].count, 1); assert.equal(words[0].years[2025], 1);
  assert.ok(yearly(null, period).every(p => p.count === null)); assert.ok(yearly([], period).every(p => p.count === 0));
  const related = yearly([{ key: "2023", count: 10 }, { key: "2025", count: 20 }, { key: "2026", count: 9999 }], period);
  const m = journalMetrics({ related, all: yearly(null, period), papers: [], totalRelated: null, period }); assert.equal(m.growth, 100); assert.equal(m.concentration, null); assert.equal(m.oa, null);
});
test("dataset access and hardware need exact evidence; OA paper metadata cannot satisfy dataset filtering", () => {
  const papers = [0, 1, 2].map(i => ({ id: "paper" + i, date: "2025-01-01", references: [], paperOpenAccess: true, quality: { eligible: true, system: "CCF", rank: "A", sourceUrl: "https://www.ccf.org.cn/catalog", publicationUrl: "https://example.org/test-paper" } }));
  const d = { name: "方向", problem: "问题", rationale: "理由", story: "故事", smallPaper: "小论文", critique: "反驳", experiment: "实验", baselineIds: papers.map(p => p.id), evidenceIds: ["paper0"], dataset: { open: true }, hardware: { gpuCount: 1, vramGB: 24 } };
  const values = validateDirections({ directions: [d, d, d] }, papers, [], { openData: true, gpuCount: 1, vramGB: 24 }, years(new Date("2026-09-22")));
  assert.ok(values.every(d => !d.eligible)); assert.equal(values[0].dataset.status, "unknown"); assert.equal(values[0].hardware.status, "unknown");
  assert.throws(() => validateDirections({ directions: [d, d, d] }, papers.map(p => ({ ...p, quality: null })), [], null), /已核验发表证据/);
  assert.throws(() => validateDirections({ directions: [d, d, d] }, papers.map(p => ({ ...p, date: "2023-09-21" })), [], null, years(new Date("2026-09-22"))), /近三年/);
  assert.throws(() => validateDirections({ directions: [{ ...d, baselineIds: ["fake", "paper1", "paper2"] }, d, d] }, papers, [], null), /之外/);
});
test("quotes, CAS provenance and public network boundaries are enforced", () => {
  const docs = [{ url: "https://example.org/journal", text: "Time to first decision is 20 days." }];
  assert.equal(supported({ url: docs[0].url, quote: "Time to first decision is 20 days." }, docs), true);
  assert.equal(supported({ url: docs[0].url, quote: "Time to first decision is 2 days." }, docs), false);
  const value = validateVenueEvidence({ cas: { zone: 1, year: 2026, url: docs[0].url, quote: docs[0].text }, review: { days: 20, metric: "first-decision", url: docs[0].url, quote: docs[0].text } }, docs);
  assert.equal(value.cas, null); assert.equal(value.review.metric, "first-decision");
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.18.52.132", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1"]) assert.equal(privateAddress(ip), true);
  assert.equal(privateAddress("1.1.1.1"), false); assert.equal(safeURL("javascript:alert(1)"), null); assert.equal(safeURL("https://user:password@example.org/"), null);
  assert.equal(mergePapers([{ id: "a", title: "One Paper", doi: "https://doi.org/a", queries: ["a"] }, { id: "b", title: "One Paper", doi: "https://doi.org/a", queries: ["b"] }]).length, 1);
});
test("arXiv queries preserve phrases and boolean operators rather than searching for the word AND", () => {
  assert.equal(arxivExpression('industrial "anomaly detection"'), 'all:industrial AND all:"anomaly detection"');
  assert.equal(arxivExpression('"anomaly detection" AND ("few shot" OR "zero shot")'), 'all:"anomaly detection" AND ( all:"few shot" OR all:"zero shot" )');
});
