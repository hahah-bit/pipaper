import test from "node:test";
import assert from "node:assert/strict";
import { createSources } from "../server/topics/sources.js";
import { crossrefCensus, crossrefJournal, matchesPhrase, anchorPhrases } from "../server/topics/journal-fallback.js";
const response = message => ({ buffer: Buffer.from(JSON.stringify({ status: "ok", message })) });
test("OpenAlex daily quota is a circuit breaker, not a sequence of blind retries", async () => {
  let count = 0;
  const sources = createSources({ request: async () => { count++; throw Object.assign(new Error("HTTP 429 quota"), { remoteStatus: 429, quota: true, retryAfter: 7200 }); } });
  await assert.rejects(sources.works("one"), /quota/);
  await assert.rejects(sources.works("two"), /quota/);
  assert.equal(count, 1);
});
const source = { id: "source", issn: ["1234-567X"] };
const period = { from: "2023-01-01", to: "2026-09-22", complete: [2023, 2024, 2025], partial: 2026 };
const paper = (DOI, title, year) => ({ DOI, title: [title], published: { "date-parts": [[year, 1, 1]] }, type: "journal-article" });
test("journal census paginates, deduplicates DOI and counts explicit phrases by publication year", async () => {
  let calls = 0;
  const r = await crossrefCensus(source, ["entity matching", "tool learning"], { period, request: async url => {
    const cursor = new URL(url).searchParams.get("cursor"); calls++;
    return response({ "total-results": 3, "next-cursor": "second", items: cursor === "*" ? [paper("one", "Entity matching with noise", 2023), paper("two", "Unrelated learning", 2024)] : [paper("two", "Unrelated learning", 2024), paper("three", "Tool-learning tasks", 2025)] });
  } });
  assert.equal(calls, 2); assert.equal(r.scanned, 3); assert.equal(r.complete, true); assert.deepEqual(r.related.map(y => y.count), [1, 0, 1, 0]);
  assert.equal(matchesPhrase("Acquisition for robot skills", "skill learning"), false);
});
test("an interrupted census never converts unvisited records into zero counts", async () => {
  const r = await crossrefCensus(source, ["entity matching"], { period, maxRecords: 1, request: async () => response({ "total-results": 2000, "next-cursor": "next", items: [paper("one", "Entity matching", 2023)] }) });
  assert.equal(r.complete, false); assert.equal(r.count, null); assert.equal(r.observedCount, 1); assert.ok(r.related.every(y => y.count === null));
});
test("journal identity needs matching title and known ISSN", async () => {
  await assert.rejects(crossrefJournal("A Journal", { issns: ["8765-432X"] }, { request: async () => response({ items: [{ title: "A Journal", ISSN: ["1234-567X"] }] }) }), /ISSN/);
});
test("journal phrase selection retains core terms that can retrieve its own main baselines", () => {
  const terms = anchorPhrases(["industrial time series cleaning", "schema matching"], { queries: [{ query: '"data cleaning" AND "time series"' }, { query: '"tool learning"' }] }, [{ baselines: [{ title: "Akane: Perplexity-Guided Time Series Data Cleaning" }] }, { baselines: [{ title: "Tool Learning through Trial and Error" }] }]);
  assert.ok(terms.includes("data cleaning")); assert.ok(terms.includes("tool learning"));
});
