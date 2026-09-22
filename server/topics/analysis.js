import { years, safeURL } from "./sources.js";
import { fault } from "./store.js";

const BROAD = new Set(["computer science", "machine learning", "deep learning", "artificial intelligence", "computer vision", "engineering", "mathematics", "biology", "physics", "chemistry", "data science", "neural network", "algorithm", "medicine", "计算机科学", "机器学习", "深度学习", "人工智能", "计算机技术"]);
export function keywordFrequency(papers, period = years()) {
  const counts = new Map();
  for (const p of papers) if (period.complete.includes(p.year)) for (const name of new Set((p.keywords || []).map(k => k.trim().toLowerCase()).filter(k => k.length > 2 && !BROAD.has(k)))) {
    if (!counts.has(name)) counts.set(name, { name, count: 0, years: Object.fromEntries(period.complete.map(y => [y, 0])) });
    const c = counts.get(name); c.count++; c.years[p.year]++;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 18);
}
export function groupedKeywords(responses, period = years()) {
  const map = new Map();
  for (const r of responses) for (const g of r.data.group_by || []) {
    const name = String(g.key_display_name || "").toLowerCase(); if (!name || BROAD.has(name) || !String(g.key).includes("/keywords/")) continue;
    if (!map.has(g.key)) map.set(g.key, { name, count: 0, years: Object.fromEntries(period.complete.map(y => [y, null])), sources: [] });
    const k = map.get(g.key); k.count += g.count; k.years[r.year] = g.count; k.sources.push(r.data.sourceUrl);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 18);
}
export function yearly(groups, period = years()) {
  if (!groups) return [...period.complete, period.partial].map(year => ({ year, count: null, partial: year === period.partial }));
  return [...period.complete, period.partial].map(year => ({ year, count: groups.find(g => String(g.key) === String(year))?.count || 0, partial: year === period.partial }));
}
export function journalMetrics({ related, all, papers, totalRelated, period = years() }) {
  const known = related.filter(x => !x.partial && x.count != null), first = known[0]?.count, last = known.at(-1)?.count;
  const growth = first > 0 && known.length === 3 ? Math.round((last - first) / first * 100) : null;
  const completeTotal = all.filter(x => !x.partial).reduce((n, x) => n + (x.count || 0), 0);
  const relatedTotal = known.reduce((n, x) => n + x.count, 0);
  const concentration = completeTotal > 0 ? Math.min(100, Math.round(100 * relatedTotal / completeTotal)) : null;
  const knownOA = papers.filter(p => typeof p.paperOpenAccess === "boolean");
  const oa = knownOA.length ? Math.round(100 * knownOA.filter(p => p.paperOpenAccess).length / knownOA.length) : null;
  const coverage = papers.length ? Math.round(100 * papers.filter(p => p.abstract).length / papers.length) : 0;
  const radar = [concentration, totalRelated == null ? null : Math.min(100, Math.round(Math.log10(totalRelated + 1) * 30)), growth == null ? null : Math.max(0, Math.min(100, 50 + growth / 2)), oa, papers.length ? coverage : null];
  const weights = [.4, .2, .15, .1, .15];
  // Missing values reduce available evidence; they never become invented scores.
  const denominator = weights.reduce((n, w, i) => n + (radar[i] == null ? 0 : w), 0);
  const match = denominator ? Math.round(radar.reduce((n, v, i) => n + (v == null ? 0 : v * weights[i]), 0) / denominator) : null;
  return { growth, concentration, oa, coverage, radar, match, scoreCoverage: Math.round(denominator * 100), keywords: keywordFrequency(papers, period),
    scoreMethod: "主题集中度40% + 方向活跃度20% + 三年增长15% + 开放获取10% + 摘要完整度15%。缺失项不计并标明覆盖率；这是检索匹配分，不是录用概率。" };
}
const normalize = s => String(s || "").normalize("NFKC").replace(/[*`#]/g, "").replace(/\s+/g, "").toLowerCase();
export function hardwareEvidence(hardware, docs) {
  if (!supported(hardware, docs) || !Number.isFinite(hardware.gpuCount) || hardware.gpuCount < 0 || !Number.isFinite(hardware.vramGB) || hardware.vramGB < 0) return false;
  const quote = hardware.quote;
  // A model name in the introduction is not proof of an API reproduction route.
  if (hardware.mode === "api") return hardware.gpuCount === 0 && hardware.vramGB === 0 && /(?:API[ _-]?key|OPENAI_API_KEY|(?:use|using|evaluate|evaluated|run|access|call|via|through).{0,100}\bAPI\b|test_gpt\.py[\s\S]{0,200}--setting ICL)/i.test(quote);
  if (hardware.mode === "cpu") return hardware.gpuCount === 0 && hardware.vramGB === 0 && /\bCPU\b|Intel|AMD|no GPU/i.test(quote) && (!/NVIDIA|GeForce|Quadro|CUDA|\bGPU\b/i.test(quote) || /no GPU|without.{0,20}GPU|CPU.only/i.test(quote));
  const capacity = [...quote.matchAll(/(\d+(?:\.\d+)?)\s*(?:GB|GiB)/gi)].map(m => Number(m[1]));
  return hardware.gpuCount > 0 && capacity.includes(hardware.vramGB);
}
export function datasetEvidence(dataset, documents) {
  return supported(dataset, documents) && !/^\s*(?:python|pip|npm|curl|git|java|--|\$)/i.test(dataset.quote) && /data|benchmark|corpus|样本|数据/i.test(dataset.quote) && /publicly|public datasets?|availab|releas|open.source|licen[sc]|download|provide.{0,60}data|公开|开源|下载|提供/i.test(dataset.quote);
}
export function supported(claim, documents) {
  if (!claim || typeof claim.quote !== "string" || normalize(claim.quote).length < 12 || !safeURL(claim.url)) return false;
  const doc = documents.find(d => d.url === claim.url);
  const pageQuote = claim.quote.match(/^\[第(\d+)页\]\s*([\s\S]+)/);
  if (pageQuote) return !!doc?.pages?.some(p => p.page === Number(pageQuote[1]) && normalize(p.text).includes(normalize(pageQuote[2])));
  return !!doc && normalize(doc.text).includes(normalize(claim.quote));
}
export function validatePlan(value) {
  if (!Array.isArray(value.queries) || value.queries.length < 1 || value.queries.length > 5 || value.queries.some(q => typeof q.query !== "string" || !q.query.trim() || q.query.length > 250 || typeof q.focus !== "string")) throw fault("检索规划不完整，请重试", 422);
  if (!Array.isArray(value.policyTerms) || value.policyTerms.length < 1) throw fault("缺少政策检索词", 422);
  return value;
}
export function validateDirections(value, papers, docs, profile, period = years()) {
  if (!Array.isArray(value.directions) || value.directions.length < 3) throw fault("报告至少需要三个有证据的候选问题", 422);
  const byId = new Map(papers.map(p => [p.id, p]));
  const canonical = id => byId.has(id) ? id : papers.find(p => (/^W\d+$/.test(String(id)) && p.id === `https://openalex.org/${id}`) || [p.doi, ...(p.aliases || [])].filter(Boolean).some(alias => alias.toLowerCase() === String(id).toLowerCase()))?.id || id;
  return value.directions.slice(0, 8).map((d, i) => {
    d.baselineIds = d.baselineIds?.map(canonical); d.evidenceIds = d.evidenceIds?.map(canonical);
    for (const e of d.extensions || []) { e.paperId = canonical(e.paperId); e.parentId = canonical(e.parentId); }
    if (["cpu", "api"].includes(d.hardware?.mode) && d.hardware.gpuCount === 0 && d.hardware.vramGB == null) d.hardware.vramGB = 0;
    if (![d.name, d.problem, d.rationale, d.story, d.smallPaper, d.critique, d.experiment].every(x => typeof x === "string" && x.trim()) || !Array.isArray(d.baselineIds) || new Set(d.baselineIds).size < 3 || !Array.isArray(d.evidenceIds) || !d.evidenceIds.length) throw fault("方向报告缺少问题、故事线、实验、挑刺或三个 baseline", 422);
    if ([...d.baselineIds, ...d.evidenceIds].some(id => !byId.has(id))) throw fault("模型引用了检索结果之外的论文", 422);
    const baselines = d.baselineIds.slice(0, 3).map(id => byId.get(id));
    if (baselines.some(p => !p.date || p.date < period.baselineFrom || p.date > period.to)) throw fault("Baseline 必须是滚动近三年内有确切日期的论文", 422);
    if (baselines.some(p => !p.quality?.eligible || !((p.quality.system === "CAS" && p.quality.rank === 1) || (p.quality.system === "CCF" && p.quality.rank === "A")) || !safeURL(p.quality.sourceUrl) || !safeURL(p.quality.publicationUrl))) throw fault("Baseline 必须有中科院1区或CCF A正式长文的已核验发表证据，预印本/未核实来源不可入选", 422);
    if (baselines[0].type === "review") throw fault("综述不能作为要复现的主 Baseline", 422);
    const baselineDocs = docs.filter(x => x.paperIds?.includes(baselines[0].id));
    const dataset = datasetEvidence(d.dataset, baselineDocs) && safeURL(d.dataset.downloadUrl) && baselineDocs.some(x => x.url === d.dataset.downloadUrl)
      ? { ...d.dataset, status: d.dataset.open === true ? "open-evidence" : "closed" } : { status: "unknown", note: "未取得数据公开许可与下载入口的可核验证据" };
    const hardware = hardwareEvidence(d.hardware, baselineDocs)
      ? { ...d.hardware, status: "reported" } : { status: "unknown", note: "论文或代码未报告可核实的显存和卡数；不可据此保证可复现" };
    const reasons = [];
    if (profile?.openData && dataset.status !== "open-evidence") reasons.push("尚未满足必须公开数据的要求");
    if (profile) {
      if (hardware.status === "reported" && hardware.mode === "cpu" && /cluster|scale.out nodes|集群/i.test(hardware.quote)) reasons.push("原论文使用 CPU 集群，单机缩配复现尚待实测");
      else if (hardware.status === "reported" && hardware.gpuCount === 0 && hardware.vramGB === 0 && (["cpu", "api"].includes(hardware.mode))) { /* Local GPU bounds do not apply to a documented CPU/API route. */ }
      else if (profile.gpuCount == null || profile.vramGB == null) reasons.push("画像缺少可比较的 GPU 卡数或单卡显存");
      else if (hardware.status !== "reported") reasons.push("尚未核实硬件需求");
      else if (hardware.gpuCount > profile.gpuCount || hardware.vramGB > profile.vramGB) reasons.push("论文报告的硬件超过画像上限，缩配复现尚待实测");
    }
    const policy = (d.policy || []).filter(p => supported(p, docs));
    const extensions = (d.extensions || []).filter(e => {
      const p = byId.get(e.paperId), parent = byId.get(e.parentId);
      return p?.quality?.eligible && parent && baselines.some(b => b.id === parent.id) && p.date >= period.baselineFrom && p.date <= period.to && p.references?.some(ref => [parent.id, parent.doi, ...(parent.aliases || [])].filter(Boolean).some(id => id.toLowerCase() === ref.toLowerCase())) && supported(e, docs);
    }).map(e => ({ ...e, paper: byId.get(e.paperId) }));
    return { ...d, id: `direction-${i + 1}`, baselines, dataset, hardware, policy, extensions,
      eligible: !reasons.length, filterReasons: reasons, evidence: d.evidenceIds.map(id => byId.get(id)) };
  });
}
export function validateVenueEvidence(value, documents) {
  const copy = { cas: null, conference: null, review: null };
  if (value?.cas && supported(value.cas, documents) && /(^|\.)fenqubiao\.com$/.test(new URL(value.cas.url).hostname) && [1, 2, 3, 4].includes(value.cas.zone) && Number.isInteger(value.cas.year)) copy.cas = value.cas;
  if (value?.conference && supported(value.conference, documents) && /(^|\.)ccf\.org\.cn$/.test(new URL(value.conference.url).hostname) && ["A", "B", "C"].includes(value.conference.rank)) copy.conference = value.conference;
  if (value?.review && supported(value.review, documents) && Number.isFinite(value.review.days) && value.review.days > 0 && ["first-decision", "review", "acceptance"].includes(value.review.metric)) copy.review = value.review;
  return copy;
}
