// Academic search aggregator. Open sources only (reusing their public APIs);
// WoS / Google Scholar are listed but require subscriptions / have no open API.
// Every adapter returns the same normalized result shape:
// { id, source, title, authors[], year, date, doi, venue, citations, oa,
//   pdfUrl, url, abstract, keywords[] }

const UA = "PiPaper/0.5 (academic reader; local app)";

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

function normDoi(doi) {
  return String(doi || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
}

// OpenAlex: abstract is an inverted index — rebuild it
function openalexAbstract(inv) {
  if (!inv) return "";
  const pos = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = word;
  return pos.filter(Boolean).join(" ").slice(0, 1500);
}

async function jget(url, headers = {}) {
  let r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 1800));
    r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20000) });
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function searchOpenAlex(q, o) {
  const filters = [];
  if (o.yearFrom) filters.push(`from_public_date:${o.yearFrom}-01-01`);
  if (o.yearTo) filters.push(`to_public_date:${o.yearTo}-12-31`);
  if (o.oa) filters.push("is_oa:true");
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", q);
  url.searchParams.set("per-page", String(o.limit || 20));
  // polite pool: unauthenticated but identifiable
  url.searchParams.set("mailto", "pipaper@local");
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  if (o.sort === "citations") url.searchParams.set("sort", "cited_by_count:desc");
  if (o.sort === "year") url.searchParams.set("sort", "publication_date:desc");
  const j = await jget(url);
  return (j.results || []).map((w) => ({
    id: "openalex:" + w.id,
    source: "openalex",
    title: w.title || w.display_name || "(无标题)",
    authors: (w.authorships || []).slice(0, 8).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year,
    date: w.publication_date || "",
    doi: normDoi(w.doi),
    venue: w.primary_location?.source?.display_name || "",
    citations: w.cited_by_count || 0,
    oa: !!w.open_access?.is_oa,
    pdfUrl: w.best_oa_location?.pdf_url || w.best_oa_location?.landing_page_url || "",
    url: w.doi || w.id,
    abstract: openalexAbstract(w.abstract_inverted_index),
    keywords: (w.concepts || []).slice(0, 5).map((c) => c.display_name),
  }));
}

async function searchSemanticScholar(q, o) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", q);
  url.searchParams.set("limit", String(o.limit || 20));
  url.searchParams.set("fields", "title,authors,year,abstract,externalIds,venue,citationCount,openAccessPdf,publicationDate,fieldsOfStudy");
  if (o.yearFrom || o.yearTo) {
    const range = `${o.yearFrom || ""}-${o.yearTo || ""}`;
    url.searchParams.set("year", range);
  }
  // optional key: put {"id":"semanticscholar","apiKey":"..."} in data/search-sources.json
  const headers = {};
  try {
    const f = path.join(DATA_DIR, "search-sources.json");
    if (fs.existsSync(f)) {
      const s = (JSON.parse(fs.readFileSync(f, "utf8")) || []).find((x) => x.id === "semanticscholar" && x.apiKey);
      if (s) headers["x-api-key"] = s.apiKey;
    }
  } catch {}
  const j = await jget(url, headers);
  return (j.data || []).map((p) => ({
    id: "s2:" + p.paperId,
    source: "semanticscholar",
    title: p.title || "(无标题)",
    authors: (p.authors || []).slice(0, 8).map((a) => a.name),
    year: p.year,
    date: p.publicationDate || "",
    doi: normDoi(p.externalIds?.DOI),
    venue: p.venue || "",
    citations: p.citationCount || 0,
    oa: !!p.openAccessPdf,
    pdfUrl: p.openAccessPdf?.url || "",
    url: p.externalIds?.DOI ? "https://doi.org/" + p.externalIds.DOI : "",
    abstract: (p.abstract || "").slice(0, 1500),
    keywords: (p.fieldsOfStudy || []).slice(0, 5),
  }));
}

// minimal Atom XML → items (arXiv)
function parseAtom(xml) {
  const items = [];
  const entries = xml.split(/<entry>/).slice(1);
  for (const raw of entries) {
    const pick = (tag) => {
      const m = raw.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
    };
    items.push({
      id: "arxiv:" + pick("id"),
      title: pick("title").replace(/\s+/g, " "),
      authors: [...raw.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1]).slice(0, 8),
      year: Number((pick("published").match(/(\d{4})/) || [])[1]) || null,
      date: pick("published").slice(0, 10),
      doi: normDoi((raw.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/) || [])[1]),
      venue: "arXiv",
      citations: null,
      abstract: pick("summary").replace(/\s+/g, " ").slice(0, 1500),
      pdfUrl: (raw.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/) || [])[1] || pick("id").replace("http://", "https://").replace("/abs/", "/pdf/"),
      url: pick("id"),
    });
  }
  return items;
}

async function searchArxiv(q, o) {
  // phrase match on title/abstract keeps relevance high for multi-word queries
  const quoted = `"${q.replace(/"/g, " ")}"`;
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `abs:${quoted} OR ti:${quoted}`);
  url.searchParams.set("max_results", String(o.limit || 20));
  url.searchParams.set("sortBy", o.sort === "year" ? "submittedDate" : "relevance");
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let items = parseAtom(await r.text());
  if (o.yearFrom) items = items.filter((i) => i.year >= o.yearFrom);
  if (o.yearTo) items = items.filter((i) => i.year <= o.yearTo);
  if (o.sort === "citations") items = items.slice().reverse();
  return items.map((i) => ({ ...i, oa: true, keywords: [] }));
}

