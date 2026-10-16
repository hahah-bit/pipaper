import { scheduleArxiv } from "../platform/academic/arxiv-rate.js";
import { normalizeWork, parseArxivFeed } from "../platform/academic/metadata.js";
import { getConfig } from "../config.js";
import { fault } from "./store.js";
import { createResilientRequest } from "../platform/academic/network.js";
import { remote, safeURL, privateAddress } from "../platform/academic/transport.js";
export { remote, safeURL, privateAddress } from "../platform/academic/transport.js";

export function years(now = new Date()) {
  const y = now.getUTCFullYear(); const cutoff = new Date(now); cutoff.setUTCFullYear(y - 3);
  return { complete: [y - 3, y - 2, y - 1], partial: y, from: `${y - 3}-01-01`, to: now.toISOString().slice(0, 10), baselineFrom: cutoff.toISOString().slice(0, 10) };
}
export { normalizeWork } from "../platform/academic/metadata.js";
export function arxivExpression(query) {
  const tokens = String(query).match(/"[^"]+"|\(|\)|\bANDNOT\b|\bAND\b|\bOR\b|[^\s()]+/g) || [];
  const out = []; let operand = false;
  for (const token of tokens) {
    if (["AND", "OR", "ANDNOT"].includes(token)) { out.push(token); operand = false; }
    else if (token === ")") { out.push(token); operand = true; }
    else { if (operand) out.push("AND"); out.push(token === "(" ? token : `all:${token}`); operand = token !== "("; }
  }
  return out.join(" ");
}
export function createSources({ request = remote, now = () => new Date() } = {}) {
  request = createResilientRequest(request);
  let openalexBlockedUntil = 0, openalexQuotaError;
  const openalex = async (endpoint, params, signal) => {
    if (openalexBlockedUntil > Date.now()) throw openalexQuotaError;
    const u = new URL(`https://api.openalex.org/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, String(v));
    const sourceUrl = u.href;
    const key = process.env.OPENALEX_API_KEY || getConfig().topicAnalysis?.openalexApiKey;
    if (key) u.searchParams.set("api_key", key);
    let r;
    try { r = await request(u.href, { signal }); }
    catch (e) {
      if (e.remoteStatus === 429 && (e.quota || e.retryAfter > 60)) { openalexBlockedUntil = Date.now() + Math.max(60, e.retryAfter || 3600) * 1000; openalexQuotaError = e; throw e; }
      if (!/429/.test(e.message)) throw e;
      await delay(Math.min(30, Math.max(3, e.retryAfter || 3)) * 1000, null, { signal }); r = await request(u.href, { signal });
    }
    let data; try { data = JSON.parse(r.buffer.toString("utf8")); } catch { throw fault("OpenAlex 返回非 JSON 响应，可能是服务拦截页", 502); }
    if (data.error || (endpoint === "works" && !Array.isArray(data.results) && !Array.isArray(data.group_by))) throw fault("OpenAlex 返回无效数据结构，不能视为零篇", 502);
    return { ...data, sourceUrl, retrievedAt: now().toISOString() };
  };
  const works = async (query, { signal, sort = "publication_date:desc", filter = "", limit = 100 } = {}) => {
    const period = years(now());
    const r = await openalex("works", { search: query, filter: [`from_publication_date:${period.from}`, `to_publication_date:${period.to}`, filter].filter(Boolean).join(","), sort, per_page: limit }, signal);
    return { papers: (r.results || []).map(normalizeWork), total: r.meta?.count ?? null, sourceUrl: r.sourceUrl, retrievedAt: r.retrievedAt };
  };
  const groups = (query, group, filter, signal) => openalex("works", { search: query, group_by: group, per_page: 200, filter: [`from_publication_date:${years(now()).from}`, `to_publication_date:${years(now()).to}`, filter].filter(Boolean).join(",") }, signal);
  async function arxiv(query, signal) {
    // The public API asks clients to leave at least three seconds between requests.
    const job = scheduleArxiv(async () => {
      const u = new URL("https://export.arxiv.org/api/query");
      u.searchParams.set("search_query", `(${arxivExpression(query)}) AND submittedDate:[${years(now()).baselineFrom.replaceAll("-", "")}0000 TO ${years(now()).to.replaceAll("-", "")}2359]`);
      u.searchParams.set("sortBy", "submittedDate"); u.searchParams.set("sortOrder", "descending"); u.searchParams.set("max_results", "25");
      // arXiv's gateway rejects some form-encoded phrase/date expressions (406).
      // Use URI-encoded spaces, preserving literal '+' as URLSearchParams' %2B.
      const sourceUrl = u.href.replaceAll("+", "%20");
      const r = await request(sourceUrl, { signal });
      const papers = parseArxivFeed(r.buffer.toString("utf8"));
      return { papers, sourceUrl, retrievedAt: now().toISOString() };
    }, signal); return job;
  }
  const crossref = async (query, { signal, limit = 40, doi } = {}) => {
    const u = new URL(doi ? `https://api.crossref.org/works/${encodeURIComponent(doi.replace(/^https?:\/\/(?:dx\.)?doi.org\//, ""))}` : "https://api.crossref.org/works");
    if (!doi) { u.searchParams.set("query.bibliographic", query.replace(/\b(?:AND|OR)\b|["()]/g, " ")); u.searchParams.set("filter", `from-pub-date:${years(now()).baselineFrom},until-pub-date:${years(now()).to}`); u.searchParams.set("rows", String(limit)); }
    const r = await request(u.href, { signal }); let data;
    try { data = JSON.parse(r.buffer.toString("utf8")); } catch { throw fault("Crossref 返回非 JSON 响应", 502); }
    if (data.status !== "ok" || !data.message || (!doi && !Array.isArray(data.message.items))) throw fault("Crossref 响应无效", 502);
    return { papers: (doi ? [data.message] : data.message.items).map(normalizeCrossref), total: data.message["total-results"] ?? (doi ? 1 : null), sourceUrl: u.href, retrievedAt: now().toISOString() };
  };
  return { request, works, groups, arxiv, crossref, searchSources: (name, signal) => openalex("sources", { search: name, per_page: 5 }, signal), resolve: async (doi, signal) => {
    const r = await openalex(`works/${encodeURIComponent(doi)}`, {}, signal); return normalizeWork(r);
  }, citations: (id, signal) => {
    const key = String(id).split("/").pop(); if (!/^W\d+$/.test(key)) throw fault("无效的论文 ID");
    return works("", { filter: `cites:${key}`, signal, limit: 20 });
  }, source: (id, signal) => {
    const key = String(id).split("/").pop(); if (!/^S\d+$/.test(key)) throw fault("无效的期刊来源 ID"); return openalex(`sources/${key}`, {}, signal);
  }, document: (url, signal) => documentSource(url, signal, request) };
}
export function normalizeCrossref(w) {
  const parts = (w["published-online"] || w["published-print"] || w.published || w.issued)?.["date-parts"]?.[0] || [];
  const date = parts.length === 3 ? parts.map((n, i) => i ? String(n).padStart(2, "0") : n).join("-") : null;
  const urls = [w.resource?.primary?.URL, w.URL, ...(w.link || []).map(l => l.URL)].map(safeURL).filter(Boolean);
  const [firstPage, lastPage] = String(w.page || "").split("-");
  return { id: `https://doi.org/${w.DOI}`, doi: `https://doi.org/${w.DOI}`, title: htmlText(w.title?.[0] || ""), date, year: parts[0], citations: w["is-referenced-by-count"] ?? 0,
    abstract: htmlText(w.abstract || ""), source: "Crossref", type: w.type === "proceedings-article" ? "proceedings-article" : w.type === "journal-article" ? "article" : w.type,
    url: `https://doi.org/${w.DOI}`, landing: safeURL(w.resource?.primary?.URL) || urls[0], pdf: (w.link || []).find(l => l["content-type"] === "application/pdf")?.URL || null,
    venue: { id: null, name: w["container-title"]?.[0] || w.event?.name || "", type: w.type === "proceedings-article" ? "conference" : "journal", issns: w.ISSN || [] },
    publicationUrls: urls, bibliographic: { volume: w.volume, issue: w.issue, firstPage, lastPage }, keywords: w.subject || [], references: (w.reference || []).filter(r => r.DOI).map(r => `https://doi.org/${r.DOI.toLowerCase()}`), paperOpenAccess: null, metadataUrl: `https://api.crossref.org/works/${encodeURIComponent(w.DOI)}` };
}
export function htmlText(html) {
  return html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
export async function documentSource(url, signal, request = remote) {
  const repo = safeURL(url) && new URL(url).hostname === "github.com" && new URL(url).pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (repo) {
    const base = `https://api.github.com/repos/${encodeURIComponent(repo[1])}/${encodeURIComponent(repo[2])}`;
    const response = await request(`${base}/readme`, { signal });
    const readme = JSON.parse(response.buffer.toString("utf8"));
    if (readme.encoding !== "base64" || !readme.content) throw fault("代码仓库未提供可读取的 README", 502);
    let body = Buffer.from(readme.content, "base64").toString("utf8"), licenseUrl = null;
    try { const r = await request(`${base}/license`, { signal }); const license = JSON.parse(r.buffer.toString("utf8"));
      if (license.content) { body += `\n\n[Repository license: ${license.license?.spdx_id || "unspecified"}]\n${Buffer.from(license.content, "base64").toString("utf8")}`; licenseUrl = license.html_url; }
    } catch { signal?.throwIfAborted(); }
    const links = [...(body.match(/https:\/\/[^\s<>"')\]]+/g) || [])].filter(safeURL);
    for (const m of body.matchAll(/\]\(([^\s)]+)\)/g)) if (!/^https?:|^#/.test(m[1])) { try { links.push(new URL(m[1], readme.html_url.replace(/[^/]+$/, "")).href); } catch {} }
    return { url, apiUrl: `${base}/readme`, licenseUrl, retrievedAt: new Date().toISOString(), text: body.slice(0, 200000), links: [...new Set(links)], pages: [], linkedPages: [], metadata: {},
      downloadUrl: `https://api.github.com/repos/${encodeURIComponent(repo[1])}/${encodeURIComponent(repo[2])}/zipball` };
  }
  if (/\.(zip|tar|gz|7z|npy|npz|pt|pth)(?:[?#]|$)/i.test(url)) {
    const head = await request(url, { signal, method: "HEAD", maxBytes: 2000 });
    return { url: head.url || url, retrievedAt: new Date().toISOString(), headOnly: true, text: "仅验证下载入口可达，未下载数据文件；此状态不等于已确认数据许可。", pages: [], links: [], linkedPages: [] };
  }
  const r = await request(url, { signal }); let text = "", pages = [], links = [], linkedPages = [], metadata = {}, json;
  if (r.contentType.includes("json")) {
    json = JSON.parse(r.buffer.toString("utf8")); text = JSON.stringify(json);
  } else if (r.contentType.includes("pdf") || r.buffer.subarray(0, 5).toString() === "%PDF-") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: new Uint8Array(r.buffer), isEvalSupported: false, useSystemFonts: true });
    const pdf = await loading.promise;
    try { for (let i = 1; i <= Math.min(pdf.numPages, 600); i++) {
      signal?.throwIfAborted(); const page = await pdf.getPage(i), content = await page.getTextContent();
      const body = content.items.map(c => c.str || "").join(" "); pages.push({ page: i, text: body });
      for (const a of await page.getAnnotations()) if (safeURL(a.url)) links.push(a.url);
    } } finally { await pdf.destroy(); }
    text = pages.map(p => `[第${p.page}页] ${p.text}`).join("\n");
  } else {
    const html = r.buffer.toString("utf8"); text = htmlText(html);
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(m => [m[1].toLowerCase(), htmlText(m[3])]));
      const key = attrs.name || attrs.property; if (key && attrs.content && /^(citation_|dc\.|prism:|og:)/i.test(key)) metadata[key.toLowerCase()] = attrs.content;
    }
    for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) { try { const link = new URL(match[1], r.url || url).href; if (safeURL(link)) links.push(link); } catch {} }
    for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      try { const link = new URL(match[1], r.url || url).href; if (safeURL(link)) linkedPages.push({ url: link, title: htmlText(match[2]).slice(0, 250) }); } catch {}
    }
  }
  links.push(...(text.match(/https:\/\/[^\s<>"')]+/g) || []));
  return { url: r.url || url, retrievedAt: new Date().toISOString(), text: text.slice(0, 1600000), pages, linkedPages, metadata, ...(json ? { json } : {}),
    links: [...new Set(links)].filter(safeURL).slice(0, 1500), truncated: text.length > 1600000 };
}
export const POLICY_SEEDS = [
  { kind: "plan", title: "十五五规划纲要（2026—2030）", years: [2026, 2030], url: "https://www.ndrc.gov.cn/fggz/fzzlgh/gjfzgh/202603/U020260317369114704096.pdf" },
  { kind: "nsfc", title: "2026 年度国家自然科学基金项目指南（上册）", year: 2026, url: "https://www.nsfc.gov.cn/u/cms/www/202601/190844586k0w.pdf" },
  { kind: "nsfc", title: "2025 年度国家自然科学基金项目指南（上册）", year: 2025, url: "https://www.nsfc.gov.cn/u/cms/www/202503/06075624ajrr.pdf" },
  { kind: "nsfc", title: "未来工业互联网重大研究计划 2026 年度指南", year: 2026, terms: ["制造", "工业", "生产"], url: "https://www.nsfc.gov.cn/p1/3381/2824/141042.html" },
  { kind: "nsfc", title: "未来工业互联网重大研究计划 2025 年度指南", year: 2025, terms: ["制造", "工业", "生产"], url: "https://www.nsfc.gov.cn/p1/3381/2824/94394.html" },
  { kind: "nsfc", title: "可解释、可通用的下一代人工智能方法 2025 年度指南", year: 2025, terms: ["智能", "Agent", "AI", "数据"], url: "https://www.nsfc.gov.cn/p1/3381/2824/66768.html" },
  { kind: "nsfc", title: "人机物融合的智能化软件基础研究 2026 年度指南", year: 2026, terms: ["软件", "Agent", "平台", "系统"], url: "https://www.nsfc.gov.cn/p1/3381/2824/100403.html" },
];
export function relevantText(doc, terms, max = 14000) {
  const units = doc.pages?.length ? doc.pages.map(p => `[第${p.page}页] ${p.text}`) : doc.text.match(/.{1,1600}/gs) || [];
  return units.map((text, i) => ({ text, i, score: terms.reduce((n, q) => n + (q && text.toLowerCase().includes(q.toLowerCase()) ? 1 : 0), 0) })).filter(x => x.score).sort((a, b) => b.score - a.score).map(x => x.text).join("\n").slice(0, max);
}
export function mergePapers(rows) {
  const found = new Map(), aliases = new Map();
  for (const p of rows) {
    const norm = x => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const keys = [p.doi && `doi:${norm(p.doi.replace(/^https?:\/\/(?:dx\.)?doi.org\//, ""))}`, p.title && `title:${norm(p.title)}`, `id:${p.id}`].filter(Boolean);
    const doiKey = x => norm(String(x || "").replace(/^https?:\/\/(?:dx\.)?doi.org\//, ""));
    const key = keys.map(k => aliases.get(k)).find(k => k && !(p.doi && found.get(k)?.doi && doiKey(p.doi) !== doiKey(found.get(k).doi))) || keys[0], old = found.get(key);
    if (old) {
      old.pdf ||= p.pdf; old.abstract ||= p.abstract; old.doi ||= p.doi;
      if ((!old.venue || !["journal", "conference"].includes(old.venue.type)) && p.venue) old.venue = p.venue;
      if (p.quality?.eligible && !old.quality?.eligible) { old.quality = p.quality; old.date = p.date; old.venue = p.venue; }
      old.aliases = [...new Set([...(old.aliases || []), p.id, ...(p.aliases || [])])]; old.queries = [...new Set([...(old.queries || []), ...(p.queries || [])])];
      old.publicationUrls = [...new Set([...(old.publicationUrls || []), ...(p.publicationUrls || [])])];
      old.references = [...new Set([...(old.references || []), ...(p.references || [])])];
      if (p.code?.length) old.code = [...new Map([...(old.code || []), ...p.code].map(c => [c.url, c])).values()];
    } else found.set(key, { ...p });
    for (const k of keys) aliases.set(k, key);
  } return [...found.values()];
}
