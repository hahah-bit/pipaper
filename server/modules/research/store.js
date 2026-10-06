import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import { getPaper, getProject } from "../../store.js";
import { readJsonState, writeJsonState, trashPath } from "../../storage/files.js";
import { link, resource } from "../../storage/catalog.js";
import { fault } from "../../platform/errors.js";

// 研究模块（加法开发 A01—A03）：为已有项目附加可选研究记录。
// 每条记录是独立 JSON 文件并经统一存储登记，可从回收站恢复；
// 只引用现有论文与资源，不复制、不移动原件，也不改动项目本身。

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ACTION_STATUS = ["todo", "doing", "done", "blocked"];
const TEXT_LIMITS = { question: 4000, scope: 4000, goal: 2000, constraints: 4000 };

export const profileId = (projectId) => "research-profile:" + projectId;

export function researchDir(projectId) {
  if (!ID_PATTERN.test(projectId || "")) throw fault("无效的项目标识", 400);
  return path.join(DATA_DIR, "research", projectId);
}

const profileFile = (projectId) => path.join(researchDir(projectId), "profile.json");

function assertProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw fault("项目不存在", 404);
  return project;
}

function limitText(value, field) {
  if (value == null) return "";
  if (typeof value !== "string") throw fault("研究档案字段必须是文本：" + field, 400);
  const trimmed = value.trim();
  const max = TEXT_LIMITS[field];
  if (trimmed.length > max) throw fault(`「${field}」超过 ${max} 字上限`, 400);
  return trimmed;
}

function resolveOutcome(entry) {
  const refId = typeof entry?.refId === "string" ? entry.refId.trim() : "";
  if (!refId) throw fault("成果关联缺少 refId", 400);
  if (refId.startsWith("paper:")) {
    const paper = getPaper(refId.slice("paper:".length));
    if (!paper) throw fault("成果关联的论文不存在：" + refId, 400);
    return { refId, kind: "paper", title: paper.title || "", linkedAt: entry.linkedAt || new Date().toISOString() };
  }
  const target = resource(refId);
  if (!target || target.lifecycle !== "active") throw fault("成果关联对象不存在或已删除：" + refId, 400);
  return { refId, kind: target.kind, title: target.title || "", linkedAt: entry.linkedAt || new Date().toISOString() };
}

function normalizeAction(entry) {
  const value = typeof entry === "string" ? entry : entry?.text;
  const body = typeof value === "string" ? value.trim() : "";
  if (!body) throw fault("行动项内容不能为空", 400);
  if (body.length > 500) throw fault("行动项超过 500 字上限", 400);
  const status = ACTION_STATUS.includes(entry?.status) ? entry.status : "todo";
  return {
    id: ID_PATTERN.test(entry?.id || "") ? entry.id : "act_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: body,
    status,
    blockedReason: status === "blocked" ? limitText(entry?.blockedReason, "blockedReason") || "未说明阻塞原因" : "",
    createdAt: entry?.createdAt || new Date().toISOString(),
    doneAt: status === "done" ? entry?.doneAt || new Date().toISOString() : null,
  };
}

function normalizeList(value, normalize, max, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault(`「${label}」必须是列表`, 400);
  if (value.length > max) throw fault(`「${label}」超过 ${max} 条上限`, 400);
  return value.map(normalize);
}

