import fs from "node:fs";
import { safeURL } from "./sources.js";

export const CCF = JSON.parse(fs.readFileSync(new URL("./ccf-2026.json", import.meta.url), "utf8"));
export const BASELINE_POLICY = { journal: "CAS-1", conference: "CCF-A", edition: CCF.edition, label: "中科院大类 1 区 / CCF A 类正式长文", source: CCF.url };
const normalized = x => String(x || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const excluded = /workshop|findings|short papers?|demonstration|doctoral|student abstract|extended abstract|technical brief|companion|\bposter abstract\b/i;
const crossrefConferences = {
  icde: /^(?:20\d\d )?IEEE \d+(?:st|nd|rd|th) International Conference on Data Engineering \(ICDE\)$/i,
  kdd: /^Proceedings of the \d+(?:st|nd|rd|th) ACM SIGKDD Conference on Knowledge Discovery and Data Mining$/i,
};
export function conferenceLocator(p) {
  if (excluded.test(p.venue?.name || "")) return null;
  const urls = [...new Set([...(p.publicationUrls || []), p.landing, p.url, p.pdf].filter(safeURL))];
  const aclDOI = p.doi?.match(/10\.18653\/v1\/(20\d\d\.acl-long\.\d+)$/i); if (aclDOI) urls.unshift(`https://aclanthology.org/${aclDOI[1]}/`);
  for (const url of urls) {
    const u = new URL(url), h = u.hostname, path = u.pathname;
    if (h === "aclanthology.org" && /^\/20\d\d\.acl-long\.\d+\/?(?:\.pdf)?$/.test(path)) return { key: "acl", url: url.replace(/\.pdf$/, "/"), track: "ACL Long Papers", formal: true };
    if (h === "openaccess.thecvf.com" && /^\/content\/(CVPR|ICCV)20\d\d\/html\//.test(path)) return { key: path.match(/\/(CVPR|ICCV)/)[1].toLowerCase(), url, formal: true, track: "Main Conference" };
    if (["proceedings.neurips.cc", "papers.nips.cc"].includes(h) && /\/paper(?:_files)?\/paper\/20\d\d\/(?:hash|file)\//.test(path) && !/Workshop/i.test(path)) return { key: "nips", url: url.replace("/file/", "/hash/").replace(/-Paper(?:-Conference)?\.pdf$/, "-Abstract-Conference.html"), formal: true, track: "NeurIPS Proceedings" };
    if (h === "proceedings.mlr.press" && /\/v\d+\/[^/]+\.html$/.test(path)) return { key: "icml", url, formal: false };
    if (h === "proceedings.mlr.press" && /^(\/v\d+\/)([^/]+)\/[^/]+\.pdf$/.test(path)) { const m = path.match(/^(\/v\d+\/)([^/]+)/); return { key: "icml", url: `https://${h}${m[1]}${m[2]}.html`, formal: false }; }
    if (h === "openaccess.thecvf.com" && /^\/content\/(CVPR|ICCV)20\d\d\/papers\//.test(path)) return { key: path.match(/\/(CVPR|ICCV)/)[1].toLowerCase(), url: url.replace("/papers/", "/html/").replace(/\.pdf$/, ".html"), formal: true, track: "Main Conference" };
    if (["openreview.net", "api2.openreview.net"].includes(h) && u.searchParams.get("id")) return { key: "iclr", url: `https://api2.openreview.net/notes?id=${encodeURIComponent(u.searchParams.get("id"))}`, formal: false, openreview: true };
    if (h === "ojs.aaai.org" && /^\/index.php\/AAAI\/article\/view\/\d+/.test(path)) return { key: "aaai", url: url.replace(/(\/view\/\d+).*/, "$1"), formal: false };
  }
  if (p.doi && /proceedings of the vldb endowment/i.test(p.venue?.name || "")) return { key: "vldb", url: `https://api.crossref.org/works/${encodeURIComponent(p.doi.replace(/^https?:\/\/(?:dx\.)?doi.org\//, ""))}`, crossref: true };
  if (p.doi && /proceedings of the acm on management of data/i.test(p.venue?.name || "")) return { key: "sigmod", url: `https://api.crossref.org/works/${encodeURIComponent(p.doi.replace(/^https?:\/\/(?:dx\.)?doi.org\//, ""))}`, crossref: true };
  for (const [key, pattern] of Object.entries(crossrefConferences)) if (p.doi && pattern.test(p.venue?.name || "")) return { key, url: `https://api.crossref.org/works/${encodeURIComponent(p.doi.replace(/^https?:\/\/(?:dx\.)?doi.org\//, ""))}`, crossref: true };
  if (p.doi && /10\.1609\/aaai\./i.test(p.doi)) return { key: "aaai", url: p.doi, resolving: true };
  return null;
}
export function qualityCandidate(p) { return !!conferenceLocator(p) || p.venue?.type === "journal"; }
function result(key, url, track, doc) {
  const entry = CCF.entries.find(e => e.key === key); if (!entry) return null;
  return { eligible: true, system: "CCF", rank: "A", year: CCF.edition, venue: entry.acronym, track, publicationUrl: url,
    sourceUrl: CCF.url, page: entry.page, quote: entry.row, retrievedAt: doc.retrievedAt };
}
export function verifyConference(p, locator, doc) {
  if (!locator || !doc) return null;
  if (locator.resolving) {
    const official = conferenceLocator({ ...p, doi: null, publicationUrls: [doc.url], url: null, landing: null, pdf: null });
    return official && !official.resolving ? verifyConference(p, official, doc) : null;
  }
  let title = doc.metadata?.citation_title || doc.metadata?.["dc.title"] || "", text = doc.text || "";
  if (locator.crossref) {
    try {
      const w = (doc.json || JSON.parse(text)).message, container = w["container-title"]?.[0] || "";
      if (normalized(w.title?.[0]) !== normalized(p.title) || excluded.test(w.title?.[0] || "")) return null;
      const pages = String(w.page || "").match(/^(\d+)-(\d+)$/), long = pages && Number(pages[2]) - Number(pages[1]) >= 7;
      if (locator.key === "vldb" && (!/proceedings of the vldb endowment/i.test(container) || !long)) return null;
      // PACMMOD research articles use numbered articles and may omit page spans.
      // Without a full-length record they stay unverified, rather than assuming.
      if (locator.key === "sigmod" && (!/proceedings of the acm on management of data/i.test(container) || !long)) return null;
      if (crossrefConferences[locator.key] && (w.type !== "proceedings-article" || !crossrefConferences[locator.key].test(container) || !long)) return null;
      return result(locator.key, `https://doi.org/${w.DOI}`, "Research article · Crossref 页码与会议论文集核验", doc);
    } catch { return null; }
  }
  if (locator.openreview) {
    try {
      const note = (doc.json || JSON.parse(text)).notes?.[0], content = note?.content, value = key => typeof content?.[key] === "object" ? content[key].value : content?.[key];
      title = value("title");
      if (!/^ICLR\.cc\/20\d\d\/Conference$/.test(value("venueid") || "") || !/ICLR.*(?:poster|oral|spotlight)/i.test(value("venue") || "")) return null;
      if (normalized(title) !== normalized(p.title)) return null;
      return result("iclr", `https://openreview.net/forum?id=${encodeURIComponent(note.id)}`, value("venue"), doc);
    } catch { return null; }
  }
  if (title ? normalized(title) !== normalized(p.title) : !normalized(text.slice(0, 16000)).includes(normalized(p.title))) return null;
  if (locator.key === "icml" && !/Proceedings of the \d+(?:st|nd|rd|th) International Conference on Machine Learning/i.test(text)) return null;
  if (locator.key === "aaai") {
    // A journal-like AAAI landing page also hosts abstracts and non-research tracks.
    const section = text.match(/Section\s+(.{0,180}?)(?:License|Copyright|How to Cite|$)/i)?.[1] || "";
    const first = Number(doc.metadata?.citation_firstpage), last = Number(doc.metadata?.citation_lastpage);
    if (!section || excluded.test(section) || !/technical|research|main track/i.test(section) || !first || last - first < 5) return null;
  }
  return result(locator.key, locator.url, locator.track || (locator.key === "icml" ? "ICML Proceedings" : "AAAI Technical Track"), doc);
}
export function verifyCAS(p, docs) {
  for (const d of docs) {
    if (!safeURL(d.url) || !/(^|\.)fenqubiao\.com$/.test(new URL(d.url).hostname) || d.venueId !== p.venue?.id || !d.venueId) continue;
    // Require an unambiguous single-journal official record, including ISSN and
    // explicit major-category rank. CCF journals and SJR/JCR are never CAS proxies.
    const issns = [...new Set((d.text.match(/\b\d{4}-\d{3}[\dX]\b/gi) || []).map(s => s.toUpperCase()))];
    if (!issns.length || !issns.every(s => p.venue.issns?.includes(s)) || !normalized(d.text).includes(normalized(p.venue.name))) continue;
    const year = d.text.match(/(20\d{2})\s*年.*?分区/), zone = d.text.match(/大类[\s\S]{0,60}?(?:1|一)\s*区/);
    if (!year || !zone || Number(year[1]) < new Date().getUTCFullYear() - 1) continue;
    return { eligible: true, system: "CAS", rank: 1, year: Number(year[1]), venue: p.venue.name, sourceUrl: d.url, publicationUrl: p.doi || p.url, quote: zone[0], retrievedAt: d.retrievedAt };
  }
  return null;
}
export async function qualifyPapers(papers, { getDoc, documents = [], signal, limit = 60 } = {}) {
  let checked = 0;
  for (const p of papers) {
    signal?.throwIfAborted();
    if (p.quality?.eligible) continue;
    p.quality = { eligible: false, reason: "发表来源或中科院1区/CCF A正式长文证据尚未核实" };
    const cas = verifyCAS(p, documents); if (cas && p.type !== "preprint") { p.quality = cas; continue; }
    const locator = conferenceLocator(p); if (!locator || checked >= limit) continue;
    checked++;
    const doc = await getDoc(locator.url, `发表来源核验 · ${p.title}`);
    const verified = verifyConference(p, locator, doc);
    if (verified) {
      p.quality = verified; p.publicationDocumentUrl = doc.url;
      doc.paperIds = [...new Set([...(doc.paperIds || []), p.id])];
      if (!p.abstract && doc.text) p.abstract = doc.text.match(/Abstract\s+([\s\S]{100,4000}?)(?:\s(?:Cite this|BibTeX|Download|Volume|Anthology ID)|$)/i)?.[1] || "";
      if (!p.pdf) p.pdf = doc.metadata?.citation_pdf_url || doc.links?.find(l => /\.pdf(?:$|\?)/.test(l));
    }
  }
  return papers;
}
