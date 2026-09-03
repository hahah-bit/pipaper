import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, LIBRARY_DIR, PARSED_DIR, TMP_DIR } from "./config.js";

const PAPERS_FILE = path.join(DATA_DIR, "papers.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions-index.json");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

let papers = { papers: [], zoteroSyncedAt: null, collections: [] };
let sessionIndex = {};
let projects = [];
let saveTimer = null;

function load() {
  try {
    papers = { ...papers, ...JSON.parse(fs.readFileSync(PAPERS_FILE, "utf8")) };
  } catch {}
  try {
    sessionIndex = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {}
  try {
    projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  } catch {}
}
load();

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(PAPERS_FILE, JSON.stringify(papers, null, 2));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionIndex, null, 2));
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  }, 150);
}

export function flushStore() {
  clearTimeout(saveTimer);
  fs.writeFileSync(PAPERS_FILE, JSON.stringify(papers, null, 2));
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionIndex, null, 2));
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

// ---- projects (paper sets; sessions are grouped by project) ----

export function listProjects() {
  return projects;
}

export function getProject(id) {
  return projects.find((x) => x.id === id) || null;
}

export function createProject(name) {
  const p = { id: "prj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, paperIds: [], resources: { skillsEnabled: [], extensions: [] }, createdAt: new Date().toISOString() };
  projects.push(p);
  persist();
  return p;
}

export function updateProject(id, { name, addPaper, removePaper, resources } = {}) {
  const p = projects.find((x) => x.id === id);
  if (!p) return null;
  if (name) p.name = name;
  if (addPaper && !p.paperIds.includes(addPaper)) p.paperIds.push(addPaper);
  if (removePaper) p.paperIds = p.paperIds.filter((x) => x !== removePaper);
  if (resources) p.resources = { ...(p.resources || {}), ...resources };
  persist();
  return p;
}

export function deleteProject(id) {
  projects = projects.filter((x) => x.id !== id);
  persist();
}

export function getPapers() {
  return papers;
}

export function listPapers() {
  return papers.papers;
}

export function getPaper(id) {
  return papers.papers.find((p) => p.id === id);
}

// ---- literature identity: content-hash state machine ----
// A paper's identity = sha256 of its PDF content. The parse cache is keyed by
// this hash, so the same paper imported twice (or seen via Zotero + import)
// shares one parse state.

const HASH_CACHE_FILE = path.join(DATA_DIR, "hash-cache.json");
let hashCache = {};
try {
  hashCache = JSON.parse(fs.readFileSync(HASH_CACHE_FILE, "utf8"));
} catch {}
let hashDirty = false;

export function fileHash(filePath) {
  try {
    const st = fs.statSync(filePath);
    const key = filePath + "|" + st.size + "|" + st.mtimeMs;
    if (hashCache[key]) return hashCache[key];
    const h = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    hashCache[key] = h;
    hashDirty = true;
    return h;
  } catch {
    return null;
  }
}

export function flushHashCache() {
  if (!hashDirty) return;
  hashDirty = false;
  try {
    fs.writeFileSync(HASH_CACHE_FILE, JSON.stringify(hashCache));
  } catch {}
}
setInterval(flushHashCache, 3000).unref?.();

export function findByHash(hash) {
  if (!hash) return null;
  return papers.papers.find((p) => p.contentHash === hash) || null;
}

// Storage key for parse artifacts: hash when known, else paper id.
export function parseKey(paper) {
  return paper?.contentHash ? "h_" + paper.contentHash.slice(0, 24) : paper?.id;
}

export function attachHash(paper) {
  if (!paper.pdfPath) return paper;
  const h = fileHash(paper.pdfPath);
  if (h) paper.contentHash = h;
  return paper;
}

export function mergePaperIdentity(existing, incoming) {
  // merge duplicate views of the same physical paper
  existing.aliases = [...new Set([...(existing.aliases || []), incoming.title, ...(incoming.aliases || [])].filter(Boolean))];
  existing.sources = [...new Set([...(existing.sources || []), incoming.source || "library", existing.source].filter(Boolean))];
  if (!existing.pdfPath && incoming.pdfPath) existing.pdfPath = incoming.pdfPath;
  if (incoming.zoteroKey) existing.zoteroKey = incoming.zoteroKey;
  if (incoming.abstract && !existing.abstract) existing.abstract = incoming.abstract;
  if (incoming.doi && !existing.doi) existing.doi = incoming.doi;
  if (incoming.year && !existing.year) existing.year = incoming.year;
  persist();
  return existing;
}

export function upsertPaper(p) {
  const i = papers.papers.findIndex((x) => x.id === p.id);
  if (i >= 0) papers.papers[i] = { ...papers.papers[i], ...p };
  else papers.papers.push(p);
  persist();
  return p;
}

export function mergeZoteroSnapshot({ items, collections, syncedAt, dataDir }) {
  // unify: a zotero item whose PDF hash matches an already-managed paper merges
  // into it (same identity, shared parse state) instead of duplicating
  const unified = [];
  const mergedIds = new Set();
  for (const z of items) {
    const twin = z.contentHash ? findByHash(z.contentHash) : null;
    if (twin && twin.source !== "zotero") {
      mergePaperIdentity(twin, z);
      mergedIds.add(z.id);
      unified.push(twin);
    } else unified.push(z);
  }
  // dedupe within zotero items themselves (two items, same file)
  const seen = new Map();
  const deduped = [];
  for (const p of unified) {
    const key = p.contentHash || p.id;
    if (seen.has(key)) {
      mergePaperIdentity(seen.get(key), p);
    } else {
      seen.set(key, p);
      deduped.push(p);
    }
  }
  const zoteroIds = new Set(deduped.map((p) => p.id));
  const manual = papers.papers.filter((p) => p.source !== "zotero" && !mergedIds.has(p.id) && !zoteroIds.has(p.id));
  // keep manual papers that were merged into zotero views out of the list (already unified)
  papers.papers = [...deduped, ...manual.filter((m) => !deduped.some((d) => d.contentHash && d.contentHash === m.contentHash))];
  papers.collections = collections;
  papers.zoteroSyncedAt = syncedAt;
  papers.zoteroDataDir = dataDir;
  persist();
}

export function makeLocalId(filePath) {
  const h = crypto.createHash("sha1").update(filePath.toLowerCase()).digest("hex").slice(0, 12);
  return "lib_" + h;
}

export function importPdfFile(origName, buf) {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  const safe = origName.replace(/[\\/:*?"<>|]/g, "_");
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  // dedupe: same content already managed (from any source) -> reuse identity + parse state
  const existing = findByHash(hash);
  if (existing) {
    const alias = safe.replace(/\.pdf$/i, "");
    existing.aliases = [...new Set([...(existing.aliases || []), alias])].filter(Boolean);
    existing.sources = [...new Set([...(existing.sources || []), "library", existing.source].filter(Boolean))];
    if (!existing.pdfPath) existing.pdfPath = path.join(LIBRARY_DIR, safe);
    persist();
    return { paper: existing, reused: true };
  }
  let target = path.join(LIBRARY_DIR, safe);
  if (fs.existsSync(target)) {
    target = path.join(LIBRARY_DIR, safe.replace(/\.pdf$/i, "") + "-" + Date.now() + ".pdf");
  }
  fs.writeFileSync(target, buf);
  const id = makeLocalId(target);
  const title = path.basename(target).replace(/\.pdf$/i, "");
  const paper = {
    id,
    title,
    aliases: [],
    sources: ["library"],
    contentHash: hash,
    creators: [],
    year: null,
    source: "library",
    pdfPath: target,
    added: new Date().toISOString(),
  };
  upsertPaper(paper);
  return { paper: getPaper(id), reused: false };
}

// ---- parse state (keyed by content hash so state is shared across sources) ----
export function parsedDir(paperIdOrKey) {
  const key = getPaper(paperIdOrKey) ? parseKey(getPaper(paperIdOrKey)) : paperIdOrKey;
  return path.join(PARSED_DIR, key);
}

export function getParseState(paperId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(parsedDir(paperId), "state.json"), "utf8"));
  } catch {
    return null;
  }
}

export function writeParseState(paperId, state) {
  const dir = parsedDir(paperId);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...getParseState(paperId), ...state };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(next, null, 2));
  return next;
}

export function readBlocks(paperId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(parsedDir(paperId), "blocks.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readParsedText(paperId) {
  try {
    return fs.readFileSync(path.join(parsedDir(paperId), "full.md"), "utf8");
  } catch {
    return null;
  }
}

// ---- session index (UI metadata over pi sessions) ----
export function sessionMeta(id) {
  return sessionIndex[id] || null;
}

export function setSessionMeta(id, patch) {
  sessionIndex[id] = { ...(sessionIndex[id] || {}), ...patch };
  if (!sessionIndex[id].createdAt) sessionIndex[id].createdAt = new Date().toISOString();
  persist();
  return sessionIndex[id];
}

export function deleteSessionMeta(id) {
  delete sessionIndex[id];
  persist();
}

export function allSessionMeta() {
  return sessionIndex;
}

export { TMP_DIR };
