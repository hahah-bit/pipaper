import { DOMParser } from "@xmldom/xmldom";
import { safeURL } from "./transport.js";
import { fault } from "../errors.js";

export function normalizeDoi(doi) {
  return String(doi || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
}
export function openalexAbstract(inv, limit = Infinity) {
  const positions = [];
  for (const [word, indexes] of Object.entries(inv || {})) for (const index of indexes)
    if (Number.isInteger(index) && index >= 0 && index < 18000) positions[index] = word;
  return positions.filter(Boolean).join(" ").slice(0, limit);
}

export function normalizeWork(w) {
  const locations = w.locations || [w.primary_location].filter(Boolean);
  const published = locations.find(l => l.source && ["journal", "conference"].includes(l.source.type) && (l.version === "publishedVersion" || l.is_published)) || w.primary_location;
  const source = published?.source;
  return { id: w.id, title: w.title || w.display_name, date: w.publication_date, year: w.publication_year,
    citations: w.cited_by_count ?? 0, doi: w.doi || null, url: w.doi || w.id,
    pdf: safeURL(w.best_oa_location?.pdf_url) || null, landing: safeURL(w.best_oa_location?.landing_page_url),
    abstract: openalexAbstract(w.abstract_inverted_index), keywords: (w.keywords || []).map(k => k.display_name),
    topics: (w.topics || []).map(t => ({ id: t.id, name: t.display_name })), references: w.referenced_works || [],
    venue: source ? { id: source.id, name: source.display_name, type: source.type, issns: source.issn || [] } : null,
    publicationUrls: [...new Set(locations.flatMap(l => [safeURL(l.landing_page_url), safeURL(l.pdf_url)]).filter(Boolean))],
    bibliographic: { volume: w.biblio?.volume, issue: w.biblio?.issue, firstPage: w.biblio?.first_page, lastPage: w.biblio?.last_page },
    source: "OpenAlex", type: w.type, paperOpenAccess: w.open_access?.is_oa === true };
}
export function parseArxivFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.documentElement?.localName !== "feed" || doc.documentElement?.namespaceURI !== "http://www.w3.org/2005/Atom")
    throw fault("arXiv 未返回有效 Atom 检索结果，不能视为零篇", 502);
  const value = (entry, tag) => entry.getElementsByTagName(tag)[0]?.textContent?.trim() || "";
  const entries = Array.from(doc.getElementsByTagName("entry"));
  const errorEntry = entries.find(e => /arxiv\.org\/api\/errors/.test(value(e, "id")));
  if (errorEntry) throw fault(`arXiv 查询失败：${value(errorEntry, "summary").slice(0, 300)}`, 502);
  return entries.map(entry => {
    const id = value(entry, "id").replace(/^http:/, "https:"), doi = normalizeDoi(value(entry, "arxiv:doi"));
    const pdfLink = Array.from(entry.getElementsByTagName("link")).find(link => link.getAttribute("title") === "pdf")?.getAttribute("href");
    return { id, source: "arXiv", title: value(entry, "title").replace(/\s+/g, " "), abstract: value(entry, "summary"),
      date: value(entry, "published").slice(0, 10), year: Number(value(entry, "published").slice(0, 4)),
      authors: Array.from(entry.getElementsByTagName("author")).map(author => value(author, "name")),
      url: id, pdf: safeURL(pdfLink?.replace(/^http:/, "https:")) || id.replace("/abs/", "/pdf/"),
      citations: null, doi: doi ? "https://doi.org/" + doi : null,
      keywords: Array.from(entry.getElementsByTagName("category")).map(c => c.getAttribute("term")),
      references: [], venue: null, paperOpenAccess: true };
  }).filter(p => /arxiv\.org\/abs\//.test(p.id));
}
