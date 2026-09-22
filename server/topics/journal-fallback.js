import { remote, normalizeCrossref, years } from "./sources.js";

const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function topicPhrases(values) {
  return [...new Set((values || []).map(norm).filter(s => s.split(" ").length >= 2 && s.split(" ").length <= 6 && !/^(machine learning|deep learning|artificial intelligence|computer science|large language models?)$/.test(s)))].slice(0, 24);
}
export function matchesPhrase(text, phrase) {
  const tokens = norm(phrase).split(" ").map(s => s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);
  return new RegExp(`(?:^| )${tokens.map(s => `${s}s?`).join(" ")}(?: |$)`).test(norm(text));
}
export function anchorPhrases(proposed, plan, directions) {
  const terms = topicPhrases((plan.queries || []).flatMap(q => [...(q.query || "").matchAll(/"([^"]+)"/g)].map(m => m[1])));
  const anchors = directions.flatMap(d => {
    const p = d.baselines?.[0]; if (!p) return [];
    return terms.filter(t => matchesPhrase(`${p.title} ${p.abstract || ""}`, t)).sort((a, b) => a.split(" ").length - b.split(" ").length).slice(0, 2);
  });
  // Preserve short terms grounded in each main baseline before allowing model
  // elaborations such as "industrial time series cleaning" to narrow coverage.
  return topicPhrases([...anchors, ...proposed]);
}
export async function crossrefJournal(name, known = null, { signal, request = remote } = {}) {
  const url = `https://api.crossref.org/journals?query=${encodeURIComponent(name)}&rows=8`;
  const r = JSON.parse((await request(url, { signal })).buffer.toString());
  if (r.status !== "ok" || !Array.isArray(r.message?.items)) throw new Error("Crossref 期刊身份响应无效");
  const identity = title => norm(title.replace(/&/g, " and "));
  const j = r.message.items.find(j => identity(j.title) === identity(name));
  if (!j?.ISSN?.length) throw new Error(`Crossref 未核实期刊身份：${name}`);
  if (known?.issns?.length && !j.ISSN.some(n => known.issns.includes(n))) throw new Error(`期刊名称匹配但 ISSN 不一致：${name}`);
  return { id: known?.id || `https://api.crossref.org/journals/${j.ISSN[0]}`, display_name: j.title, type: "journal", issn: j.ISSN, homepage_url: null, publisher: j.publisher, sourceUrl: url };
}
export async function crossrefCensus(source, phrases, { signal, request = remote, period = years(), maxRecords = 30000, onPage = () => {} } = {}) {
  if (!/^\d{4}-\d{3}[\dX]$/.test(source.issn?.[0] || "")) throw new Error("缺少核实后的期刊 ISSN");
  const base = new URL(`https://api.crossref.org/journals/${source.issn[0]}/works`);
  base.searchParams.set("filter", `from-pub-date:${period.from},until-pub-date:${period.to},type:journal-article`);
  base.searchParams.set("select", "DOI,title,abstract,subject,published,issued,URL,container-title,ISSN,is-referenced-by-count,type,link,resource");
  base.searchParams.set("rows", "1000");
  let cursor = "*", expected = null, complete = false; const records = new Map(), urls = [];
  while (records.size < maxRecords) {
    signal?.throwIfAborted(); const u = new URL(base); u.searchParams.set("cursor", cursor);
    const r = JSON.parse((await request(u.href, { signal })).buffer.toString());
    if (r.status !== "ok" || !Array.isArray(r.message?.items)) throw new Error("Crossref 年度统计响应无效");
    expected ??= r.message["total-results"]; urls.push(u.href);
    const before = records.size;
    for (const w of r.message.items) records.set(w.DOI, normalizeCrossref(w));
    onPage(records.size, expected);
    if (!r.message.items.length || records.size >= expected) { complete = true; break; }
    if (!r.message["next-cursor"] || r.message["next-cursor"] === cursor || records.size === before) break;
    cursor = r.message["next-cursor"];
  }
  const terms = topicPhrases(phrases), allPapers = [...records.values()];
  const matched = allPapers.filter(p => terms.some(t => matchesPhrase(`${p.title} ${p.abstract}`, t)));
  const series = rows => [...period.complete, period.partial].map(year => ({ year, count: complete ? rows.filter(p => p.year === year).length : null, observed: rows.filter(p => p.year === year).length, partial: year === period.partial }));
  const keyword = terms.map(name => ({ name, count: matched.filter(p => period.complete.includes(p.year) && matchesPhrase(`${p.title} ${p.abstract}`, name)).length,
    years: Object.fromEntries(period.complete.map(y => [y, complete ? matched.filter(p => p.year === y && matchesPhrase(`${p.title} ${p.abstract}`, name)).length : null])), sources: [urls[0]] })).filter(k => k.count).sort((a, b) => b.count - a.count);
  return { source, phrases: terms, sourceUrl: urls[0], retrievedAt: new Date().toISOString(), complete, expected, scanned: records.size,
    related: series(matched), all: series(allPapers), count: complete ? matched.length : null, observedCount: matched.length,
    papers: matched.sort((a, b) => (b.year - a.year) || (b.citations - a.citations)).slice(0, 100), keywords: keyword,
    records: allPapers.map(p => ({ id: p.id, title: p.title, year: p.year, abstract: p.abstract })),
    keywordCoverage: complete ? period.complete : [], keywordMethod: "Crossref 逐页读取本刊近三年及当年已注册 DOI；在题名及已提供摘要中匹配列出的细分短语，逐篇去重计数。关键词频次属于明确短语，不是全领域关键词总量。",
    countScope: `Crossref 题名/已提供摘要的明确短语匹配量（${complete ? "已遍历完整 DOI 结果集" : "结果集未遍历完，趋势保留未知"}；不是该主题的全部论文）。该刊扫描 ${records.size} 条，共 ${expected ?? "未知"} 条。`,
    method: "crossref-title-abstract-census", abstractCoverage: allPapers.length ? Math.round(100 * allPapers.filter(p => p.abstract).length / allPapers.length) : 0 };
}