function readProfileState(projectId) {
  // 回收站中的档案视为未启用；资源未登记时才回退到读文件。
  const entry = resource(profileId(projectId));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(profileFile(projectId), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function loadProfile(projectId) {
  assertProject(projectId);
  return readProfileState(projectId);
}

export function saveProfile(projectId, patch = {}) {
  const project = assertProject(projectId);
  const existing = readProfileState(projectId);
  if (patch.revision != null && existing && Number(patch.revision) !== existing.revision)
    throw fault("研究档案已被其他修改更新，请刷新后重试", 409);
  const now = new Date().toISOString();
  const next = {
    projectId,
    question: limitText(patch.question, "question"),
    scope: limitText(patch.scope, "scope"),
    goal: limitText(patch.goal, "goal"),
    constraints: limitText(patch.constraints, "constraints"),
    outcomes: normalizeList(patch.outcomes, resolveOutcome, 100, "成果关联"),
    actions: normalizeList(patch.actions, normalizeAction, 200, "行动项"),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  const file = profileFile(projectId);
  writeJsonState(file, next, {
    id: profileId(projectId),
    kind: "research-profile",
    title: "研究档案 · " + (project.name || projectId),
    metadata: next,
  });
  link(profileId(projectId), "project:" + projectId, "uses");
  return next;
}

export function deleteProfile(projectId) {
  assertProject(projectId);
  const file = profileFile(projectId);
  if (!fs.existsSync(file)) throw fault("研究档案不存在", 404);
  // 只删除研究档案本身；成果关联是引用，项目文献不受影响。
  return trashPath(file, { id: profileId(projectId), kind: "research-profile" });
}

// ---- 证据卡（A02）：把阅读摘录与检索发现保存为可反查的证据 ----

const EVIDENCE_TYPES = ["fact", "author-claim", "interpretation", "observation"];
const EVIDENCE_SOURCE_KINDS = ["paper", "retrieval", "manual"];
export const evidenceResourceId = (id) => "research-evidence:" + id;

function limitLength(value, message, max) {
  if (value == null) return "";
  if (typeof value !== "string") throw fault(message, 400);
  const trimmed = value.trim();
  if (trimmed.length > max) throw fault(`${message}（上限 ${max} 字）`, 400);
  return trimmed;
}

function normalizeEvidenceSource(source) {
  if (!source || typeof source !== "object") throw fault("证据缺少来源", 400);
  if (!EVIDENCE_SOURCE_KINDS.includes(source.kind))
    throw fault("证据来源类型必须是 paper、retrieval 或 manual", 400);
  const normalized = {
    kind: source.kind,
    label: limitLength(source.label, "来源说明无效", 300),
    paperId: "",
    resourceId: "",
    versionId: "",
    generationId: "",
    recordId: "",
    elementId: "",
    pages: [],
    sectionPath: [],
  };
  if (source.kind === "paper") {
    normalized.paperId = typeof source.paperId === "string" ? source.paperId : "";
    const paper = getPaper(normalized.paperId);
    if (!paper) throw fault("证据来源论文不存在", 400);
    normalized.label = normalized.label || paper.title || "";
    const page = Number(source.page);
    normalized.pages = Number.isInteger(page) && page > 0 ? [page] : [];
    return normalized;
  }
  if (source.kind === "retrieval") {
    for (const key of ["resourceId", "versionId", "generationId", "recordId", "elementId"])
      normalized[key] = limitLength(source[key], "来源定位字段无效：" + key, 200);
    if (!normalized.resourceId && !normalized.recordId)
      throw fault("检索证据至少需要 resourceId 或 recordId 才能反查", 400);
    if (normalized.resourceId) {
      const target = resource(normalized.resourceId);
      if (!target || target.lifecycle !== "active")
        throw fault("检索证据引用的知识资源不存在或已删除", 400);
    }
    if (Array.isArray(source.pages))
      normalized.pages = source.pages.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    if (Array.isArray(source.sectionPath))
      normalized.sectionPath = source.sectionPath.map((s) => limitLength(s, "章节路径无效", 200)).filter(Boolean).slice(0, 20);
    normalized.label = normalized.label || "知识库选区";
    return normalized;
  }
  // manual：手工记录也要求说明来源，否则无法核对。
  if (!normalized.label) throw fault("手工证据必须填写来源说明", 400);
  return normalized;
}

function evidenceDirectory(projectId) {
  return path.join(researchDir(projectId), "evidence");
}

const evidenceFile = (projectId, id) => path.join(evidenceDirectory(projectId), id + ".json");

function readEvidenceState(projectId, id) {
  const entry = resource(evidenceResourceId(id));
  if (entry && entry.lifecycle !== "active") return null; // 回收站中的证据视为不存在
  try {
    return readJsonState(evidenceFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function getEvidence(projectId, id) {
  if (!/^ev_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的证据标识", 400);
  assertProject(projectId);
  const value = readEvidenceState(projectId, id);
  if (!value) throw fault("证据卡不存在", 404);
  return value;
}

export function listEvidence(projectId) {
  assertProject(projectId);
  const dir = evidenceDirectory(projectId);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readEvidenceState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return rows;
}

function saveEvidenceRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const content = limitLength(patch.content, "证据内容不能为空", 8000);
  if (!content) throw fault("证据内容不能为空", 400);
  const record = {
    id: existing?.id || "ev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    type: EVIDENCE_TYPES.includes(patch.type) ? patch.type : existing?.type || "fact",
    content,
    note: limitLength(patch.note, "证据备注无效", 2000),
    conditions: limitLength(patch.conditions, "适用条件无效", 2000),
    checked: Boolean(patch.checked ?? existing?.checked ?? false),
    source: normalizeEvidenceSource(patch.source || existing?.source),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(evidenceFile(projectId, record.id), record, {
    id: evidenceResourceId(record.id),
    kind: "research-evidence",
    title: record.content.slice(0, 40),
    metadata: record,
  });
  if (record.source.kind === "paper")
    link(evidenceResourceId(record.id), "paper:" + record.source.paperId, "uses");
  else if (record.source.kind === "retrieval" && record.source.resourceId)
    link(evidenceResourceId(record.id), record.source.resourceId, "uses");
  return record;
}

export function createEvidence(projectId, patch = {}) {
  assertProject(projectId);
  return saveEvidenceRecord(projectId, null, patch);
}

export function updateEvidence(projectId, id, patch = {}) {
  const existing = getEvidence(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("证据卡已被其他修改更新，请刷新后重试", 409);
  return saveEvidenceRecord(projectId, existing, patch);
}

export function deleteEvidence(projectId, id) {
  const existing = getEvidence(projectId, id);
  // 只删除证据卡本身；它引用的原文、知识资源与项目文献不受影响。
  return trashPath(evidenceFile(projectId, existing.id), {
    id: evidenceResourceId(existing.id),
    kind: "research-evidence",
  });
}
