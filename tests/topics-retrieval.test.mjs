import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../server/topics/planning.js";
import { conferenceLocator, verifyConference } from "../server/topics/quality.js";
import { mergePapers, createSources } from "../server/topics/sources.js";
import { retrieve } from "../server/topics/retrieval.js";
import { samePaper, hasFullText, ownCode, bindEvidence } from "../server/topics/reading.js";
import { supported, hardwareEvidence, datasetEvidence } from "../server/topics/analysis.js";

const concepts = { concepts: [{ zh: "工具学习", en: "tool learning", role: "task" }], directions: [{ parent: "智能体技能", name: "工具迁移", problem: "工具学习如何迁移", terms: [{ zh: "工具学习", en: "tool learning", synonyms: ["tool use"] }, { zh: "迁移", en: "transfer learning" }] }], policyTerms: ["工业智能体"] };
test("model concepts become atomic English queries with synonyms and relaxed variants", () => {
  const p = buildPlan(concepts, false); assert.equal(p.queries[0].query, '"tool learning" AND "transfer learning"');
  assert.ok(p.queries[0].variants.includes('"tool learning"'));
  assert.throws(() => buildPlan({ ...concepts, directions: [{ ...concepts.directions[0], terms: [{ en: '"tool learning" AND "skills"' }] }] }, false), /术语/);
  assert.throws(() => buildPlan(concepts, true), /6–12/);
});
test("conference identity and formal paper track are verified independently of discovery source", () => {
  const p = { title: "A real research question", publicationUrls: ["https://aclanthology.org/2025.acl-long.10/"], venue: { name: "ACL" } };
  const locator = conferenceLocator(p), doc = { text: p.title, metadata: { citation_title: p.title }, retrievedAt: "2026-09-22" };
  assert.equal(verifyConference(p, locator, doc).rank, "A");
  assert.equal(verifyConference(p, locator, { ...doc, metadata: { citation_title: "Different paper" } }), null);
  for (const path of ["2025.acl-short.10", "2025.findings-acl.10", "2025.acl-demo.10"]) assert.equal(conferenceLocator({ ...p, publicationUrls: [`https://aclanthology.org/${path}/`] }), null);
  assert.equal(conferenceLocator({ ...p, publicationUrls: ["https://openaccess.thecvf.com/content/CVPR2025W/html/paper.html"] }), null);
  const mlr = { ...p, publicationUrls: ["https://proceedings.mlr.press/v250/example24.html"] };
  assert.equal(verifyConference(mlr, conferenceLocator(mlr), { ...doc, text: p.title + " Proceedings of AISTATS" }), null);
  assert.equal(verifyConference(mlr, conferenceLocator(mlr), { ...doc, text: p.title + " Proceedings of the 42nd International Conference on Machine Learning" }).venue, "ICML");
});
test("same title preprint merges with published metadata and preserves provenance", () => {
  const merged = mergePapers([{ id: "arxiv:1", title: "Paper: One", date: "2024-01-01", venue: null, queries: ["a"] }, { id: "oa:2", title: "Paper One", doi: "https://doi.org/example", date: "2025-01-01", venue: { type: "conference", name: "ACL" }, quality: { eligible: true }, queries: ["b"] }]);
  assert.equal(merged.length, 1); assert.equal(merged[0].venue.name, "ACL"); assert.equal(merged[0].date, "2025-01-01"); assert.deepEqual(merged[0].queries, ["a", "b"]);
});
test("ICDE and KDD require full research proceedings records, excluding companions and demos", () => {
  const p = { title: "In Situ Neural Relational Schema Matcher", doi: "https://doi.org/10.1109/example", venue: { name: "2024 IEEE 40th International Conference on Data Engineering (ICDE)" } };
  const locator = conferenceLocator(p), w = { title: [p.title], DOI: "10.1109/example", type: "proceedings-article", "container-title": [p.venue.name], page: "138-150" };
  assert.equal(verifyConference(p, locator, { json: { message: w } }).venue, "ICDE");
  assert.equal(verifyConference(p, locator, { json: { message: { ...w, page: "138-141" } } }), null);
  assert.equal(conferenceLocator({ ...p, venue: { name: p.venue.name + " Workshops" } }), null);
});
test("empty exact search relaxes keywords; source faults remain errors, never zero papers", async () => {
  const plan = buildPlan(concepts, false), saved = [];
  const sources = { works: async q => ({ papers: q === '"tool learning"' ? [{ id: "a", title: "Task", date: "2025-01-01", abstract: "" }] : [] }), crossref: async () => { throw new Error("HTTP 503"); }, arxiv: async () => ({ papers: [] }) };
  const r = await retrieve(plan, { sources, save: (...args) => saved.push(args), getDoc: async () => null });
  assert.equal(r.papers.length, 1); assert.ok(r.summary.attempts.some(a => a.status === "error" && a.count === null)); assert.ok(r.summary.attempts.some(a => a.query === '"tool learning"' && a.count === 1));
  assert.ok(saved.some(s => s[0] === "retrieval"));
});
test("malformed OpenAlex response cannot silently become an empty corpus", async () => {
  const sources = createSources({ request: async () => ({ buffer: Buffer.from('{"error":"quota"}') }) });
  await assert.rejects(sources.works("test"), /无效数据结构/);
});

