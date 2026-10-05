import { safeURL } from "./sources.js";
const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function samePaper(p, doc) {
  const title = doc?.metadata?.citation_title || doc?.metadata?.["dc.title"];
  return !!doc && !doc.json && (title ? norm(title) === norm(p.title) : norm(doc.pages?.[0]?.text || doc.text?.slice(0, 7000)).includes(norm(p.title)));
}
export function hasFullText(doc) {
  return !!doc && !doc.json && (doc.pages?.length > 0 || (doc.text?.length > 12000 && /method|experiment|evaluation|conclusion/i.test(doc.text)));
}
export function ownCode(paper, url, doc) {
  if (/^\s*#?[^\n]*\n+\s*(?:Coming soon|Code coming soon|To be released)\b/i.test(doc.text)) return false;
  const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  const codeName = norm(slug);
  return norm(doc.text).includes(norm(paper.title)) || (codeName.length >= 6 && norm(paper.title).includes(codeName));
}
export async function readPaper(p, { sources, getDoc, save, signal }) {
  if (p.documentUrl) { const saved = await getDoc(p.documentUrl, `已核对全文 · ${p.title}`); if (samePaper(p, saved) && hasFullText(saved)) return saved; }
  const urls = [...new Set([p.pdf, ...(p.publicationUrls || []), p.landing, p.url].filter(safeURL))];
  const arxiv = urls.find(u => /arxiv.org\/(abs|pdf)\//.test(u));
  const candidates = [...(arxiv ? [arxiv.replace(/\/(abs|pdf)\//, "/html/").replace(/\.pdf$/, "")] : []), ...urls.filter(u => /\.pdf(?:$|\?)/.test(u)), ...urls.filter(u => !/doi.org/.test(u)), p.url].filter(safeURL);
  for (const url of [...new Set(candidates)].slice(0, 5)) {
    const doc = await getDoc(url, `Baseline 原文 · ${p.title}`);
    if (samePaper(p, doc) && hasFullText(doc)) { p.documentUrl = doc.url; return doc; }
    if (samePaper(p, doc)) for (const fullURL of (doc.links || []).filter(u => /\.pdf(?:[?#]|$)|\/bitstreams\/[^/]+\/download/.test(u)).slice(0, 3)) {
      const full = await getDoc(fullURL, `开放全文 · ${p.title}`);
      if (samePaper(p, full) && hasFullText(full)) { p.documentUrl = full.url; p.pdf = full.url; return full; }
    }
  }
  // Publisher metadata may omit OA copies. Search the exact title, then verify
  // identity again; never associate an arbitrary search hit with this baseline.
  if (sources.arxiv) {
    try {
      const r = await sources.arxiv(`"${p.title.replace(/["()]/g, " ")}"`, signal);
      save("search", `查找开放全文 · ${p.title}`, { query: p.title, ...r });
      const match = r.papers.find(q => norm(q.title) === norm(p.title));
      if (match) for (const url of [match.url.replace("/abs/", "/html/"), match.pdf]) {
        const doc = await getDoc(url, `开放全文 · ${p.title}`);
        if (samePaper(p, doc) && hasFullText(doc)) { p.aliases = [...new Set([...(p.aliases || []), match.id])]; p.pdf = match.pdf; p.documentUrl = doc.url; return doc; }
      }
    } catch { signal?.throwIfAborted(); }
  }
  return null;
}
export function evidenceText(doc, max = 10000) {
  const text = doc.text || "", windows = [];
  const patterns = [/licen[sc]e|publicly available|data availability|open.source|released.{0,70}data/gi, /\b(?:GPU|GB|NVIDIA|A100|V100|A6000|RTX|CPU|OpenAI API|API calls|GPT-4|GPT-3.5)\b/gi, /dataset|benchmark|training time|runtime|inference|hours/gi];
  for (const pattern of patterns) {
    let count = 0;
    for (const m of text.matchAll(pattern)) {
      if (++count > 12) break;
      const start = Math.max(0, m.index - 220), end = Math.min(text.length, m.index + 620);
      if (!windows.some(w => start >= w.start && end <= w.end)) windows.push({ start, end });
    }
  }
  return windows.map(w => text.slice(w.start, w.end)).join("\n[…]\n").slice(0, max) || text.slice(0, 2000);
}
export function evidenceOptions(documents) {
  const options = [];
  for (const doc of documents.filter(d => d.paperIds?.length && !d.json)) {
    for (const [kind, re] of [["dataset", /(?:publicly available|data availability|release.{0,35}data|provide.{0,40}datasets?|datasets?.{0,70}available|data.{0,100}licen[sc])/gi], ["hardware", /(?:API[ _-]?key|OPENAI_API_KEY|test_gpt\.py|(?:use|using|evaluate|run|via).{0,70}\bAPI\b|\bCPU\b|\bIntel\b|\bNVIDIA\b)/gi]]) {
      let count = 0;
      for (const m of doc.text.matchAll(re)) {
        const start = Math.max(0, m.index - 75), end = Math.min(doc.text.length, m.index + 350);
        options.push({ id: `evidence-${options.length + 1}`, kind, url: doc.url, paperIds: doc.paperIds, quote: doc.text.slice(start, end) });
        if (++count >= 3) break;
      }
    }
  }
  return options;
}
export function bindEvidence(value, options) {
  const byId = new Map(options.map(e => [e.id, e]));
  for (const d of value.directions || []) {
    // Models sometimes put a supplied excerpt ID in the bibliography field.
    // Resolve only the explicit excerpt→paper relation; unknown IDs stay invalid.
    if (Array.isArray(d.evidenceIds)) d.evidenceIds = [...new Set(d.evidenceIds.flatMap(id => byId.get(id)?.paperIds?.length ? byId.get(id).paperIds : [id]))];
    for (const kind of ["dataset", "hardware"]) {
      const claim = d[kind]; if (!claim) continue;
      const candidate = options.find(e => e.id === claim.evidenceId && e.kind === kind && (!claim.url || claim.url === e.url));
      if (candidate) { d[kind].url = candidate.url; d[kind].quote = candidate.quote; }
    }
  }
  return value;
}
