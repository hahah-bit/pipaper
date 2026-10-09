import { scheduleArxiv } from "../platform/academic/arxiv-rate.js";
import { remote } from "../platform/academic/transport.js";
import { normalizeDoi as normDoi, openalexAbstract, parseArxivFeed } from "../platform/academic/metadata.js";
// Academic search aggregator. Open sources only (reusing their public APIs);
// WoS / Google Scholar are listed but require subscriptions / have no open API.
// Every adapter returns the same normalized result shape:
// { id, source, title, authors[], year, date, doi, venue, citations, oa,
//   pdfUrl, url, abstract, keywords[] }

const UA = "PiPaper/0.5 (academic reader; local app)";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { DATA_DIR, getConfig } from "../config.js";
import { rankResults } from "./readscore.js";

// 随仓库分发的数据资产目录；DATA_DIR 为旧机回退路径
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

// journal metrics (SJR 2026, imported from sci-helper's catalog):
// issn(digits-only) -> {sjr, q, cat}
let metricsByIssn = null;
function metrics() {
  if (!metricsByIssn) {
    for (const dir of [ASSETS_DIR, DATA_DIR]) {
      try {
        metricsByIssn = JSON.parse(fs.readFileSync(path.join(dir, "journal-metrics-2026.json"), "utf8"));
        break;
      } catch {
        metricsByIssn = {};
      }
    }
  }
  return metricsByIssn;
}

export function validatedJournalMetrics(record) {
  // Some bundled catalog rows have shifted columns (e.g. q="1.336", sjr=0).
  // These cannot establish either metric; do not infer a partition from a
  // decimal or swap fields based on a guessed CSV layout.
  const quartile = typeof record?.q === "number" ? record.q : /^[1-4]$/.test(String(record?.q || "")) ? Number(record.q) : null;
  if (!Number.isInteger(quartile) || quartile < 1 || quartile > 4) return { sjr: null, quartile: null };
  const sjr = typeof record.sjr === "number" && Number.isFinite(record.sjr) && record.sjr >= 0 ? record.sjr : null;
  return { sjr, quartile: "Q" + quartile };
}

function enrich(r) {
  // attach journal partition (分区) + SJR impact metric by matching ISSNs
  const issns = (r.issns || []).map((i) => String(i).replace(/-/g, ""));
  let m = null;
  for (const i of issns) {
    if (metrics()[i]) {
      m = metrics()[i];
      break;
    }
  }
  return Object.assign(r, validatedJournalMetrics(m));
}

function invalidResponse(source) {
  return Object.assign(new Error(`${source} 返回无效检索响应，不能视为零篇论文`), { code: "EINVALIDRESPONSE" });
}

