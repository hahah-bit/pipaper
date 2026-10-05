import { writeFile as managedWrite, readJsonState, writeJsonState, trashPath, registerFile } from "../storage/files.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../config.js";
import { inside } from "../platform/files/managed-paths.js";
import { createTaskRepository } from "../platform/storage/task-repository.js";
const atomicJson = (file, value) => writeJsonState(file, value);
import { KNOWLEDGE_DIR } from "../notes.js";
import { registerKnowledge } from "../storage/migration.js";
import { link, putResource } from "../storage/catalog.js";

export const ROOT = path.join(DATA_DIR, "topic-analysis");
export const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const stamp = () => new Date().toISOString();
export function folder(id) {
  if (!/^topic_[a-f0-9-]{36}$/.test(id || "")) throw fault("无效的选题任务 ID");
  return inside(ROOT, `tasks/${id}`);
}
const profilesFile = () => path.join(ROOT, "profiles.json");
export function profiles() {
  try { return readJsonState(profilesFile(), []); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function text(value, max = 2000) { return String(value ?? "").trim().slice(0, max); }
function number(value, min, max, nullable = false) {
  if (nullable && (value === "" || value == null)) return null;
  const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) throw fault(`数值须在 ${min}–${max} 之间`); return n;
}
export function validateProfile(input) {
  const p = { name: text(input.name, 80), hardware: text(input.hardware), researchArea: text(input.researchArea),
    gpuCount: number(input.gpuCount, 0, 1024, true), vramGB: number(input.vramGB, 0, 2000, true),
    months: number(input.months, 1, 120), deadlineStage: input.deadlineStage,
    openData: input.openData === true, experience: input.experience,
    weeklyHours: number(input.weeklyHours, 1, 168), contribution: input.contribution };
  if (!p.name || !p.hardware || !p.researchArea) throw fault("请填写画像名称、硬件范围和研究大方向");
  if (!["experiment", "manuscript", "submission"].includes(p.deadlineStage) || !["beginner", "basic", "experienced"].includes(p.experience) || !["application", "method", "theory", "undecided"].includes(p.contribution)) throw fault("调查卡选项无效");
  return p;
}
export function saveProfile(input, id) {
  const rows = profiles(), old = id && rows.find(p => p.id === id);
  if (id && !old) throw fault("画像不存在", 404);
  const p = { ...validateProfile(input), id: old?.id || "profile_" + randomUUID(), createdAt: old?.createdAt || stamp(), updatedAt: stamp() };
  atomicJson(profilesFile(), old ? rows.map(x => x.id === id ? p : x) : [...rows, p]); return p;
}
export function deleteProfile(id) {
  const rows = profiles(); if (!rows.some(p => p.id === id)) throw fault("画像不存在", 404);
  atomicJson(profilesFile(), rows.filter(p => p.id !== id));
}
const repository = createTaskRepository({ directoryFor: folder, kind: "topic", missingMessage: "选题任务不存在" });
export const read = id => repository.read(id);
export function change(id, fn, { deleting = false } = {}) {
  const t = read(id);
  if (!deleting && ["deleting", "delete-failed"].includes(t.status)) throw fault("任务正在删除，不能再写入", 409);
  fn(t); return repository.save(t);
}
export function list() {
  const dir = path.join(ROOT, "tasks"); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(id => /^topic_[a-f0-9-]{36}$/.test(id)).flatMap(id=>{try{return [read(id)];}catch(e){if(e.status===404)return [];throw e;}}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function create(input) {
  if (!input || !["topic", "direction"].includes(input.mode) || Array.isArray(input.profileId) || input.profileIds) throw fault("请选择一种分析模式和至多一张画像");
  const profile = input.mode === "topic" ? profiles().find(p => p.id === input.profileId) : null;
  if (input.mode === "topic" && !profile) throw fault("一次选题必须选择一张有效画像");
  const area = profile?.researchArea || text(input.researchArea);
  if (!area) throw fault("请填写要探索的研究大方向");
  const t = { schemaVersion: 1, id: "topic_" + randomUUID(), title: text(input.title, 100) || area.slice(0, 60), mode: input.mode,
    profile: profile ? structuredClone(profile) : null, researchArea: area, exploreSubfields: input.exploreSubfields !== false,
    createdAt: stamp(), updatedAt: stamp(), revision: 0, status: "draft", model: input.model || null,
    artifacts: [], reportId: null, runs: [], chat: [], chatEpoch: 0, memory: "", ui: {}, events: [], chatBusy: false };
  return repository.save(t);
}
export function artifact(id, kind, title, data, dependencies = []) {
  const t = read(id); if (["deleting", "delete-failed"].includes(t.status)) throw fault("任务正在删除", 409);
  const fileId = randomUUID(), file = inside(folder(id), `files/${fileId}.json`);
  atomicJson(file, data);
  try { change(id, task => task.artifacts.push({ id: fileId, kind, title, dependencies, createdAt: stamp(), bytes: fs.statSync(file).size })); }
  catch (e) { fs.rmSync(file, { force: true }); throw e; }
  if (kind === "report") {
    const snapshot=path.join(KNOWLEDGE_DIR,"选题报告",id,fileId+".md");
    managedWrite(snapshot,reportMarkdown(data,title),{kind:"knowledge",sourceType:"topic",title,independent:true,owner:null});
    const registered=registerKnowledge(snapshot,{sourceType:"topic",title,independent:true,owner:null});link("topic:"+id,registered.id,"snapshot");
  }
  return fileId;
}
export function readArtifact(id, fileId) {
  const t = read(id);
  if (t.cleanupError?.removedIds.includes(fileId)) throw fault("资料正在清理，请重试删除以完成清理", 409);
  if (!t.artifacts.some(a => a.id === fileId)) throw fault("资料不存在", 404);
  return JSON.parse(fs.readFileSync(inside(folder(id), `files/${fileId}.json`), "utf8"));
}
export function removeArtifact(id, fileId) {
  const t = read(id); if (!t.artifacts.some(a => a.id === fileId)) throw fault("资料不存在", 404);
  const removed = new Set([fileId]); let size;
  do { size = removed.size; for (const a of t.artifacts) if (a.dependencies.some(d => removed.has(d))) removed.add(a.id); } while (size !== removed.size);
  // Data first: failures leave metadata available for a retry, never claim success.
  try { for (const key of removed) trashPath(inside(folder(id), `files/${key}.json`), {kind:"topic-artifact",owner:"topic:"+id}); }
  catch (e) { change(id, task => { task.cleanupError = { fileId, removedIds: [...removed], error: e.message }; task.lastError = "资料清理未完成，请重试删除；分析和对话暂时停止写入。"; }); throw e; }
  change(id, task => {
    task.artifacts = task.artifacts.filter(a => !removed.has(a.id));
    task.runs = task.runs.filter(r => !removed.has(r.reportId));
    if (removed.has(task.reportId)) { task.reportId = null; task.status = "draft"; }
    task.memory = ""; task.chat = []; task.chatEpoch = (task.chatEpoch || 0) + 1; task.ui.chatDraft = "";
    task.events = []; task.lastError = null;
    task.cleanupError = null;
  }); return [...removed];
}
export function recover() {
  for (const t of list()) if (t.status === "running" || t.chatBusy || t.status === "deleting") change(t.id, x => {
    x.status = x.status === "deleting" ? "delete-failed" : x.status === "running" ? "interrupted" : x.status;
    x.chatBusy = false; x.lastError = "服务重启中断了操作，可重试；已保存资料仍可查看。";
    for (const m of x.chat) if (m.status === "streaming") m.status = "interrupted";
  }, { deleting: true });
}
export function removeTaskFiles(id) {
  trashPath(folder(id), { id: "topic:" + id, kind: "topic" });
}
function reportMarkdown(data,title) {
  const rows=["# "+title];
  const walk=(value,key,depth)=>{
    if(value==null)return;
    if(typeof value!=="object"){rows.push((key?key+"：":"")+String(value));return;}
    if(key)rows.push("#".repeat(Math.min(6,depth))+" "+key);
    if(Array.isArray(value))value.forEach((v,n)=>walk(v,"条目 "+(n+1),depth+1));else for(const[k,v]of Object.entries(value))walk(v,k,depth+1);
  };walk(data,"报告内容",2);return rows.join("\n\n");
}
