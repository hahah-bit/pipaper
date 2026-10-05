import { mergePapers, years } from "./sources.js";
import { conferenceLocator, qualifyPapers, BASELINE_POLICY } from "./quality.js";

export async function retrieve(plan, { sources, signal, save = () => {}, log = () => {}, getDoc, documents = [], period = years(), cachedSearches = [] }) {
  const rows = [], attempts = [], warnings = [], coverage = [], cache = new Map();
  for (const r of cachedSearches) if (r.status === "ok" && Array.isArray(r.papers) && r.source && r.query) cache.set(`${r.source}:${r.query}`, r);
  const search = async (name, query, focus, run) => {
    signal?.throwIfAborted(); const startedAt = new Date().toISOString();
    try {
      const key = `${name}:${query}`, cacheHit = cache.has(key);
      const r = cacheHit ? cache.get(key) : await run();
      if (!Array.isArray(r.papers)) throw new Error("来源缺少 papers 数组，不能视为零篇");
      cache.set(key, r);
      const attempt = { source: name, query, focus, startedAt, status: "ok", cacheHit, count: r.papers.length, total: r.total ?? null, sourceUrl: r.sourceUrl };
      attempts.push(attempt); save("search", `${name} · ${focus}`, { ...r, ...attempt });
      rows.push(...r.papers.map(p => ({ ...p, queries: [query], queryIds: [focus] })));
      return r.papers;
    } catch (e) {
      signal?.throwIfAborted(); const attempt = { source: name, query, focus, startedAt, status: "error", count: null, error: e.message };
      attempts.push(attempt); save("search", `${name} · 检索失败 · ${focus}`, { ...attempt, sourcePaused: !!e.sourcePaused }); warnings.push(`${name}：${e.message}`);
      log("search", `${name} 暂不可用，继续其他来源：${e.message}`); return [];
    }
  };
  for (const [questionIndex, q] of plan.queries.entries()) {
    let local = [];
    for (const [index, query] of (q.variants || [q.query]).entries()) {
      log("search", `问题 ${questionIndex + 1}/${plan.queries.length} · ${q.parent || "细分问题"} / ${q.name || q.focus} · ${index ? "扩展" : "首轮"}：${query}`);
      local.push(...await search("OpenAlex 相关度", query, q.name || q.focus, () => sources.works(query, { signal, sort: "relevance_score:desc", limit: 60 })));
      if (!index) {
        local.push(...await search("OpenAlex 高被引", query, q.name || q.focus, () => sources.works(query, { signal, sort: "cited_by_count:desc", limit: 40 })));
        local.push(...await search("OpenAlex 最新", query, q.name || q.focus, () => sources.works(query, { signal, sort: "publication_date:desc", limit: 40 })));
      }
      const pool = mergePapers(local), formalCandidates = pool.filter(conferenceLocator).length;
      if (sources.crossref && (pool.length < 12 || formalCandidates < 3)) local.push(...await search("Crossref", query, q.name || q.focus, () => sources.crossref(query, { signal, limit: 35 })));
      if (!index) local.push(...await search("arXiv 最新", query, q.name || q.focus, () => sources.arxiv(query, signal)));
      const enough = mergePapers(local).filter(p => p.date >= period.baselineFrom && p.date <= period.to && conferenceLocator(p)).length >= 5;
      if (enough) break;
    }
    const distinct = mergePapers(local);
    coverage.push({ id: q.id, name: q.name || q.focus, parent: q.parent, count: distinct.length, candidateCount: distinct.filter(conferenceLocator).length, queries: attempts.filter(a => a.focus === (q.name || q.focus)).map(a => a.query) });
    log("search", `${q.name || q.focus}：取回 ${distinct.length} 篇去重文献，${distinct.filter(conferenceLocator).length} 篇有顶会发表入口，正在逐篇核验。`);
  }
  let papers = mergePapers(rows);
  // Balance verification across atomic questions so the first high-volume field
  // cannot consume the whole verification budget.
  const queues = plan.queries.map(q => papers.filter(p => p.queries?.some(s => (q.variants || [q.query]).includes(s)) && p.date >= period.baselineFrom && p.date <= period.to).sort((a, b) => (b.citations || 0) - (a.citations || 0)));
  const ordered = [], seen = new Set();
  for (let i = 0; queues.some(q => i < q.length); i++) for (const queue of queues) if (queue[i] && !seen.has(queue[i].id)) { ordered.push(queue[i]); seen.add(queue[i].id); }
  log("quality", `已取回 ${papers.length} 篇去重文献，开始核验近期正式发表记录`);
  let checked = 0;
  await qualifyPapers(ordered, { getDoc: async (url, title) => { log("quality", `正在核验第 ${++checked} 篇发表记录 · ${title}`); return getDoc(url, title); }, documents, signal, limit: 72 });
  papers = mergePapers([...ordered, ...papers]);
  const eligible = papers.filter(p => p.quality?.eligible && p.date >= period.baselineFrom && p.date <= period.to && p.type !== "review");
  for (const c of coverage) { const q = plan.queries.find(q => q.id === c.id); c.verifiedCount = eligible.filter(p => p.queries?.some(s => q.variants.includes(s))).length; }
  const summary = { policy: BASELINE_POLICY, total: papers.length, eligible: eligible.length, attempts, coverage, warnings: [...new Set(warnings)] };
  save("retrieval", "关键词检索覆盖与 Baseline 来源核验", summary);
  log("quality", `检索 ${papers.length} 篇去重文献；${eligible.length} 篇通过“中科院1区 / CCF A正式长文”及近三年核验。预印本和来源未核实论文仅作研究线索。`);
  return { papers, eligible, summary, warnings: summary.warnings };
}