async function jget(url, headers = {}, { request = remote, signal } = {}) {
  let response;
  try { response = await request(String(url), { headers: { "User-Agent": UA, ...headers }, signal, timeoutMs: 20000 }); }
  catch (error) {
    // A quota outage or long retry window cannot recover during this search.
    if (error.remoteStatus !== 429 || error.quota || error.retryAfter > 2) throw error;
    await delay(Math.max(1000, (error.retryAfter || 1.8) * 1000), undefined, { signal });
    signal?.throwIfAborted();
    response = await request(String(url), { headers: { "User-Agent": UA, ...headers }, signal, timeoutMs: 20000 });
  }
  try {
    const value = JSON.parse(response.buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(new URL(url).hostname);
    return value;
  }
  catch { throw invalidResponse(new URL(url).hostname); }
}

async function searchOpenAlex(q, o, sourceDef) {
  const filters = [];
  if (o.yearFrom) filters.push(`from_publication_date:${o.yearFrom}-01-01`);
  if (o.yearTo) filters.push(`to_publication_date:${o.yearTo}-12-31`);
  if (o.oa) filters.push("is_oa:true");
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", q);
  url.searchParams.set("per-page", String(o.limit || 20));
  const apiKey = sourceDef?.apiKey || o.env.OPENALEX_API_KEY || o.config().topicAnalysis?.openalexApiKey;
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  if (o.sort === "citations") url.searchParams.set("sort", "cited_by_count:desc");
  if (o.sort === "year") url.searchParams.set("sort", "publication_date:desc");
  const j = await jget(url, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, o);
  if (!Array.isArray(j.results) || j.error) throw invalidResponse("OpenAlex");
  return j.results.map((w) => ({
    id: "openalex:" + w.id,
    source: "openalex",
    title: w.title || w.display_name || "(无标题)",
    authors: (w.authorships || []).slice(0, 8).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year,
    date: w.publication_date || "",
    doi: normDoi(w.doi),
    venue: w.primary_location?.source?.display_name || "",
    issns: [w.primary_location?.source?.issn_l, ...((w.primary_location?.source?.issn || []).slice(0, 2))].filter(Boolean),
    citations: w.cited_by_count || 0,
    oa: !!w.open_access?.is_oa,
    pdfUrl: w.best_oa_location?.pdf_url || "",
    url: w.doi || w.id,
    abstract: openalexAbstract(w.abstract_inverted_index, 1500),
    keywords: (w.keywords?.length ? w.keywords : w.concepts || []).slice(0, 5).map((c) => c.display_name),
  }));
}

async function searchSemanticScholar(q, o, sourceDef) {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", q);
  url.searchParams.set("limit", String(o.limit || 20));
  url.searchParams.set("fields", "title,authors,year,abstract,externalIds,venue,citationCount,openAccessPdf,publicationDate,fieldsOfStudy");
  if (o.yearFrom || o.yearTo) {
    const range = `${o.yearFrom || ""}-${o.yearTo || ""}`;
    url.searchParams.set("year", range);
  }
  const headers = {};
  const apiKey = sourceDef?.apiKey || o.env.SEMANTIC_SCHOLAR_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;
  if (o.oa) url.searchParams.set("openAccessPdf", "");
  const j = await jget(url, headers, o);
  if (!Array.isArray(j.data) || j.error) throw invalidResponse("Semantic Scholar");
  return j.data.map((p) => ({
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
    url: p.externalIds?.DOI ? "https://doi.org/" + p.externalIds.DOI : `https://www.semanticscholar.org/paper/${p.paperId}`,
    abstract: (p.abstract || "").slice(0, 1500),
    keywords: (p.fieldsOfStudy || []).slice(0, 5),
  }));
}

function parseAtom(xml) {
  return parseArxivFeed(xml).map(paper => ({ ...paper, id: "arxiv:" + paper.id,
    doi: normDoi(paper.doi), venue: "arXiv", authors: paper.authors.slice(0, 8),
    abstract: paper.abstract.replace(/\s+/g, " ").slice(0, 1500), pdfUrl: paper.pdf }));
}

async function searchArxiv(q, o) {
  // phrase match on title/abstract keeps relevance high for multi-word queries
  const quoted = `"${q.replace(/"/g, " ")}"`;
  const url = new URL("https://export.arxiv.org/api/query");
  const dateRange = o.yearFrom || o.yearTo ? ` AND submittedDate:[${o.yearFrom || "0000"}01010000 TO ${o.yearTo || "9999"}12312359]` : "";
  url.searchParams.set("search_query", `(abs:${quoted} OR ti:${quoted})${dateRange}`);
  url.searchParams.set("max_results", String(o.limit || 20));
  url.searchParams.set("sortBy", o.sort === "year" ? "submittedDate" : "relevance");
  url.searchParams.set("sortOrder", "descending");
  const r = await o.schedule(() => o.request(url.href.replaceAll("+", "%20"), { signal: o.signal, timeoutMs: 20000 }), o.signal);
  let items = parseAtom(r.buffer.toString("utf8"));
  if (o.yearFrom) items = items.filter((i) => i.year >= o.yearFrom);
  if (o.yearTo) items = items.filter((i) => i.year <= o.yearTo);
  return items.map((i) => ({ ...i, source: "arxiv", oa: true, keywords: [] }));
}

async function searchCrossref(q, o) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", q);
  url.searchParams.set("rows", String(o.limit || 20));
  url.searchParams.set("select", "DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL,subject,ISSN");
  const filters = [];
  if (o.yearFrom) filters.push(`from-pub-date:${o.yearFrom}-01-01`);
  if (o.yearTo) filters.push(`until-pub-date:${o.yearTo}-12-31`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  if (o.sort === "citations" || o.sort === "year") {
    url.searchParams.set("sort", o.sort === "citations" ? "is-referenced-by-count" : "published");
    url.searchParams.set("order", "desc");
  }
  const j = await jget(url, {}, o);
  if (!Array.isArray(j.message?.items) || j.status === "failed") throw invalidResponse("Crossref");
  return j.message.items.map((w) => {
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
      issns: (w.ISSN || []).slice(0, 3),
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
  const dates = o.yearFrom || o.yearTo ? `&datetype=pdat&mindate=${o.yearFrom || "1000"}&maxdate=${o.yearTo || "3000"}` : "";
  const esearch = await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${o.limit || 20}&term=${term}${dates}`, {}, o);
  if (!Array.isArray(esearch.esearchresult?.idlist) || esearch.error) throw invalidResponse("PubMed");
  const ids = esearch.esearchresult.idlist;
  if (!ids.length) return [];
  const sum = await jget(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`, {}, o);
  if (!sum.result || sum.error || ids.some(id => !sum.result[id]?.title)) throw invalidResponse("PubMed");
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

function configuredLoopbackMirror(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && !url.username && !url.password &&
      (url.hostname === "localhost" || url.hostname === "[::1]" || (net.isIP(url.hostname) === 4 && url.hostname.startsWith("127.")));
  } catch { return false; }
}

async function localMirrorRequest(url, { headers, signal, timeoutMs = 25000 } = {}) {
  const origin = new URL(url).origin;
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const response = await fetch(url, { headers, signal: bounded, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location"), url);
      if (next.origin !== origin) throw new Error("本地镜像不能重定向到其他来源");
      url = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`本地镜像返回 HTTP ${response.status}`), { remoteStatus: response.status });
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      if ((size += chunk.length) > 2000000) throw new Error("本地镜像响应超过大小上限");
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), url };
  }
  throw new Error("本地镜像重定向过多");
}

