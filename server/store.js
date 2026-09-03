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

export function createProject(name) {
  const p = { id: "prj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, paperIds: [], createdAt: new Date().toISOString() };
  projects.push(p);
  persist();
  return p;
}

export function updateProject(id, { name, addPaper, removePaper } = {}) {
  const p = projects.find((x) => x.id === id);
  if (!p) return null;
  if (name) p.name = name;
  if (addPaper && !p.paperIds.includes(addPaper)) p.paperIds.push(addPaper);
  if (removePaper) p.paperIds = p.paperIds.filter((x) => x !== removePaper);
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

export function upsertPaper(p) {
  const i = papers.papers.findIndex((x) => x.id === p.id);
  if (i >= 0) papers.papers[i] = { ...papers.papers[i], ...p };
  else papers.papers.push(p);
  persist();
  return p;
}

export function mergeZoteroSnapshot({ items, collections, syncedAt, dataDir }) {
  const manual = papers.papers.filter((p) => p.source !== "zotero");
  papers.papers = [...items, ...manual];
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
  let target = path.join(LIBRARY_DIR, safe);
  if (fs.existsSync(target)) {
    target = path.join(LIBRARY_DIR, safe.replace(/\.pdf$/i, "") + "-" + Date.now() + ".pdf");
  }
  fs.writeFileSync(target, buf);
  const id = makeLocalId(target);
  const title = path.basename(target).replace(/\.pdf$/i, "");
  upsertPaper({
    id,
    title,
    creators: [],
    year: null,
    source: "library",
    pdfPath: target,
    added: new Date().toISOString(),
  });
  return getPaper(id);
}

// ---- parse state ----
export function parsedDir(paperId) {
  return path.join(PARSED_DIR, paperId);
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
