import { isActive, resource as storageResource, resourceAt, invalidate, transaction, writeState, putResource, link, unlink, dependencies } from "./storage/catalog.js";
import { registerPaper } from "./storage/migration.js";
import { writeFile as managedWrite, readJsonState, writeJsonState, trashPath, trash, registerFile } from "./storage/files.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeResources } from "./resource-config.js";
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
    papers = { ...papers, ...readJsonState(PAPERS_FILE, papers) };
  } catch {}
  try {
    sessionIndex = readJsonState(SESSIONS_FILE, {});
  } catch {}
  try {
    projects = readJsonState(PROJECTS_FILE, []);
  } catch {}
}
load();
for(const p of projects)registerProject(p);

// Back up the original indexes once, before the first v2 write.
const MIGRATION_FILE = path.join(DATA_DIR, "pi-resources-v2.json");
if (!fs.existsSync(MIGRATION_FILE)) {
  for (const file of [PROJECTS_FILE, SESSIONS_FILE]) {
    if (fs.existsSync(file) && !fs.existsSync(file + ".pre-pi-v2.bak")) fs.copyFileSync(file, file + ".pre-pi-v2.bak");
  }
  for (const p of projects) p.resources = normalizeResources(p.resources);
  writeJsonState(PROJECTS_FILE, projects);
  managedWrite(MIGRATION_FILE, JSON.stringify({ schemaVersion: 2, migratedAt: new Date().toISOString() }));
}

function persist() {
  for(const p of projects)registerProject(p);
  transaction(()=>{
    writeState("legacy:"+PAPERS_FILE,papers);
    writeState("legacy:"+SESSIONS_FILE,sessionIndex);
    writeState("legacy:"+PROJECTS_FILE,projects);
  });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJsonState(PAPERS_FILE, papers);
    for (const p of papers.papers) if (isActive("paper:" + p.id)) registerPaper(p);
    writeJsonState(SESSIONS_FILE, sessionIndex);
    writeJsonState(PROJECTS_FILE, projects);
  }, 150);
}

export function flushStore() {
  clearTimeout(saveTimer);
  writeJsonState(PAPERS_FILE, papers);
    for (const p of papers.papers) if (isActive("paper:" + p.id)) registerPaper(p);
  writeJsonState(SESSIONS_FILE, sessionIndex);
  writeJsonState(PROJECTS_FILE, projects);
}

// ---- projects (paper sets; sessions are grouped by project) ----

export function listProjects() {
  return projects.filter(p=>isActive("project:"+p.id));
}

export function getProject(id) {
  return projects.find((x) => x.id === id&&isActive("project:"+id)) || null;
}

export function createProject(name, type = "temp") {
  const p = { id: "prj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, type, paperIds: [], resources: normalizeResources(), createdAt: new Date().toISOString() };
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
  if (resources) p.resources = normalizeResources({ ...normalizeResources(p.resources), ...resources, revision: (p.resources?.revision || 0) + 1 });
  persist();
  return p;
}

export function deleteProject(id) {
  const p=getProject(id);if(p){registerProject(p);trash("project:"+id);for(const ref of dependencies("project:"+id).filter(r=>r.source==="project:"+id&&r.relation==="uses"))unlink(ref.source,ref.target);}
  projects = projects.filter((x) => x.id !== id);
  persist();
}
export function registerProject(p) {
  const id="project:"+p.id,old=storageResource(id);if(old&&old.lifecycle!=="active")return old;
  const next=JSON.stringify(old?.metadata)===JSON.stringify(p)?old:putResource({...old,id,kind:"project",title:p.name,metadata:p});
  for(const ref of dependencies(id).filter(r=>r.source===id&&r.relation==="uses"&&!p.paperIds.includes(r.target.replace(/^paper:/,""))))unlink(id,ref.target);
  for(const paperId of p.paperIds)link(id,"paper:"+paperId,"uses");return next;
}
export function restoreProject(metadata) {
  const existing=projects.find(p=>p.id===metadata.id);if(!existing)projects.push(metadata);persist();return getProject(metadata.id);
}

export function getPapers() {
  return papers;
}

export function listPapers({ includeTemporary = false } = {}) {
  return papers.papers.filter(p => isActive("paper:" + p.id) && (includeTemporary || !p.studyOnly));
}

export function removeTemporaryPaper(id) {
  const paper = papers.papers.find(p=>p.id===id) || storageResource("paper:"+id)?.metadata;
  if (!paper?.studyOnly) throw new Error("只能清理研读暂存论文");
  papers.papers = papers.papers.filter(p => p.id !== id);
  persist();
}

export function getPaper(id) {
  return papers.papers.find((p) => p.id === id && isActive("paper:" + p.id));
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
    managedWrite(HASH_CACHE_FILE, JSON.stringify(hashCache));
  } catch {}
}
setInterval(flushHashCache, 3000).unref?.();

export function findByHash(hash) {
  if (!hash) return null;
  return papers.papers.find((p) => p.contentHash === hash && isActive("paper:" + p.id)) || null;
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
  const old = papers.papers.find(x => x.id === p.id);
  if (old?.contentHash && p.contentHash && old.contentHash !== p.contentHash) invalidate("paper:" + p.id);
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
    if (existing.studyOnly) {
      const target = path.join(LIBRARY_DIR, hash.slice(0, 16) + "-" + safe);
      managedWrite(target, buf);
      existing.pdfPath = target;
      existing.studyOnly = false;
      existing.source = "library";
    }
    const alias = safe.replace(/\.pdf$/i, "");
    existing.aliases = [...new Set([...(existing.aliases || []), alias])].filter(Boolean);
    existing.sources = [...new Set([...(existing.sources || []), "library", existing.source].filter(Boolean))];
    if (!existing.pdfPath) existing.pdfPath = path.join(LIBRARY_DIR, safe);
    persist();
    return { paper: existing, reused: true };
  }
  let target = path.join(LIBRARY_DIR, safe);
  if (fs.existsSync(target) || resourceAt(target)?.lifecycle&&resourceAt(target).lifecycle!=="active") {
    target = path.join(LIBRARY_DIR, safe.replace(/\.pdf$/i, "") + "-" + Date.now() + ".pdf");
  }
  managedWrite(target, buf);
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
  managedWrite(path.join(dir, "state.json"), JSON.stringify(next, null, 2));
  return next;
}

export function readBlocks(paperId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(activeParsedDir(paperId), "blocks.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readParsedText(paperId) {
  try {
    return fs.readFileSync(path.join(activeParsedDir(paperId), "full.md"), "utf8");
  } catch {
    return null;
  }
}

export function activeParsedDir(paperId) {
  const root = parsedDir(paperId);
  const pointer = path.join(root, "current.json");
  if (!fs.existsSync(pointer)) return root;
  const { versionId } = JSON.parse(fs.readFileSync(pointer, "utf8"));
  if (!/^v_[a-zA-Z0-9_-]+$/.test(versionId || "")) throw new Error("无效的当前解析版本");
  return path.join(root, "versions", versionId);
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