test("same-day successful searches are reused while failed attempts are retried", async () => {
  const plan = buildPlan(concepts, false), query = plan.queries[0].query;
  let exactCalls = 0, retried = 0;
  const sources = {
    works: async (q, options) => { if (q === query && options.sort === "relevance_score:desc") exactCalls++; return { papers: [] }; },
    crossref: async () => { retried++; return { papers: [] }; }, arxiv: async () => ({ papers: [] }),
  };
  const r = await retrieve(plan, { sources, getDoc: async () => null, cachedSearches: [
    { source: "OpenAlex 相关度", query, status: "ok", papers: [{ id: "cached", title: "Cached paper", date: "2025-01-01" }] },
    { source: "Crossref", query, status: "error", count: null },
  ] });
  assert.equal(exactCalls, 0); assert.ok(retried > 0); assert.equal(r.papers[0].id, "cached");
  assert.ok(r.summary.attempts.some(a => a.cacheHit && a.query === query));
});
test("a wrong OA PDF cannot borrow identity from a reference to the requested paper", () => {
  const p = { title: "The requested research paper" };
  assert.equal(samePaper(p, { pages: [{ text: "An entirely different paper" }, { text: p.title }], text: p.title }), false);
  assert.equal(samePaper(p, { pages: [{ text: p.title }], text: p.title }), true);
});
test("policy page labels verify the specified page and hardware modes cannot manufacture VRAM", () => {
  const d = { url: "https://example.org/paper", text: "We use an NVIDIA A100 GPU. We evaluate via the OpenAI API.", pages: [{ page: 4, text: "Header. A precise source-grounded policy claim. Footer." }] };
  assert.equal(supported({ url: d.url, quote: "[第4页] A precise source-grounded policy claim." }, [d]), true);
  assert.equal(supported({ url: d.url, quote: "[第3页] A precise source-grounded policy claim." }, [d]), false);
  assert.equal(hardwareEvidence({ url: d.url, quote: "We use an NVIDIA A100 GPU.", gpuCount: 1, vramGB: 80 }, [d]), false);
  assert.equal(hardwareEvidence({ url: d.url, quote: "We evaluate via the OpenAI API.", mode: "api", gpuCount: 0, vramGB: 0 }, [d]), true);
  const intro = { url: d.url, text: "GPT-4 achieves correctness of 30 to 60 percent on tool tasks." };
  assert.equal(hardwareEvidence({ url: d.url, quote: intro.text, mode: "api", gpuCount: 0, vramGB: 0 }, [intro]), false);
});
test("publication abstracts, referenced repositories and commands cannot stand in for fulltext, author code or open data", () => {
  assert.equal(hasFullText({ text: "Publisher abstract page".repeat(100), pages: [] }), false);
  assert.equal(ownCode({ title: "An Actual Paper" }, "https://github.com/lib/numpy", { text: "A numerical library" }), false);
  const url = "https://example.org/repo", quote = "python train.py --dataset public-data";
  assert.equal(datasetEvidence({ url, quote }, [{ url, text: quote }]), false);
  const mixed = "Experiments run on an Intel CPU and NVIDIA GPU with 64 GB RAM.";
  assert.equal(hardwareEvidence({ mode: "cpu", gpuCount: 0, vramGB: 0, url, quote: mixed }, [{ url, text: mixed }]), false);
});

test("supplied excerpt citations resolve to their proven paper IDs without inventing unknown references", () => {
  const options = [{ id: "evidence-1", kind: "dataset", paperIds: ["paper-1", "paper-2"], url: "https://example.org/data", quote: "Publicly available dataset" }];
  const value = bindEvidence({ directions: [{ evidenceIds: ["evidence-1", "paper-1", "evidence-999"], dataset: { evidenceId: "evidence-1" } }] }, options);
  assert.deepEqual(value.directions[0].evidenceIds, ["paper-1", "paper-2", "evidence-999"]);
  assert.equal(value.directions[0].dataset.quote, options[0].quote);
});
