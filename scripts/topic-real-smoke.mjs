import assert from "node:assert/strict";
import { createSources } from "../server/topics/sources.js";
const sources = createSources();
for (const q of ['industrial AND anomaly AND detection', '"industrial anomaly detection"']) {
  const r = await sources.works(q, { limit: 3 }); assert.ok(r.total >= r.papers.length);
  console.log(JSON.stringify({ query: q, total: r.total, titles: r.papers.map(p => p.title), sourceUrl: r.sourceUrl }));
}
const grouped = await sources.groups('"industrial anomaly detection"', "publication_year", "");
assert.ok(Array.isArray(grouped.group_by)); console.log(JSON.stringify({ grouped: grouped.group_by, sourceUrl: grouped.sourceUrl }));
try { const r = await sources.arxiv("industrial anomaly detection"); console.log(JSON.stringify({ arxiv: r.papers.length, titles: r.papers.slice(0, 2).map(p => p.title) })); }
catch (e) { console.error("arXiv live check unavailable:", e.message); process.exitCode = 1; }