// Google Scholar via logged-in browser cookie. The user verifies the mirror
// once in their browser, pastes the Cookie into the source config, and the
// server-side fetch reuses that session. Without a cookie the gate blocks us —
// reported as an actionable error.
async function searchScholarMirror(q, o, sourceDef) {
  const base = (sourceDef?.url || "https://sc.panda985.com").replace(/\/$/, "");
  const cookie = sourceDef?.cookie || "";
  const url = `${base}/scholar?hl=zh-CN&q=${encodeURIComponent(q)}${o.yearFrom ? `&as_ylo=${o.yearFrom}` : ""}${o.yearTo ? `&as_yhi=${o.yearTo}` : ""}`;
  // Explicitly configured local HTTP scholar services keep their existing
  // supported capability; arbitrary downloads cannot use this local exception.
  const request = configuredLoopbackMirror(sourceDef?.url) ? localMirrorRequest : o.request;
  const r = await request(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: o.signal, timeoutMs: 25000,
  });
  const html = r.buffer.toString("utf8");
  if (html.includes("verify_gate") || html.includes("Redirecting") || /captcha|unusual traffic/i.test(html)) {
    throw new Error("镜像需要浏览器验证 — 在浏览器打开一次该镜像并过验证后，把 Cookie 粘贴到检索源配置里（或直接用对话让 agent 走已登录浏览器检索）");
  }
  if (!/\bgs_(?:r|res_ccl|top|abe)\b/.test(html)) throw invalidResponse("Google 学术镜像");
  const results = [];
  // scholar result blocks: <div class="gs_r gs_or gs_scl" ...> ... </div> up to next block
  const blocks = html.split(/<div class="gs_r(?=[\s"])/).slice(1);
  for (const b of blocks) {
    const titleM = b.match(/<h3 class="gs_rt"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    const title = titleM[2].replace(/<[^>]+>/g, "").trim();
    const link = titleM[1].startsWith("http") ? titleM[1] : base + titleM[1];
    const am = b.match(/<div class="gs_a"[^>]*>([\s\S]*?)<\/div>/);
    const info = am ? am[1].replace(/<[^>]+>/g, "") : "";
    const year = Number((info.match(/(\d{4})/) || [])[0]) || null;
    const sm = b.match(/<div class="gs_rs">([\s\S]*?)<\/div>/);
    const snippet = sm ? sm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
    const cm = b.match(/被引用次数[：:]\s*(\d+)/) || b.match(/Cited by (\d+)/);
    const pdfM = b.match(/<a[^>]*href="([^"]+\.pdf[^"]*)"/i);
    results.push({
      id: "scholar:" + link,
      source: sourceDef?.id || "scholar",
      title,
      authors: info.split("-")[0]?.split(",")?.slice(0, 6).map((s) => s.trim()) || [],
      year,
      date: year ? String(year) : "",
      doi: normDoi((b.match(/doi\.org\/([^"&\s<]+)/) || [])[1]),
      venue: (info.split("-")[1] || "").split(",")[0].trim(),
      issns: [],
      citations: cm ? Number(cm[1]) : null,
      oa: !!pdfM,
      pdfUrl: pdfM ? pdfM[1] : "",
      url: link,
      abstract: snippet.slice(0, 800),
      keywords: [],
    });
  }
  return results;
}

export function createSearchAdapters({ request = remote, config = getConfig, env = process.env, schedule = scheduleArxiv } = {}) {
  return Object.fromEntries(Object.entries({ openalex: searchOpenAlex, semanticscholar: searchSemanticScholar,
    arxiv: searchArxiv, crossref: searchCrossref, pubmed: searchPubMed, "scholar-mirror": searchScholarMirror })
    .map(([type, adapter]) => [type, (q, options = {}, sourceDef) => adapter(q, { ...options, request, config, env, schedule }, sourceDef)]));
}
export const ADAPTERS = createSearchAdapters();

// Built-in source registry. Users can add/edit sources in
// data/search-sources.json (UI editor); type must be one of ADAPTERS keys,
// or "unavailable" for sources that need subscriptions (WoS) / have no open
// API (Google Scholar).
export const DEFAULT_SOURCES = [
  { id: "openalex", name: "OpenAlex", type: "openalex", enabled: true, note: "开放全库，带 ISSN（可查分区/SJR）" },
  { id: "semanticscholar", name: "Semantic Scholar", type: "semanticscholar", enabled: true, note: "开放（限速）；可配 apiKey" },
  { id: "arxiv", name: "arXiv", type: "arxiv", enabled: true, note: "预印本（无分区）" },
  { id: "crossref", name: "Crossref", type: "crossref", enabled: true, note: "DOI 元数据，带 ISSN" },
  { id: "scholar", name: "Google 学术（panda985 镜像）", type: "scholar-mirror", enabled: false, url: "https://sc.panda985.com", note: "需已登录浏览器的 Cookie：浏览器过一次验证后复制 Cookie 填入源配置" },
  { id: "pubmed", name: "PubMed", type: "pubmed", enabled: false, note: "生物医学" },
  { id: "wos", name: "Web of Science", type: "unavailable", enabled: false, note: "需要机构订阅；后续走已登录浏览器（暂缓）" },
  { id: "scholar-direct", name: "Google Scholar 官方", type: "unavailable", enabled: false, note: "无官方 API；镜像可用时可替代" },
];

export function dedupe(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = r.doi ? "doi:" + normDoi(r.doi) : "title:" + String(r.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...r, sources: [r.source] });
    else {
      if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
      if (!prev.pdfUrl && r.pdfUrl) prev.pdfUrl = r.pdfUrl;
      if (r.oa) prev.oa = true;
      if (!prev.abstract && r.abstract) prev.abstract = r.abstract;
      if ((r.citations || 0) > (prev.citations || 0)) prev.citations = r.citations;
      if (!prev.venue && r.venue) prev.venue = r.venue;
    }
  }
  return [...byKey.values()];
}

export function readSearchSources() {
  try {
    const f = path.join(DATA_DIR, "search-sources.json");
    const value = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    if (Array.isArray(value)) return value.filter(s => s && typeof s.id === "string" && typeof s.type === "string");
  } catch {}
  return DEFAULT_SOURCES;
}

function searchFailure(error, def) {
  const message = String(error?.message || error).slice(0, 300);
  let code = "unknown", action = "请稍后重试，或选择其他检索源。";
  if (error?.quota) { code = "quota"; action = "该来源的当日配额已用尽；请配置 API 密钥或等待配额恢复，其他来源仍可检索。"; }
  else if (error?.remoteStatus === 429) { code = "rate_limited"; action = "该来源暂时限流；请稍后重试或在检索源设置中配置 API 密钥，其他来源仍可检索。"; }
  else if ([401, 403].includes(error?.remoteStatus)) { code = "auth"; action = "请检查该来源的 API 密钥或 Cookie，也可选择其他公开检索源。"; }
  else if (error?.code === "EUNSUPPORTED") { code = "unsupported"; action = "该来源没有可用检索适配器；请选择 OpenAlex、arXiv、Crossref 或其他支持的来源。"; }
  else if (error?.code === "EINVALIDRESPONSE" || /Atom|无效.*响应|浏览器验证/.test(message)) { code = "invalid_response"; action = "来源可能返回验证或拦截页；镜像需要浏览器验证并配置 Cookie，也可使用其他公开来源。"; }
  else if (error?.code === "EPROXY" || /代理|内部网络/.test(message)) { code = "proxy"; action = "请检查系统代理或 PIPAPER_HTTPS_PROXY；自定义资料来源必须解析到公开地址。"; }
  else if (error?.code === "ETIMEDOUT" || /超时/.test(message)) { code = "timeout"; action = "来源连接超时；请检查代理连接，或暂时切换其他来源。"; }
  else if (/ECONN|ENOTFOUND|EAI_AGAIN|TLS|CERT/.test(error?.code || "")) { code = "network"; action = "请检查网络与系统代理，或暂时切换其他来源。"; }
  return { id: def.id, name: def.name || def.id, type: def.type || def.id, status: "error", count: 0,
    message, code, action, ...(error?.remoteStatus ? { remoteStatus: error.remoteStatus } : {}) };
}

export async function aggregateSearch(q, { sources, yearFrom, yearTo, oa, sort, limit, quartile, projectId, anchorPaperId, signal } = {}, { adapters = ADAPTERS, sourceDefs = readSearchSources() } = {}) {
  const selected = Array.isArray(sources) ? sources : sourceDefs.filter(s => s.enabled && s.type !== "unavailable").map(s => s.id);
  const use = [...new Set(selected.map(id => String(id).trim()).filter(Boolean))].slice(0, 8);
  const opts = { yearFrom: yearFrom && Number(yearFrom), yearTo: yearTo && Number(yearTo), oa: !!oa, sort,
    limit: Math.max(1, Math.min(50, Math.floor(Number(limit) || 15))), signal };
  const sourceStatus = [];
  const settled = await Promise.allSettled(use.map(async (id) => {
    const def = sourceDefs.find((s) => s.id === id) || DEFAULT_SOURCES.find((s) => s.id === id) || { id, type: id };
    const type = def?.type || id;
    const adapter = adapters[type], started = Date.now();
    try {
      signal?.throwIfAborted();
      if (!adapter) throw Object.assign(new Error(`${def.name || id} 暂不支持自动检索`), { code: "EUNSUPPORTED" });
      const items = await adapter(q, opts, def);
      if (!Array.isArray(items)) throw invalidResponse(def.name || id);
      sourceStatus.push({ id, name: def.name || id, type, status: "ok", count: items.length, elapsedMs: Date.now() - started });
      return items;
    } catch (error) {
      sourceStatus.push({ ...searchFailure(error, def), elapsedMs: Date.now() - started });
      throw error;
    }
  }));
  signal?.throwIfAborted();
  sourceStatus.sort((a, b) => use.indexOf(a.id) - use.indexOf(b.id));
  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(...s.value);
    else errors.push(`${use[i]}: ${String(s.reason?.message || s.reason).slice(0, 100)}`);
  });
  let merged = dedupe(results).map(enrich);
  if (opts.yearFrom) merged = merged.filter(r => Number(r.year) >= opts.yearFrom);
  if (opts.yearTo) merged = merged.filter(r => r.year != null && Number(r.year) <= opts.yearTo);
  if (opts.oa) merged = merged.filter(r => r.oa);
  // quartile 区间过滤：Q1=仅Q1，Q2=Q1–Q2 …，Q4=有分区（排除 arXiv/未知分区来源）
  if (quartile) {
    const rank = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
    const max = rank[quartile];
    if (max) merged = merged.filter((r) => r.quartile && (rank[r.quartile] || 9) <= max);
  }
  // ReadScore 评分 + 默认综合推荐排序（recommended/local 在 rankResults 内排序）
  merged = rankResults(merged, q, { projectId, anchorPaperId, sort });
  if (sort === "citations") merged.sort((a, b) => (b.citations || 0) - (a.citations || 0));
  else if (sort === "year") merged.sort((a, b) => (b.year || 0) - (a.year || 0));
  else if (sort === "if") merged.sort((a, b) => (b.sjr ?? -1) - (a.sjr ?? -1)); // 无分区/IF 的自然排到最后
  const successes = sourceStatus.filter(s => s.status === "ok").length;
  const status = !use.length ? "no_sources" : !errors.length ? "ok" : successes ? "partial" : "error";
  return { results: merged.slice(0, 60), total: merged.length, errors, sourcesUsed: use, sourceStatus, status };
}

// quality tier heuristic (open data only — no JCR): citations drive the tier
export function tierOf(r) {
  const c = r.citations || 0;
  if (c >= 400) return { label: "领域经典", color: "#e5c07b" };
  if (c >= 100) return { label: "高被引", color: "#4cc38a" };
  if (c >= 10) return { label: "有影响力", color: "#7c9cff" };
  return { label: "新文献", color: "#767e99" };
}
