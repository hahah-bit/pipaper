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

// ---- 文献对比表（A02.3—A02.6）：带单元格来源与差异标记的文献矩阵 ----

const CELL_STATUS = ["value", "zero", "not-reported", "unverified", "not-applicable"];
export const matrixResourceId = (id) => "research-matrix:" + id;

const matrixDirectory = (projectId) => path.join(researchDir(projectId), "matrices");
const matrixFile = (projectId, id) => path.join(matrixDirectory(projectId), id + ".json");

function normalizeColumns(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("对比列必须是列表", 400);
  if (value.length > 20) throw fault("对比列超过 20 列上限", 400);
  return value.map((column, index) => {
    const name = typeof column === "string" ? column.trim() : typeof column?.name === "string" ? column.name.trim() : "";
    if (!name) throw fault(`第 ${index + 1} 个对比列名称不能为空`, 400);
    if (name.length > 100) throw fault("对比列名称超过 100 字上限", 400);
    return { id: ID_PATTERN.test(column?.id || "") ? column.id : "col_" + (index + 1) + "_" + Date.now().toString(36), name };
  });
}

function normalizeMatrixPapers(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("对比论文必须是列表", 400);
  if (value.length > 30) throw fault("对比表最多比较 30 篇论文", 400);
  const ids = [];
  for (const paperId of value) {
    if (typeof paperId !== "string" || !getPaper(paperId)) throw fault("对比表中的论文不存在：" + paperId, 400);
    if (!ids.includes(paperId)) ids.push(paperId);
  }
  return ids;
}

function normalizeCells(value, paperIds, columns) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw fault("单元格数据无效", 400);
  const paperSet = new Set(paperIds), columnSet = new Set(columns.map((c) => c.id));
  const cells = {};
  for (const [key, cell] of Object.entries(value)) {
    const [paperId, columnId] = key.split("|");
    if (!paperSet.has(paperId) || !columnSet.has(columnId))
      throw fault("单元格不属于这张对比表：" + key, 400);
    const entry = cell && typeof cell === "object" ? cell : {};
    cells[key] = {
      value: limitLength(entry.value, "单元格内容无效", 2000),
      status: CELL_STATUS.includes(entry.status) ? entry.status : "value",
      note: limitLength(entry.note, "单元格备注无效", 500),
      sourceLabel: limitLength(entry.sourceLabel, "单元格来源无效", 300),
      page: Number.isInteger(Number(entry.page)) && Number(entry.page) > 0 ? Number(entry.page) : null,
      aiCandidate: Boolean(entry.aiCandidate),
    };
  }
  return cells;
}

function saveMatrixRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "对比表标题不能为空", 200);
  if (!title) throw fault("对比表标题不能为空", 400);
  const paperIds = normalizeMatrixPapers(patch.paperIds ?? existing?.paperIds);
  const columns = normalizeColumns(patch.columns ?? existing?.columns);
  const record = {
    id: existing?.id || "mtx_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    conditions: limitLength(patch.conditions, "比较条件说明无效", 2000),
    paperIds,
    columns,
    cells: normalizeCells(patch.cells ?? existing?.cells, paperIds, columns),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(matrixFile(projectId, record.id), record, {
    id: matrixResourceId(record.id),
    kind: "research-matrix",
    title: "对比表 · " + record.title,
    metadata: record,
  });
  for (const paperId of record.paperIds)
    link(matrixResourceId(record.id), "paper:" + paperId, "uses");
  return record;
}

