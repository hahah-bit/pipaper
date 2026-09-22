import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DATA_DIR } from "./config.js";
import { getPaper, getProject, findByHash, upsertPaper, flushStore } from "./store.js";

export const STUDIES_DIR = path.join(DATA_DIR, "studies");
export const STUDY_PAPERS_DIR = path.join(DATA_DIR, "study-papers");
export const fault = (message, status = 400) => Object.assign(new Error(message), { status });
export const hashOf = value => createHash("sha256").update(value).digest("hex");
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function taskDir(id) {
  if (!/^study_[a-f0-9-]{36}$/.test(id || "")) throw fault("无效的研读任务 ID");
  return path.join(STUDIES_DIR, id);
}
export function inside(root, relative) {
  const file = path.resolve(root, String(relative));
  const rel = path.relative(path.resolve(root), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw fault("路径越界");
  // Refuse linked ancestors as well as lexical traversal.
  let cursor = file;
  while (cursor !== path.resolve(root)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw fault("不支持符号链接");
    cursor = path.dirname(cursor);
  }
  return file;
}
export function readTask(id) {
  try { return JSON.parse(fs.readFileSync(path.join(taskDir(id), "task.json"), "utf8")); }
  catch (e) { if (e.code === "ENOENT") throw fault("研读任务不存在", 404); throw e; }
}
export function saveTask(task) {
  task.revision = (task.revision || 0) + 1;
  task.updatedAt = new Date().toISOString();
  atomicJson(path.join(taskDir(task.id), "task.json"), task);
  return task;
}
export function listTasks() {
  if (!fs.existsSync(STUDIES_DIR)) return [];
  return fs.readdirSync(STUDIES_DIR).filter(id => /^study_[a-f0-9-]{36}$/.test(id)).flatMap(id => {
    try { return [readTask(id)]; } catch { return []; }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function validateTaskInput(input = {}) {
  const goal = String(input.goal || "").trim() || "理解论文主线，判断精读价值";
  const goalType = input.goalType || "understand";
  if (goal.length > 4000 || !["understand", "reproduce", "innovate"].includes(goalType)) throw fault("阅读目标无效或过长");
  if (input.projectId && !getProject(input.projectId)) throw fault("项目不存在");
  return { goal, goalType, projectId: input.projectId || null };
}
export function temporaryPdf(name, buffer) {
  if (!/\.pdf$/i.test(name || "") || !buffer?.length || buffer.length > 100 * 1024 * 1024 || !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw fault("请选择有效的 PDF（最大 100 MB）");
  const contentHash = hashOf(buffer);
  const old = findByHash(contentHash);
  if (old) return old;
  fs.mkdirSync(STUDY_PAPERS_DIR, { recursive: true });
  const pdfPath = path.join(STUDY_PAPERS_DIR, contentHash + ".pdf");
  fs.writeFileSync(pdfPath, buffer);
  const paper = { id: "study_pdf_" + contentHash.slice(0, 24), title: path.basename(name).replace(/\.pdf$/i, ""),
    contentHash, pdfPath, studyOnly: true, source: "study", creators: [], added: new Date().toISOString() };
  upsertPaper(paper); flushStore(); return paper;
}
export function newTask(paperId, input) {
  const prefs = validateTaskInput(input);
  const paper = getPaper(paperId);
  if (!paper?.pdfPath || !fs.existsSync(paper.pdfPath)) throw fault("所选论文没有可读取的 PDF");
  const task = { schemaVersion: 1, id: "study_" + randomUUID(), paperId, title: paper.title, ...prefs,
    status: "active", createdAt: new Date().toISOString(), revision: 0, versionId: null,
    guideSessionId: null, chatSessionId: null, sessionIds: [], checkpoints: [], cursor: 0,
    messages: [], artifacts: [], translations: {}, glossary: {}, ui: {}, exports: [], errors: [] };
  return saveTask(task);
}
export function publicTask(task) {
  const copy = structuredClone(task);
  delete copy.imageAttempts;
  for (const checkpoint of copy.checkpoints) {
    if (checkpoint.lesson?.questions) checkpoint.lesson.questions = checkpoint.lesson.questions.map(({ id, question }) => ({ id, question }));
  }
  delete copy.glossary;
  return copy;
}
export function taskSummary(t) {
  const stage = t.checkpoints[t.cursor]?.stage || "rough";
  return { id: t.id, paperId: t.paperId, title: t.title, goal: t.goal, goalType: t.goalType,
    status: t.status, stage, progress: t.checkpoints.filter(c => c.status === "passed").length,
    total: t.checkpoints.length, updatedAt: t.updatedAt, createdAt: t.createdAt, exported: !!t.exports.length };
}