async function searchCrossref(q, o) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", q);
  url.searchParams.set("rows", String(o.limit || 20));
  url.searchParams.set("select", "DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL,subject");
  if (o.yearFrom) url.searchParams.set("filter", `from-pub-date:${o.yearFrom}-01-01`);
  const j = await jget(url);
  return (j.message?.items || []).map((w) => {
    const year = w.issued?.["date-parts"]?.[0]?.[0] || null;
    return {
      id: "crossref:" + w.DOI,
      source: "crossref",
      title: (w.title || ["(无标题)"])[0],
      authors: (w.author || []).slice(0, 8).map((a) => [a.given, a.family].filter(Boolean).join(" ")),
      year,
      date: w.issued?.["date-parts"]?.[0]?.join("-") || "",
      doi: normDoi(w.DOI),
      venue: (w["container-title"] || [])[0] || "",
      citations: w["is-referenced-by-count"] ?? null,
      oa: false,
      pdfUrl: "",
      url: w.URL || (w.DOI ? "https://doi.org/" + w.DOI : ""),
      abstract: String(w.abstract || "").replace(/<[^>]+>/g, "").slice(0, 1200),
      keywords: (w.subject || []).slice(0, 5),
    };
  });
}

async function searchPubMed(q, o) {
  const term = encodeURIComponent(q);
  const esearch = await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${o.limit || 20}&term=${term}${o.yearFrom ? `&mindate=${o.yearFrom}&maxdate=${o.yearTo || "3000"}` : ""}`);
  const ids = esearch.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const sum = await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`);
  return ids.map((id) => {
    const d = sum.result?.[id] || {};
    return {
      id: "pubmed:" + id,
      source: "pubmed",
      title: d.title || "(无标题)",
      authors: (d.authors || []).slice(0, 8).map((a) => a.name),
      year: Number((d.pubdate || "").match(/(\d{4})/)?.[1]) || null,
      date: (d.pubdate || "").slice(0, 11),
      doi: normDoi((d.articleids || []).find((x) => x.idtype === "doi")?.value),
      venue: d.fulljournalname || d.source || "",
      citations: null,
      oa: false,
      pdfUrl: "",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      abstract: String(d.elocationid || "").slice(0, 0) || "",
      keywords: [],
    };
  });
}

export const ADAPTERS = {
  openalex: searchOpenAlex,
  semanticscholar: searchSemanticScholar,
  arxiv: searchArxiv,
  crossref: searchCrossref,
  pubmed: searchPubMed,
};

// Built-in source registry. Users can add/edit sources in
// data/search-sources.json (UI editor); type must be one of ADAPTERS keys,
// or "unavailable" for sources that need subscriptions (WoS) / have no open
// API (Google Scholar).
export const DEFAULT_SOURCES = [
  { id: "openalex", name: "OpenAlex", type: "openalex", enabled: true, note: "开放全库" },
  { id: "semanticscholar", name: "Semantic Scholar", type: "semanticscholar", enabled: true, note: "开放（限速 100次/5分钟）" },
  { id: "arxiv", name: "arXiv", type: "arxiv", enabled: true, note: "预印本" },
  { id: "crossref", name: "Crossref", type: "crossref", enabled: true, note: "DOI 元数据" },
  { id: "pubmed", name: "PubMed", type: "pubmed", enabled: false, note: "生物医学" },
  { id: "wos", name: "Web of Science", type: "unavailable", enabled: false, note: "需要机构订阅，无开放 API" },
  { id: "scholar", name: "Google Scholar", type: "unavailable", enabled: false, note: "无官方 API（反爬严格）" },
];

export function dedupe(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = r.doi ? "doi:" + r.doi : "title:" + normDoi(r.title).slice(0, 60);
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...r, sources: [r.source] });
    else {
      prev.sources.push(r.source);
      if (!prev.pdfUrl && r.pdfUrl) prev.pdfUrl = r.pdfUrl;
      if (!prev.abstract && r.abstract) prev.abstract = r.abstract;
      if ((r.citations || 0) > (prev.citations || 0)) prev.citations = r.citations;
      if (!prev.venue && r.venue) prev.venue = r.venue;
    }
  }
  return [...byKey.values()];
}

export async function aggregateSearch(q, { sources, yearFrom, yearTo, oa, sort, limit } = {}) {
  const use = (sources && sources.length ? sources : DEFAULT_SOURCES.filter((s) => s.enabled).map((s) => s.id)).slice(0, 8);
  const opts = { yearFrom: yearFrom && Number(yearFrom), yearTo: yearTo && Number(yearTo), oa: !!oa, sort, limit: limit || 15 };
  const settled = await Promise.allSettled(use.map(async (id) => {
    const def = DEFAULT_SOURCES.find((s) => s.id === id);
    const type = def?.type || id;
    const adapter = ADAPTERS[type];
    if (!adapter) return [];
    return adapter(q, opts);
  }));
  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(...s.value);
    else errors.push(`${use[i]}: ${String(s.reason?.message || s.reason).slice(0, 80)}`);
  });
  let merged = dedupe(results);
  if (sort === "citations") merged.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  else if (sort === "year") merged.sort((a, b) => (b.year || 0) - (a.year || 0));
  return { results: merged.slice(0, 60), total: merged.length, errors };
}

// quality tier heuristic (open data only — no JCR): citations drive the tier
export function tierOf(r) {
  const c = r.citations || 0;
  if (c >= 400) return { label: "领域经典", color: "#e5c07b" };
  if (c >= 100) return { label: "高被引", color: "#4cc38a" };
  if (c >= 10) return { label: "有影响力", color: "#7c9cff" };
  return { label: "新文献", color: "#767e99" };
}