function readMatrixState(projectId, id) {
  if (!/^mtx_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的对比表标识", 400);
  const entry = resource(matrixResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(matrixFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function listMatrices(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(matrixDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readMatrixState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getMatrix(projectId, id) {
  assertProject(projectId);
  const value = readMatrixState(projectId, id);
  if (!value) throw fault("对比表不存在", 404);
  return value;
}

export function createMatrix(projectId, patch = {}) {
  assertProject(projectId);
  return saveMatrixRecord(projectId, null, patch);
}

export function updateMatrix(projectId, id, patch = {}) {
  const existing = getMatrix(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("对比表已被其他修改更新，请刷新后重试", 409);
  return saveMatrixRecord(projectId, existing, patch);
}

export function deleteMatrix(projectId, id) {
  const existing = getMatrix(projectId, id);
  return trashPath(matrixFile(projectId, existing.id), {
    id: matrixResourceId(existing.id),
    kind: "research-matrix",
  });
}

// ---- 假设与研究决策（A03）：记录想法、依据、反例与取舍理由 ----

const DECISION_STATUS = ["exploring", "continue", "hold", "revise", "stop"];
export const hypothesisResourceId = (id) => "research-hypothesis:" + id;

const hypothesisDirectory = (projectId) => path.join(researchDir(projectId), "hypotheses");
const hypothesisFile = (projectId, id) => path.join(hypothesisDirectory(projectId), id + ".json");

function normalizeEvidenceRefs(value, projectId, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault(`「${field}」必须是证据标识列表`, 400);
  const refs = [];
  for (const raw of value) {
    const id = typeof raw === "string" ? raw : raw?.id;
    if (typeof id !== "string" || refs.includes(id)) continue;
    try {
      getEvidence(projectId, id); // 不存在或已删除的证据不能作为依据
    } catch {
      throw fault(`关联的${field}不存在或已删除：${id}`, 400);
    }
    refs.push(id);
  }
  return refs.slice(0, 50);
}

function normalizeDecision(value, existing) {
  if (value == null) return existing?.decision || null;
  if (typeof value !== "object") throw fault("研究决策无效", 400);
  if (!DECISION_STATUS.includes(value.status)) throw fault("决策状态必须是 exploring、continue、hold、revise 或 stop", 400);
  return {
    status: value.status,
    reason: limitLength(value.reason, "决策理由无效", 2000),
    at: existing?.decision?.status === value.status ? existing.decision.at : new Date().toISOString(),
  };
}

function saveHypothesisRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "假设标题不能为空", 200);
  if (!title) throw fault("假设标题不能为空", 400);
  const statement = limitLength(patch.statement ?? existing?.statement, "假设内容不能为空", 4000);
  if (!statement) throw fault("假设内容不能为空", 400);
  const decision = normalizeDecision(patch.decision, existing);
  const record = {
    id: existing?.id || "hyp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    statement,
    prediction: limitLength(patch.prediction, "预测描述无效", 2000),
    scope: limitLength(patch.scope, "作用范围无效", 1000),
    counterExamples: limitLength(patch.counterExamples, "反例与替代解释无效", 2000),
    unknowns: limitLength(patch.unknowns, "未知项说明无效", 1000),
    support: normalizeEvidenceRefs(patch.support ?? existing?.support, projectId, "支持证据"),
    oppose: normalizeEvidenceRefs(patch.oppose ?? existing?.oppose, projectId, "反对证据"),
    decision,
    decisionHistory: existing?.decisionHistory || [],
    sourceNote: limitLength(patch.sourceNote, "来源说明无效", 500),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  if (decision && existing?.decision?.status !== decision.status)
    record.decisionHistory = [...record.decisionHistory, { at: decision.at, status: decision.status, reason: decision.reason }];
  writeJsonState(hypothesisFile(projectId, record.id), record, {
    id: hypothesisResourceId(record.id),
    kind: "research-hypothesis",
    title: "假设 · " + record.title,
    metadata: record,
  });
  for (const evidenceIdValue of record.support)
    link(hypothesisResourceId(record.id), evidenceResourceId(evidenceIdValue), "uses");
  for (const evidenceIdValue of record.oppose)
    link(hypothesisResourceId(record.id), evidenceResourceId(evidenceIdValue), "uses");
  return record;
}

function readHypothesisState(projectId, id) {
  if (!/^hyp_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的假设标识", 400);
  const entry = resource(hypothesisResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(hypothesisFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function listHypotheses(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(hypothesisDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readHypothesisState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getHypothesis(projectId, id) {
  assertProject(projectId);
  const value = readHypothesisState(projectId, id);
  if (!value) throw fault("假设不存在", 404);
  return value;
}

export function createHypothesis(projectId, patch = {}) {
  assertProject(projectId);
  return saveHypothesisRecord(projectId, null, patch);
}

export function updateHypothesis(projectId, id, patch = {}) {
  const existing = getHypothesis(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("假设已被其他修改更新，请刷新后重试", 409);
  return saveHypothesisRecord(projectId, existing, patch);
}

export function deleteHypothesis(projectId, id) {
  const existing = getHypothesis(projectId, id);
  return trashPath(hypothesisFile(projectId, existing.id), {
    id: hypothesisResourceId(existing.id),
    kind: "research-hypothesis",
  });
}
