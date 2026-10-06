import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import { getPaper, getProject, findByHash } from "../../store.js";
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

// ---- 研究方案与基线对齐（A04）：接住研读计划与手写方案，冻结可引用版本 ----

const PROTOCOL_STATUS = ["draft", "frozen"];
const BASELINE_STATUS = ["aligned", "partial", "unaligned", "na"];
export const protocolResourceId = (id) => "research-protocol:" + id;

const protocolDirectory = (projectId) => path.join(researchDir(projectId), "protocols");
const protocolFile = (projectId, id) => path.join(protocolDirectory(projectId), id + ".json");

function normalizeBaselines(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("基线对齐行必须是列表", 400);
  if (value.length > 20) throw fault("基线对齐表最多 20 行", 400);
  return value.map((row) => {
    const name = limitLength(row?.name, "基线名称无效", 200);
    if (!name) throw fault("基线名称不能为空", 400);
    return {
      name,
      paperSetup: limitLength(row?.paperSetup, "论文设置说明无效", 2000),
      repoSetup: limitLength(row?.repoSetup, "仓库配置说明无效", 2000),
      actualSetup: limitLength(row?.actualSetup, "实际条件说明无效", 2000),
      status: BASELINE_STATUS.includes(row?.status) ? row.status : "unaligned",
      note: limitLength(row?.note, "基线差异说明无效", 1000),
    };
  });
}

function readProtocolState(projectId, id) {
  if (!/^prt_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的方案标识", 400);
  const entry = resource(protocolResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(protocolFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveProtocolRecord(projectId, existing, patch, { keepFrozen = false } = {}) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "方案标题不能为空", 200);
  if (!title) throw fault("方案标题不能为空", 400);
  const status = PROTOCOL_STATUS.includes(patch.status) ? patch.status : existing?.status || "draft";
  const record = {
    id: existing?.id || "prt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    sourceNote: limitLength(patch.sourceNote, "方案来源说明无效", 500),
    objective: limitLength(patch.objective, "验证目标无效", 4000),
    datasets: limitLength(patch.datasets, "数据与划分说明无效", 4000),
    metrics: limitLength(patch.metrics, "指标定义无效", 4000),
    budget: limitLength(patch.budget, "预算与停止条件无效", 2000),
    baselines: normalizeBaselines(patch.baselines ?? existing?.baselines),
    status,
    versions: existing?.versions || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(protocolFile(projectId, record.id), record, {
    id: protocolResourceId(record.id),
    kind: "research-protocol",
    title: "研究方案 · " + record.title,
    metadata: record,
  });
  return record;
}

export function listProtocols(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(protocolDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readProtocolState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getProtocol(projectId, id) {
  assertProject(projectId);
  const value = readProtocolState(projectId, id);
  if (!value) throw fault("研究方案不存在", 404);
  return value;
}

export function createProtocol(projectId, patch = {}) {
  assertProject(projectId);
  return saveProtocolRecord(projectId, null, patch);
}

export function updateProtocol(projectId, id, patch = {}) {
  const existing = getProtocol(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("研究方案已被其他修改更新，请刷新后重试", 409);
  return saveProtocolRecord(projectId, existing, patch);
}

export function freezeProtocol(projectId, id, { reason } = {}) {
  const existing = getProtocol(projectId, id);
  const record = { ...existing, status: "frozen" };
  record.versions = [
    ...(existing.versions || []),
    {
      index: (existing.versions?.length || 0) + 1,
      revision: existing.revision,
      frozenAt: new Date().toISOString(),
      reason: limitLength(reason, "冻结理由无效", 2000) || "未说明理由",
      snapshot: {
        objective: existing.objective,
        datasets: existing.datasets,
        metrics: existing.metrics,
        budget: existing.budget,
        baselines: existing.baselines,
      },
    },
  ];
  record.updatedAt = new Date().toISOString();
  record.revision = existing.revision + 1;
  writeJsonState(protocolFile(projectId, id), record, {
    id: protocolResourceId(id),
    kind: "research-protocol",
    title: "研究方案 · " + record.title,
    metadata: record,
  });
  return record;
}

export function deleteProtocol(projectId, id) {
  const existing = getProtocol(projectId, id);
  return trashPath(protocolFile(projectId, existing.id), {
    id: protocolResourceId(existing.id),
    kind: "research-protocol",
  });
}

// ---- 实验台账与运行记录（A05）：登记实际执行，成功与失败都留下记录 ----

const RUN_STATUS = ["succeeded", "failed", "stopped", "incomplete"];
const RUN_RELATION_TYPES = ["retry", "resume", "variant"];
export const experimentResourceId = (id) => "research-experiment:" + id;
export const runResourceId = (id) => "research-run:" + id;

const experimentDirectory = (projectId) => path.join(researchDir(projectId), "experiments");
const experimentFile = (projectId, id) => path.join(experimentDirectory(projectId), id + ".json");
const runDirectory = (projectId) => path.join(researchDir(projectId), "runs");
const runFile = (projectId, id) => path.join(runDirectory(projectId), id + ".json");

function normalizeMetricEntry(entry, { requireSource = false } = {}) {
  const name = limitLength(entry?.name, "指标名称无效", 100);
  if (!name) throw fault("指标必须有名称", 400);
  const value = Number(entry?.value);
  if (!Number.isFinite(value)) throw fault(`指标「${name}」的值必须是数字`, 400);
  const source = limitLength(entry?.source, "指标来源无效", 300);
  if (requireSource && !source) throw fault(`导入的指标「${name}」必须说明来源列或位置`, 400);
  return { name, value, unit: limitLength(entry?.unit, "指标单位无效", 50), source };
}

function normalizeMetrics(value, options) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("指标必须是列表", 400);
  if (value.length > 100) throw fault("单次运行最多登记 100 个指标", 400);
  return value.map((entry) => normalizeMetricEntry(entry, options));
}

function normalizeArtifacts(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("产物必须是列表", 400);
  if (value.length > 50) throw fault("单次运行最多登记 50 个产物", 400);
  return value.map((entry) => {
    const label = limitLength(entry?.label, "产物名称无效", 200);
    const target = limitLength(entry?.path, "产物路径无效", 1000);
    if (!label || !target) throw fault("产物必须同时有名称与路径", 400);
    return { label, path: target, managed: Boolean(entry?.managed), note: limitLength(entry?.note, "产物说明无效", 500) };
  });
}

function readExperimentState(projectId, id) {
  if (!/^exp_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的实验标识", 400);
  const entry = resource(experimentResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(experimentFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function readRunState(projectId, id) {
  if (!/^run_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的运行标识", 400);
  const entry = resource(runResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(runFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveExperimentRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "实验标题不能为空", 200);
  if (!title) throw fault("实验标题不能为空", 400);
  const protocolId = typeof patch.protocolId === "string" && patch.protocolId ? patch.protocolId : existing?.protocolId || "";
  if (protocolId) getProtocol(projectId, protocolId); // 引用的方案必须存在
  const groups = Array.isArray(patch.groups ?? existing?.groups)
    ? (patch.groups ?? existing?.groups).slice(0, 10).map((group, index) => ({
        name: limitLength(group?.name, "实验组名称无效", 100) || "组 " + (index + 1),
        note: limitLength(group?.note, "实验组说明无效", 500),
      }))
    : [];
  const record = {
    id: existing?.id || "exp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    purpose: limitLength(patch.purpose, "实验目的无效", 2000),
    protocolId,
    groups,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(experimentFile(projectId, record.id), record, {
    id: experimentResourceId(record.id),
    kind: "research-experiment",
    title: "实验 · " + record.title,
    metadata: record,
  });
  if (record.protocolId)
    link(experimentResourceId(record.id), protocolResourceId(record.protocolId), "uses");
  return record;
}

export function listExperiments(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(experimentDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readExperimentState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getExperiment(projectId, id) {
  assertProject(projectId);
  const value = readExperimentState(projectId, id);
  if (!value) throw fault("实验不存在", 404);
  return value;
}

export function createExperiment(projectId, patch = {}) {
  assertProject(projectId);
  return saveExperimentRecord(projectId, null, patch);
}

export function updateExperiment(projectId, id, patch = {}) {
  const existing = getExperiment(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("实验已被其他修改更新，请刷新后重试", 409);
  return saveExperimentRecord(projectId, existing, patch);
}

export function deleteExperiment(projectId, id) {
  const existing = getExperiment(projectId, id);
  // 只删除实验本身；运行记录是独立对象，保留在台账中供回查。
  return trashPath(experimentFile(projectId, existing.id), {
    id: experimentResourceId(existing.id),
    kind: "research-experiment",
  });
}

function saveRunRecord(projectId, existing, patch, { requireSource = false } = {}) {
  const now = new Date().toISOString();
  const label = limitLength(patch.label, "运行标识不能为空", 200);
  if (!label) throw fault("运行标识不能为空", 400);
  const experimentId = patch.experimentId ?? existing?.experimentId;
  const experiment = getExperiment(projectId, experimentId); // 运行必须挂在存在的实验下
  const status = RUN_STATUS.includes(patch.status) ? patch.status : existing?.status || "incomplete";
  let relation = existing?.relation || null;
  if (patch.relation !== undefined) {
    if (patch.relation == null) relation = null;
    else {
      if (!RUN_RELATION_TYPES.includes(patch.relation.type)) throw fault("运行关系必须是 retry、resume 或 variant", 400);
      const ofRun = getRun(projectId, patch.relation.ofRunId);
      if (existing && ofRun.id === existing.id) throw fault("运行不能关联自身", 400);
      relation = { type: patch.relation.type, ofRunId: ofRun.id };
    }
  }
  const record = {
    id: existing?.id || "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    experimentId: experiment.id,
    experimentTitle: experiment.title,
    label,
    status,
    config: {
      code: limitLength(patch.config?.code, "代码版本说明无效", 2000),
      data: limitLength(patch.config?.data, "数据说明无效", 2000),
      environment: limitLength(patch.config?.environment, "环境说明无效", 2000),
      seed: limitLength(patch.config?.seed, "种子说明无效", 200),
      notes: limitLength(patch.config?.notes, "配置备注无效", 2000),
    },
    metrics: normalizeMetrics(patch.metrics ?? existing?.metrics, { requireSource }),
    artifacts: normalizeArtifacts(patch.artifacts ?? existing?.artifacts),
    imported: Boolean(patch.imported ?? existing?.imported),
    error: limitLength(patch.error, "失败原因无效", 4000),
    relation,
    startedAt: limitLength(patch.startedAt, "开始时间无效", 40) || existing?.startedAt || "",
    finishedAt: limitLength(patch.finishedAt, "结束时间无效", 40) || existing?.finishedAt || "",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(runFile(projectId, record.id), record, {
    id: runResourceId(record.id),
    kind: "research-run",
    title: record.label + " · " + record.status,
    metadata: record,
  });
  link(runResourceId(record.id), experimentResourceId(experiment.id), "uses");
  if (relation)
    link(runResourceId(record.id), runResourceId(relation.ofRunId), "derives");
  return record;
}

export function listRuns(projectId, { experimentId } = {}) {
  assertProject(projectId);
  if (experimentId) getExperiment(projectId, experimentId);
  let names = [];
  try {
    names = fs.readdirSync(runDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readRunState(projectId, name.slice(0, -".json".length));
    if (value && (!experimentId || value.experimentId === experimentId)) rows.push(value);
  }
  rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return rows;
}

export function getRun(projectId, id) {
  assertProject(projectId);
  const value = readRunState(projectId, id);
  if (!value) throw fault("运行记录不存在", 404);
  return value;
}

export function createRun(projectId, patch = {}) {
  assertProject(projectId);
  return saveRunRecord(projectId, null, patch, { requireSource: Boolean(patch.imported) });
}

export function updateRun(projectId, id, patch = {}) {
  const existing = getRun(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("运行记录已被其他修改更新，请刷新后重试", 409);
  return saveRunRecord(projectId, existing, patch, { requireSource: Boolean(existing.imported) });
}

export function deleteRun(projectId, id) {
  const existing = getRun(projectId, id);
  return trashPath(runFile(projectId, existing.id), {
    id: runResourceId(existing.id),
    kind: "research-run",
  });
}

// ---- 结果比较与结论卡（A06）：比较口径显式保存，快照不随后续运行变化 ----

const CONCLUSION_KINDS = ["observation", "exploratory", "supported", "negative"];
export const comparisonResourceId = (id) => "research-comparison:" + id;
export const conclusionResourceId = (id) => "research-conclusion:" + id;

const comparisonDirectory = (projectId) => path.join(researchDir(projectId), "comparisons");
const comparisonFile = (projectId, id) => path.join(comparisonDirectory(projectId), id + ".json");
const conclusionDirectory = (projectId) => path.join(researchDir(projectId), "conclusions");
const conclusionFile = (projectId, id) => path.join(conclusionDirectory(projectId), id + ".json");

function comparisonRows(projectId, runIds, metricName) {
  // 保存瞬间的运行值快照：之后运行更新不会改写这里。
  const at = new Date().toISOString();
  return runIds.map((runId) => {
    const run = getRun(projectId, runId);
    const metric = (run.metrics || []).find((m) => m.name === metricName);
    return {
      runId,
      label: run.label,
      runStatus: run.status,
      value: metric ? metric.value : null,
      unit: metric?.unit || "",
      source: metric?.source || "",
      status: metric ? "value" : "missing",
      snapshottedAt: at,
    };
  });
}

function readComparisonState(projectId, id) {
  if (!/^cmp_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的比较标识", 400);
  const entry = resource(comparisonResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(comparisonFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveComparisonRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "比较标题不能为空", 200);
  const metricName = limitLength(patch.metricName, "比较指标不能为空", 100);
  if (!title) throw fault("比较标题不能为空", 400);
  if (!metricName) throw fault("比较必须指明指标", 400);
  const runIds = Array.isArray(patch.runIds ?? existing?.runIds) ? [...new Set(patch.runIds ?? existing?.runIds)] : [];
  if (!runIds.length) throw fault("比较至少选择一组运行", 400);
  if (runIds.length > 30) throw fault("单次比较最多纳入 30 个运行", 400);
  for (const runId of runIds) getRun(projectId, runId); // 纳入的运行必须存在
  const record = {
    id: existing?.id || "cmp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    metricName,
    runIds,
    inclusionNote: limitLength(patch.inclusionNote, "纳入与排除理由无效", 2000),
    comparabilityNote: limitLength(patch.comparabilityNote, "口径差异说明无效", 2000),
    rows: comparisonRows(projectId, runIds, metricName),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(comparisonFile(projectId, record.id), record, {
    id: comparisonResourceId(record.id),
    kind: "research-comparison",
    title: "比较 · " + record.title,
    metadata: record,
  });
  for (const runId of record.runIds)
    link(comparisonResourceId(record.id), runResourceId(runId), "uses");
  return record;
}

export function listComparisons(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(comparisonDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readComparisonState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getComparison(projectId, id) {
  assertProject(projectId);
  const value = readComparisonState(projectId, id);
  if (!value) throw fault("比较不存在", 404);
  return value;
}

export function createComparison(projectId, patch = {}) {
  assertProject(projectId);
  return saveComparisonRecord(projectId, null, patch);
}

export function updateComparison(projectId, id, patch = {}) {
  const existing = getComparison(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("比较已被其他修改更新，请刷新后重试", 409);
  return saveComparisonRecord(projectId, existing, patch);
}

export function deleteComparison(projectId, id) {
  const existing = getComparison(projectId, id);
  return trashPath(comparisonFile(projectId, existing.id), {
    id: comparisonResourceId(existing.id),
    kind: "research-comparison",
  });
}

const SUPPORT_KINDS = {
  run: (projectId, id) => getRun(projectId, id),
  comparison: (projectId, id) => getComparison(projectId, id),
  evidence: (projectId, id) => getEvidence(projectId, id),
  hypothesis: (projectId, id) => getHypothesis(projectId, id),
  matrix: (projectId, id) => getMatrix(projectId, id),
  protocol: (projectId, id) => getProtocol(projectId, id),
};

function normalizeSupport(value, projectId) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("结论依据必须是列表", 400);
  const refs = [];
  for (const entry of value.slice(0, 50)) {
    const kind = entry?.kind;
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!SUPPORT_KINDS[kind]) throw fault(`结论依据类型无效：${kind}`, 400);
    try {
      SUPPORT_KINDS[kind](projectId, id);
    } catch {
      throw fault(`结论依据不存在或已删除：${kind}:${id}`, 400);
    }
    const key = kind + ":" + id;
    if (!refs.some((ref) => ref.kind + ":" + ref.id === key)) refs.push({ kind, id });
  }
  return refs;
}

function readConclusionState(projectId, id) {
  if (!/^con_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的结论标识", 400);
  const entry = resource(conclusionResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(conclusionFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveConclusionRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const statement = limitLength(patch.statement, "结论表述不能为空", 4000);
  if (!statement) throw fault("结论表述不能为空", 400);
  const kind = CONCLUSION_KINDS.includes(patch.kind) ? patch.kind : existing?.kind;
  if (!kind) throw fault("结论必须区分 观察 / 探索性 / 得到支持 / 负结果", 400);
  const record = {
    id: existing?.id || "con_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    statement,
    kind,
    scope: limitLength(patch.scope, "适用范围无效", 1000),
    limits: limitLength(patch.limits, "结论限制无效", 2000),
    support: normalizeSupport(patch.support ?? existing?.support, projectId),
    checked: Boolean(patch.checked ?? existing?.checked ?? false),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(conclusionFile(projectId, record.id), record, {
    id: conclusionResourceId(record.id),
    kind: "research-conclusion",
    title: record.statement.slice(0, 40),
    metadata: record,
  });
  for (const ref of record.support) {
    const prefix = { run: runResourceId, comparison: comparisonResourceId, evidence: evidenceResourceId, hypothesis: hypothesisResourceId, matrix: matrixResourceId, protocol: protocolResourceId }[ref.kind];
    link(conclusionResourceId(record.id), prefix(ref.id), "uses");
  }
  return record;
}

export function listConclusions(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(conclusionDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readConclusionState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getConclusion(projectId, id) {
  assertProject(projectId);
  const value = readConclusionState(projectId, id);
  if (!value) throw fault("结论不存在", 404);
  return value;
}

export function createConclusion(projectId, patch = {}) {
  assertProject(projectId);
  return saveConclusionRecord(projectId, null, patch);
}

export function updateConclusion(projectId, id, patch = {}) {
  const existing = getConclusion(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("结论已被其他修改更新，请刷新后重试", 409);
  return saveConclusionRecord(projectId, existing, patch);
}

export function deleteConclusion(projectId, id) {
  const existing = getConclusion(projectId, id);
  return trashPath(conclusionFile(projectId, existing.id), {
    id: conclusionResourceId(existing.id),
    kind: "research-conclusion",
  });
}

// ---- 写作引用助手与稿件登记（A07）：稿件记录只引用原文件，不移动不重写 ----

export const manuscriptResourceId = (id) => "research-manuscript:" + id;
const manuscriptDirectory = (projectId) => path.join(researchDir(projectId), "manuscripts");
const manuscriptFile = (projectId, id) => path.join(manuscriptDirectory(projectId), id + ".json");

function paperCitation(paper) {
  return {
    paperId: paper.id,
    title: paper.title || "",
    authors: Array.isArray(paper.creators) ? paper.creators.map(String).slice(0, 20) : [],
    year: paper.year || null,
    doi: paper.doi || "",
  };
}

function suggestCitationKey(citation, existingKeys) {
  const surname = (citation.authors[0] || "").trim().split(/\s+/).at(-1) || "";
  const word = (citation.title.match(/[A-Za-z]+/) || citation.title.match(/[\u4e00-\u9fa5]+/) || ["item"])[0];
  const base = ((surname || word) + (citation.year || "nd") + word)
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "")
    .slice(0, 40) || "ref";
  let key = base;
  for (let i = 2; existingKeys.has(key); i++) key = base + "_" + i;
  return key;
}

function toBibtex(citations) {
  return citations.map((c) =>
    [
      "@misc{" + c.key + ",",
      "  title = {" + (c.title || "无标题") + "},",
      "  author = {" + (c.authors || []).join(" and ") + "},",
      "  year = {" + (c.year || "") + "},",
      c.doi ? "  doi = {" + c.doi + "}," : null,
      "}",
    ].filter(Boolean).join("\n"),
  ).join("\n\n");
}

function readManuscriptState(projectId, id) {
  if (!/^man_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的稿件标识", 400);
  const entry = resource(manuscriptResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(manuscriptFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveManuscriptRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "稿件标题不能为空", 200);
  if (!title) throw fault("稿件标题不能为空", 400);
  const citations = Array.isArray(patch.citations ?? existing?.citations) ? (patch.citations ?? existing?.citations).slice(0, 200) : [];
  const record = {
    id: existing?.id || "man_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    filePath: limitLength(patch.filePath, "稿件路径无效", 500),
    fileKind: patch.fileKind === "latex" ? "latex" : "markdown",
    citations,
    linkedConclusions: Array.isArray(patch.linkedConclusions ?? existing?.linkedConclusions)
      ? [...new Set(patch.linkedConclusions ?? existing?.linkedConclusions)].slice(0, 50)
      : [],
    snapshots: existing?.snapshots || [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  for (const citation of record.citations) {
    if (typeof citation?.key !== "string" || !citation.key) throw fault("引用条目缺少引用键", 400);
    if (citation.paperId) getPaper(citation.paperId); // 引用的论文必须仍在文献库
  }
  for (const conclusionId of record.linkedConclusions) getConclusion(projectId, conclusionId);
  writeJsonState(manuscriptFile(projectId, record.id), record, {
    id: manuscriptResourceId(record.id),
    kind: "research-manuscript",
    title: "稿件 · " + record.title,
    metadata: record,
  });
  for (const citation of record.citations)
    link(manuscriptResourceId(record.id), "paper:" + citation.paperId, "uses");
  for (const conclusionId of record.linkedConclusions)
    link(manuscriptResourceId(record.id), conclusionResourceId(conclusionId), "uses");
  return record;
}

export function listManuscripts(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(manuscriptDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readManuscriptState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getManuscript(projectId, id) {
  assertProject(projectId);
  const value = readManuscriptState(projectId, id);
  if (!value) throw fault("稿件不存在", 404);
  return value;
}

export function createManuscript(projectId, patch = {}) {
  assertProject(projectId);
  return saveManuscriptRecord(projectId, null, patch);
}

export function updateManuscript(projectId, id, patch = {}) {
  const existing = getManuscript(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("稿件记录已被其他修改更新，请刷新后重试", 409);
  return saveManuscriptRecord(projectId, existing, patch);
}

export function addManuscriptCitation(projectId, id, { paperId, key } = {}) {
  const existing = getManuscript(projectId, id);
  const paper = getPaper(typeof paperId === "string" ? paperId : "");
  if (!paper) throw fault("引用的论文不存在", 404);
  const keys = new Set(existing.citations.map((c) => c.key));
  if (key != null) {
    const requested = limitLength(key, "引用键无效", 100);
    if (keys.has(requested)) throw fault(`引用键 ${requested} 已存在，不会静默覆盖`, 409);
    keys.add(requested);
    const citation = { key: requested, ...paperCitation(paper) };
    return saveManuscriptRecord(projectId, existing, { ...existing, citations: [...existing.citations, citation] });
  }
  const citation = { key: suggestCitationKey(paperCitation(paper), keys), ...paperCitation(paper) };
  return saveManuscriptRecord(projectId, existing, { ...existing, citations: [...existing.citations, citation] });
}

export function removeManuscriptCitation(projectId, id, key) {
  const existing = getManuscript(projectId, id);
  const next = existing.citations.filter((c) => c.key !== key);
  if (next.length === existing.citations.length) throw fault("引用条目不存在", 404);
  return saveManuscriptRecord(projectId, existing, { ...existing, citations: next });
}

export function toggleManuscriptConclusion(projectId, id, { conclusionId, remove } = {}) {
  const existing = getManuscript(projectId, id);
  if (remove) {
    const next = existing.linkedConclusions.filter((c) => c !== conclusionId);
    if (next.length === existing.linkedConclusions.length) throw fault("结论关联不存在", 404);
    return saveManuscriptRecord(projectId, existing, { ...existing, linkedConclusions: next });
  }
  getConclusion(projectId, typeof conclusionId === "string" ? conclusionId : "");
  if (existing.linkedConclusions.includes(conclusionId)) return existing;
  return saveManuscriptRecord(projectId, existing, { ...existing, linkedConclusions: [...existing.linkedConclusions, conclusionId] });
}

export function manuscriptBib(projectId, id) {
  const existing = getManuscript(projectId, id);
  return { bib: toBibtex(existing.citations), count: existing.citations.length };
}

export function snapshotManuscript(projectId, id) {
  const existing = getManuscript(projectId, id);
  const now = new Date().toISOString();
  const snapshot = {
    at: now,
    bib: toBibtex(existing.citations),
    citations: existing.citations,
    linkedConclusions: existing.linkedConclusions,
  };
  // 快照只在此处追加；普通保存不接触 snapshots，历史快照不被后续元数据更新改写。
  const record = {
    ...existing,
    snapshots: [...(existing.snapshots || []), snapshot].slice(-50),
    updatedAt: now,
    revision: existing.revision + 1,
  };
  writeJsonState(manuscriptFile(projectId, id), record, {
    id: manuscriptResourceId(id),
    kind: "research-manuscript",
    title: "稿件 · " + record.title,
    metadata: record,
  });
  return record;
}

export function checkManuscript(projectId, id) {
  const existing = getManuscript(projectId, id);
  const seen = new Map();
  const duplicates = [];
  for (const citation of existing.citations) {
    if (seen.has(citation.key)) duplicates.push(citation.key);
    seen.set(citation.key, citation);
  }
  const missing = existing.citations.filter((c) => !getPaper(c.paperId)).map((c) => c.key);
  const missingConclusions = existing.linkedConclusions.filter((c) => {
    try { getConclusion(projectId, c); return false; } catch { return true; }
  });
  return { missing, duplicates, missingConclusions, total: existing.citations.length };
}

export function deleteManuscript(projectId, id) {
  const existing = getManuscript(projectId, id);
  return trashPath(manuscriptFile(projectId, existing.id), {
    id: manuscriptResourceId(existing.id),
    kind: "research-manuscript",
  });
}

// ---- 基于已有成果的二次选题（A09）：输入快照、未解问题与候选方向 ----

const RESELECTION_CHOICES = ["continue", "shrink", "pivot", "stop"];
export const reselectionResourceId = (id) => "research-reselection:" + id;

const reselectionDirectory = (projectId) => path.join(researchDir(projectId), "reselections");
const reselectionFile = (projectId, id) => path.join(reselectionDirectory(projectId), id + ".json");

// 输入快照引用的项目内记录：类型 → 读取校验函数
const RESELECTION_SOURCES = {
  hypothesis: getHypothesis,
  conclusion: getConclusion,
  run: getRun,
  matrix: getMatrix,
  protocol: getProtocol,
  comparison: getComparison,
};

function normalizeContextRefs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("二次选题输入必须是引用列表", 400);
  const refs = [];
  for (const entry of value.slice(0, 100)) {
    const kind = entry?.kind;
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!RESELECTION_SOURCES[kind]) throw fault(`二次选题输入类型无效：${kind}`, 400);
    refs.push({ kind, id });
  }
  return refs;
}

// 保存输入快照：记录当时这些对象的关键内容，后续记录变化不影响本轮分析依据。
function snapshotContext(projectId, refs) {
  return refs.map((ref) => {
    const record = RESELECTION_SOURCES[ref.kind](projectId, ref.id);
    const summary = {
      hypothesis: () => ({ title: record.title, decision: record.decision?.status || null, statement: record.statement }),
      conclusion: () => ({ kind: record.kind, statement: record.statement, checked: record.checked }),
      run: () => ({ label: record.label, status: record.status, error: record.error || "" }),
      matrix: () => ({ title: record.title, conditions: record.conditions || "" }),
      protocol: () => ({ title: record.title, status: record.status }),
      comparison: () => ({ title: record.title, metricName: record.metricName, comparabilityNote: record.comparabilityNote || "" }),
    }[ref.kind]();
    return { kind: ref.kind, id: ref.id, summary };
  });
}

function normalizeOpenQuestions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("未解问题必须是列表", 400);
  return value.slice(0, 30).map((entry, index) => {
    const text = limitLength(entry?.text, "未解问题不能为空", 500);
    if (!text) throw fault(`第 ${index + 1} 个未解问题为空`, 400);
    return {
      id: ID_PATTERN.test(entry?.id || "") ? entry.id : "q_" + (index + 1) + "_" + Date.now().toString(36),
      text,
      category: ["open", "failed", "insufficient-evidence", "new"].includes(entry?.category) ? entry.category : "open",
      sourceRef: entry?.sourceRef && RESELECTION_SOURCES[entry.sourceRef.kind] ? { kind: entry.sourceRef.kind, id: String(entry.sourceRef.id) } : null,
    };
  });
}

function normalizeCandidates(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("候选方向必须是列表", 400);
  return value.slice(0, 20).map((entry, index) => {
    const text = limitLength(entry?.text, "候选方向不能为空", 1000);
    if (!text) throw fault(`第 ${index + 1} 个候选方向为空`, 400);
    const basedOn = normalizeContextRefs(entry?.basedOn);
    return {
      id: ID_PATTERN.test(entry?.id || "") ? entry.id : "cand_" + (index + 1) + "_" + Date.now().toString(36),
      text,
      rationale: limitLength(entry?.rationale, "候选理由无效", 2000),
      basedOn,
      verification: limitLength(entry?.verification, "验证动作说明无效", 1000),
      createdHypothesisId: typeof entry?.createdHypothesisId === "string" ? entry.createdHypothesisId : "",
      createdProtocolId: typeof entry?.createdProtocolId === "string" ? entry.createdProtocolId : "",
    };
  });
}

function readReselectionState(projectId, id) {
  if (!/^rs_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的二次选题标识", 400);
  const entry = resource(reselectionResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(reselectionFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveReselectionRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const title = limitLength(patch.title, "二次选题标题不能为空", 200);
  if (!title) throw fault("二次选题标题不能为空", 400);
  const contextRefs = normalizeContextRefs(patch.contextRefs ?? existing?.contextRefs);
  // 引用的记录必须当前存在（快照只保存摘要，不复制全文）。
  for (const ref of contextRefs) RESELECTION_SOURCES[ref.kind](projectId, ref.id);
  const candidates = normalizeCandidates(patch.candidates ?? existing?.candidates);
  for (const candidate of candidates)
    for (const ref of candidate.basedOn) RESELECTION_SOURCES[ref.kind](projectId, ref.id);
  let decision = existing?.decision || null;
  if (patch.decision !== undefined) {
    decision = patch.decision == null ? null : {
      choice: RESELECTION_CHOICES.includes(patch.decision.choice)
        ? patch.decision.choice
        : (() => { throw fault("研究决定必须是 continue、shrink、pivot 或 stop", 400); })(),
      reason: limitLength(patch.decision.reason, "决定理由无效", 2000),
      at: new Date().toISOString(),
    };
  }
  const record = {
    id: existing?.id || "rs_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    note: limitLength(patch.note, "补充说明无效", 2000),
    contextRefs,
    contextSnapshot: existing?.contextRefs && JSON.stringify(existing.contextRefs) === JSON.stringify(contextRefs)
      ? existing.contextSnapshot
      : snapshotContext(projectId, contextRefs),
    openQuestions: normalizeOpenQuestions(patch.openQuestions ?? existing?.openQuestions),
    candidates,
    decision,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(reselectionFile(projectId, record.id), record, {
    id: reselectionResourceId(record.id),
    kind: "research-reselection",
    title: "二次选题 · " + record.title,
    metadata: record,
  });
  return record;
}

export function listReselections(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(reselectionDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readReselectionState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getReselection(projectId, id) {
  assertProject(projectId);
  const value = readReselectionState(projectId, id);
  if (!value) throw fault("二次选题记录不存在", 404);
  return value;
}

export function createReselection(projectId, patch = {}) {
  assertProject(projectId);
  return saveReselectionRecord(projectId, null, patch);
}

export function updateReselection(projectId, id, patch = {}) {
  const existing = getReselection(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("二次选题记录已被其他修改更新，请刷新后重试", 409);
  return saveReselectionRecord(projectId, existing, patch);
}

// 回写：从候选方向建立下一轮研究草稿（新假设或新方案），不覆盖原记录。
export function draftFromCandidate(projectId, id, { candidateId, target } = {}) {
  const existing = getReselection(projectId, id);
  const candidate = existing.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw fault("候选方向不存在", 404);
  if (candidate.createdHypothesisId || candidate.createdProtocolId)
    throw fault("该候选已建立草稿，不会重复创建", 409);
  const sourceNote = "二次选题 · " + existing.title + "（候选：" + candidate.text.slice(0, 60) + "）";
  const next = { ...existing, candidates: existing.candidates.map((c) => ({ ...c })) };
  const index = next.candidates.findIndex((c) => c.id === candidateId);
  if (target === "protocol") {
    const protocol = createProtocol(projectId, {
      title: candidate.text.slice(0, 200),
      sourceNote,
      objective: candidate.rationale + (candidate.verification ? "；验证动作：" + candidate.verification : ""),
    });
    next.candidates[index].createdProtocolId = protocol.id;
    saveReselectionRecord(projectId, next, next);
    return { draft: { kind: "protocol", id: protocol.id } };
  }
  const hypothesis = createHypothesis(projectId, {
    title: candidate.text.slice(0, 200),
    statement: candidate.rationale || candidate.text,
    sourceNote,
    prediction: candidate.verification,
  });
  next.candidates[index].createdHypothesisId = hypothesis.id;
  saveReselectionRecord(projectId, next, next);
  return { draft: { kind: "hypothesis", id: hypothesis.id } };
}

export function deleteReselection(projectId, id) {
  const existing = getReselection(projectId, id);
  return trashPath(reselectionFile(projectId, existing.id), {
    id: reselectionResourceId(existing.id),
    kind: "research-reselection",
  });
}

// ---- 投稿与审稿修订台账（A10）：轮次、意见拆解与处置对应 ----

const SUBMISSION_STATUS = ["preparing", "submitted", "under-review", "revision", "accepted", "rejected", "withdrawn"];
const COMMENT_CATEGORIES = ["explain", "revise", "experiment", "other"];
const DISPOSITION_STATUS = ["pending", "done", "declined"];
export const submissionResourceId = (id) => "research-submission:" + id;

const submissionDirectory = (projectId) => path.join(researchDir(projectId), "submissions");
const submissionFile = (projectId, id) => path.join(submissionDirectory(projectId), id + ".json");

function normalizeSubmissionTarget(value) {
  const target = typeof value === "string" ? value.trim() : "";
  if (!target) throw fault("投稿目标（期刊/会议）不能为空", 400);
  return limitLength(target, "投稿目标无效", 300);
}

function normalizeMaterials(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("提交材料必须是列表", 400);
  return value.slice(0, 30).map((entry, index) => ({
    label: limitLength(entry?.label, "材料名称不能为空", 200) || (() => { throw fault(`第 ${index + 1} 项材料缺少名称`, 400); })(),
    note: limitLength(entry?.note, "材料说明无效", 500),
    kind: ["prepared", "submitted"].includes(entry?.kind) ? entry.kind : "prepared",
  }));
}

// 意见处置可引用的记录类型：补充实验、新结论或稿件修改说明
const DISPOSITION_REFS = {
  run: getRun,
  conclusion: getConclusion,
  manuscript: getManuscript,
};

function normalizeComments(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fault("审稿意见必须是列表", 400);
  return value.slice(0, 100).map((entry, index) => {
    const text = limitLength(entry?.text, "意见内容不能为空", 4000);
    if (!text) throw fault(`第 ${index + 1} 条意见为空`, 400);
    const refs = [];
    for (const ref of Array.isArray(entry?.disposition?.refs) ? entry.disposition.refs : []) {
      if (!DISPOSITION_REFS[ref?.kind]) throw fault(`意见处置引用类型无效：${ref?.kind}`, 400);
      refs.push({ kind: ref.kind, id: String(ref.id || "") });
    }
    return {
      id: ID_PATTERN.test(entry?.id || "") ? entry.id : "cm_" + (index + 1) + "_" + Date.now().toString(36),
      text,
      category: COMMENT_CATEGORIES.includes(entry?.category) ? entry.category : "other",
      disposition: {
        status: DISPOSITION_STATUS.includes(entry?.disposition?.status) ? entry.disposition.status : "pending",
        note: limitLength(entry?.disposition?.note, "处置说明无效", 2000),
        refs,
      },
    };
  });
}

function readSubmissionState(projectId, id) {
  if (!/^sub_[A-Za-z0-9_-]{1,64}$/.test(id || "")) throw fault("无效的投稿标识", 400);
  const entry = resource(submissionResourceId(id));
  if (entry && entry.lifecycle !== "active") return null;
  try {
    return readJsonState(submissionFile(projectId, id), null);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function saveSubmissionRecord(projectId, existing, patch) {
  const now = new Date().toISOString();
  const status = SUBMISSION_STATUS.includes(patch.status) ? patch.status : existing?.status || "preparing";
  const manuscriptId = typeof patch.manuscriptId === "string" ? patch.manuscriptId : existing?.manuscriptId || "";
  if (manuscriptId) getManuscript(projectId, manuscriptId); // 关联的稿件记录必须存在
  const round = Number(patch.round ?? existing?.round) || 1;
  if (!Number.isInteger(round) || round < 1 || round > 50) throw fault("投稿轮次无效", 400);
  const comments = normalizeComments(patch.comments ?? existing?.comments);
  for (const comment of comments)
    for (const ref of comment.disposition.refs)
      DISPOSITION_REFS[ref.kind](projectId, ref.id); // 处置引用必须存在
  const record = {
    id: existing?.id || "sub_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    projectId,
    round,
    manuscriptId,
    target: normalizeSubmissionTarget(patch.target ?? existing?.target),
    status,
    dates: {
      preparedAt: limitLength(patch.dates?.preparedAt ?? existing?.dates?.preparedAt, "准备时间无效", 40),
      submittedAt: limitLength(patch.dates?.submittedAt ?? existing?.dates?.submittedAt, "提交时间无效", 40),
      decisionAt: limitLength(patch.dates?.decisionAt ?? existing?.dates?.decisionAt, "结果时间无效", 40),
    },
    materials: normalizeMaterials(patch.materials ?? existing?.materials),
    comments,
    outcomeNote: limitLength(patch.outcomeNote ?? existing?.outcomeNote, "结局说明无效", 2000),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    revision: (existing?.revision || 0) + 1,
  };
  writeJsonState(submissionFile(projectId, record.id), record, {
    id: submissionResourceId(record.id),
    kind: "research-submission",
    title: "投稿 · " + record.target + " 第 " + record.round + " 轮",
    metadata: record,
  });
  if (record.manuscriptId)
    link(submissionResourceId(record.id), manuscriptResourceId(record.manuscriptId), "uses");
  return record;
}

export function listSubmissions(projectId) {
  assertProject(projectId);
  let names = [];
  try {
    names = fs.readdirSync(submissionDirectory(projectId)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const value = readSubmissionState(projectId, name.slice(0, -".json".length));
    if (value) rows.push(value);
  }
  rows.sort((a, b) => (b.round || 1) - (a.round || 1) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return rows;
}

export function getSubmission(projectId, id) {
  assertProject(projectId);
  const value = readSubmissionState(projectId, id);
  if (!value) throw fault("投稿记录不存在", 404);
  return value;
}

export function createSubmission(projectId, patch = {}) {
  assertProject(projectId);
  return saveSubmissionRecord(projectId, null, patch);
}

export function updateSubmission(projectId, id, patch = {}) {
  const existing = getSubmission(projectId, id);
  if (patch.revision != null && Number(patch.revision) !== existing.revision)
    throw fault("投稿记录已被其他修改更新，请刷新后重试", 409);
  return saveSubmissionRecord(projectId, existing, patch);
}

// 粘贴审稿意见：按空行分段拆成意见草稿，等待用户分类与处置（只创建草稿，不对外回复）。
export function importReviewComments(projectId, id, { text } = {}) {
  const existing = getSubmission(projectId, id);
  const source = limitLength(text, "意见文本无效", 50000);
  if (!source) throw fault("意见文本不能为空", 400);
  const paragraphs = source.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 100);
  if (!paragraphs.length) throw fault("没有可拆解的意见段落", 400);
  const comments = paragraphs.map((paragraph, index) => ({
    id: "cm_" + (index + 1) + "_" + Date.now().toString(36),
    text: paragraph,
    category: "other",
    disposition: { status: "pending", note: "", refs: [] },
  }));
  return saveSubmissionRecord(projectId, existing, { ...existing, comments: [...existing.comments, ...comments] });
}

export function submissionChecklist(projectId, id) {
  const existing = getSubmission(projectId, id);
  const pending = existing.comments.filter((c) => c.disposition.status === "pending");
  const preparedNotSubmitted = existing.materials.filter((m) => m.kind === "prepared");
  return {
    totalComments: existing.comments.length,
    pending: pending.map((c) => c.id),
    preparedNotSubmitted: preparedNotSubmitted.map((m) => m.label),
    status: existing.status,
    hasSubmittedAt: Boolean(existing.dates.submittedAt),
  };
}

export function deleteSubmission(projectId, id) {
  const existing = getSubmission(projectId, id);
  return trashPath(submissionFile(projectId, existing.id), {
    id: submissionResourceId(existing.id),
    kind: "research-submission",
  });
}

// ---- 基础导出与导入（B1.6）：新增研究记录可整体打包、在项目中恢复 ----

export const RESEARCH_SCHEMA_VERSION = 1;

function writeImportedRecord(file, resourceId, kind, title, record) {
  writeJsonState(file, record, { id: resourceId, kind, title, metadata: record });
}

export function exportBundle(projectId) {
  const project = assertProject(projectId);
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name },
    profile: loadProfile(projectId),
    evidence: listEvidence(projectId),
    matrices: listMatrices(projectId),
    hypotheses: listHypotheses(projectId),
    protocols: listProtocols(projectId),
    experiments: listExperiments(projectId),
    runs: listRuns(projectId),
    comparisons: listComparisons(projectId),
    conclusions: listConclusions(projectId),
    manuscripts: listManuscripts(projectId),
    reselections: listReselections(projectId),
    submissions: listSubmissions(projectId),
  };
}

// ---- 完整课题包（A08）：包含/排除清单与校验和明确的可移植包 ----

const BUNDLE_SECTIONS = [
  ["profile", (b) => (b?.profile ? [b.profile] : [])],
  ["evidence", (b) => b?.evidence || []],
  ["matrices", (b) => b?.matrices || []],
  ["hypotheses", (b) => b?.hypotheses || []],
  ["protocols", (b) => b?.protocols || []],
  ["experiments", (b) => b?.experiments || []],
  ["runs", (b) => b?.runs || []],
  ["comparisons", (b) => b?.comparisons || []],
  ["conclusions", (b) => b?.conclusions || []],
  ["manuscripts", (b) => b?.manuscripts || []],
  ["reselections", (b) => b?.reselections || []],
  ["submissions", (b) => b?.submissions || []],
];

function bundleChecksums(bundle) {
  const checksums = {};
  for (const [key, get] of BUNDLE_SECTIONS)
    checksums[key] = createHash("sha256").update(JSON.stringify(get(bundle))).digest("hex").slice(0, 16);
  return checksums;
}

export function exportProjectBundle(projectId) {
  const project = assertProject(projectId);
  const bundle = exportBundle(projectId);
  bundle.scope = "project";
  // 文献元数据清单随包导出；PDF 原文与外部文件明确排除。
  bundle.papers = project.paperIds.map((paperId) => {
    const paper = getPaper(paperId);
    return paper
      ? { id: paper.id, title: paper.title, creators: paper.creators || [], year: paper.year || null, doi: paper.doi || "", contentHash: paper.contentHash || "" }
      : { id: paperId, title: "", missing: true };
  });
  const manuscriptPaths = bundle.manuscripts.map((m) => m.filePath).filter(Boolean);
  bundle.manifest = {
    generatedAt: bundle.exportedAt,
    included: [
      { kind: "研究记录", detail: "档案、证据、对比表、假设、方案（含冻结版本）、实验、运行、比较快照、结论、稿件记录" },
      { kind: "文献元数据", detail: bundle.papers.length + " 篇（不含 PDF 原文）" },
    ],
    excluded: [
      { kind: "PDF 原文", reason: "受管原文文件不随包复制；恢复后按 contentHash 在目标库匹配，未匹配的论文标记为缺原文" },
      { kind: "知识索引与解析产物", reason: "可在目标环境重新入库或重建" },
      { kind: "运行产物与外部文件", reason: manuscriptPaths.length ? "稿件引用的外部路径：" + manuscriptPaths.join("、") : "无稿件文件引用" },
      { kind: "凭据与服务配置", reason: "凭据默认不进入课题包" },
    ],
    checksums: bundleChecksums(bundle),
  };
  return bundle;
}

function verifyBundleChecksums(bundle) {
  if (!bundle.manifest?.checksums) return null; // 研究记录包：跳过校验
  const expected = bundleChecksums(bundle);
  for (const [key, sum] of Object.entries(bundle.manifest.checksums))
    if (expected[key] !== sum) throw fault(`课题包校验失败：${key} 与清单不符，文件可能损坏或被改动`, 400);
  return expected;
}

function paperReport(papers) {
  // 恢复报告：哪些论文在目标库可用（按 contentHash 或 ID 匹配），哪些缺原文。
  return (Array.isArray(papers) ? papers : []).map((paper) => {
    const byHash = paper.contentHash ? findByHash(paper.contentHash) : null;
    const byId = getPaper(paper.id);
    const found = byHash || byId;
    return {
      id: paper.id,
      title: paper.title || found?.title || "",
      status: found ? "available" : "missing",
      matchedBy: byHash ? "contentHash" : byId ? "id" : null,
    };
  });
}

function importedRevision(existing, incoming) {
  return Math.max(existing?.revision || 0, incoming.revision || 0) + 1;
}

function importProfileRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const next = {
    projectId,
    question: limitText(data.question, "question"),
    scope: limitText(data.scope, "scope"),
    goal: limitText(data.goal, "goal"),
    constraints: limitText(data.constraints, "constraints"),
    outcomes: normalizeList(data.outcomes, resolveOutcome, 100, "成果关联"),
    actions: normalizeList(data.actions, normalizeAction, 200, "行动项"),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : existing?.createdAt || now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  writeImportedRecord(profileFile(projectId), profileId(projectId), "research-profile",
    "研究档案 · " + (getProject(projectId)?.name || projectId), next);
  link(profileId(projectId), "project:" + projectId, "uses");
  return { saved: next };
}

function importEvidenceRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const content = limitLength(data.content, "证据内容不能为空", 8000);
  if (!content) throw fault("导入的证据缺少内容", 400);
  const record = {
    id: existing?.id || data.id,
    projectId,
    type: EVIDENCE_TYPES.includes(data.type) ? data.type : "fact",
    content,
    note: limitLength(data.note, "证据备注无效", 2000),
    conditions: limitLength(data.conditions, "适用条件无效", 2000),
    checked: Boolean(data.checked),
    source: normalizeEvidenceSource(data.source),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^ev_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的证据标识无效", 400);
  writeImportedRecord(evidenceFile(projectId, record.id), evidenceResourceId(record.id),
    "research-evidence", record.content.slice(0, 40), record);
  if (record.source.kind === "paper")
    link(evidenceResourceId(record.id), "paper:" + record.source.paperId, "uses");
  else if (record.source.kind === "retrieval" && record.source.resourceId)
    link(evidenceResourceId(record.id), record.source.resourceId, "uses");
  return { saved: record };
}

function importMatrixRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的对比表缺少标题", 200);
  if (!title) throw fault("导入的对比表缺少标题", 400);
  const paperIds = normalizeMatrixPapers(data.paperIds);
  const columns = normalizeColumns(data.columns);
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    conditions: limitLength(data.conditions, "比较条件说明无效", 2000),
    paperIds,
    columns,
    cells: normalizeCells(data.cells, paperIds, columns),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^mtx_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的对比表标识无效", 400);
  writeImportedRecord(matrixFile(projectId, record.id), matrixResourceId(record.id),
    "research-matrix", "对比表 · " + record.title, record);
  for (const paperId of record.paperIds)
    link(matrixResourceId(record.id), "paper:" + paperId, "uses");
  return { saved: record };
}

function importHypothesisRecord(projectId, data, existing, force) {  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的假设缺少标题", 200);
  const statement = limitLength(data.statement, "导入的假设缺少内容", 4000);
  if (!title || !statement) throw fault("导入的假设缺少标题或内容", 400);
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    statement,
    prediction: limitLength(data.prediction, "预测描述无效", 2000),
    scope: limitLength(data.scope, "作用范围无效", 1000),
    counterExamples: limitLength(data.counterExamples, "反例与替代解释无效", 2000),
    unknowns: limitLength(data.unknowns, "未知项说明无效", 1000),
    support: normalizeEvidenceRefs(data.support, projectId, "支持证据"),
    oppose: normalizeEvidenceRefs(data.oppose, projectId, "反对证据"),
    decision: data.decision && DECISION_STATUS.includes(data.decision.status)
      ? {
          status: data.decision.status,
          reason: limitLength(data.decision.reason, "决策理由无效", 2000),
          at: typeof data.decision.at === "string" ? data.decision.at : now,
        }
      : null,
    decisionHistory: Array.isArray(data.decisionHistory)
      ? data.decisionHistory
        .filter((entry) => entry && DECISION_STATUS.includes(entry.status))
        .map((entry) => ({ at: entry.at, status: entry.status, reason: limitLength(entry.reason, "决策理由无效", 2000) }))
        .slice(0, 100)
      : [],
    sourceNote: limitLength(data.sourceNote, "来源说明无效", 500),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^hyp_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的假设标识无效", 400);
  writeImportedRecord(hypothesisFile(projectId, record.id), hypothesisResourceId(record.id),
    "research-hypothesis", "假设 · " + record.title, record);
  for (const evidenceIdValue of [...record.support, ...record.oppose])
    link(hypothesisResourceId(record.id), evidenceResourceId(evidenceIdValue), "uses");
  return { saved: record };
}

function importProtocolRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的方案缺少标题", 200);
  if (!title) throw fault("导入的方案缺少标题", 400);
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    sourceNote: limitLength(data.sourceNote, "方案来源说明无效", 500),
    objective: limitLength(data.objective, "验证目标无效", 4000),
    datasets: limitLength(data.datasets, "数据与划分说明无效", 4000),
    metrics: limitLength(data.metrics, "指标定义无效", 4000),
    budget: limitLength(data.budget, "预算与停止条件无效", 2000),
    baselines: normalizeBaselines(data.baselines),
    status: PROTOCOL_STATUS.includes(data.status) ? data.status : "draft",
    versions: Array.isArray(data.versions) ? data.versions.slice(0, 50) : [],
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^prt_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的方案标识无效", 400);
  writeImportedRecord(protocolFile(projectId, record.id), protocolResourceId(record.id),
    "research-protocol", "研究方案 · " + record.title, record);
  return { saved: record };
}

function importExperimentRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的实验缺少标题", 200);
  if (!title) throw fault("导入的实验缺少标题", 400);
  const protocolId = typeof data.protocolId === "string" ? data.protocolId : "";
  if (protocolId) getProtocol(projectId, protocolId);
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    purpose: limitLength(data.purpose, "实验目的无效", 2000),
    protocolId,
    groups: Array.isArray(data.groups) ? data.groups.slice(0, 10).map((group, index) => ({
      name: limitLength(group?.name, "实验组名称无效", 100) || "组 " + (index + 1),
      note: limitLength(group?.note, "实验组说明无效", 500),
    })) : [],
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^exp_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的实验标识无效", 400);
  writeImportedRecord(experimentFile(projectId, record.id), experimentResourceId(record.id),
    "research-experiment", "实验 · " + record.title, record);
  if (record.protocolId)
    link(experimentResourceId(record.id), protocolResourceId(record.protocolId), "uses");
  return { saved: record };
}

function importRunRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const label = limitLength(data.label, "导入的运行缺少标识", 200);
  if (!label) throw fault("导入的运行缺少标识", 400);
  const experimentId = typeof data.experimentId === "string" ? data.experimentId : "";
  const experiment = getExperiment(projectId, experimentId);
  let relation = null;
  let pendingRelation = null;
  if (data.relation && RUN_RELATION_TYPES.includes(data.relation.type) && typeof data.relation.ofRunId === "string") {
    try {
      getRun(projectId, data.relation.ofRunId);
      relation = { type: data.relation.type, ofRunId: data.relation.ofRunId };
    } catch {
      pendingRelation = { runId: data.id, type: data.relation.type, ofRunId: data.relation.ofRunId }; // 批内后置运行，第二遍补
    }
  }
  const record = {
    id: existing?.id || data.id,
    projectId,
    experimentId: experiment.id,
    experimentTitle: experiment.title,
    label,
    status: RUN_STATUS.includes(data.status) ? data.status : "incomplete",
    config: {
      code: limitLength(data.config?.code, "代码版本说明无效", 2000),
      data: limitLength(data.config?.data, "数据说明无效", 2000),
      environment: limitLength(data.config?.environment, "环境说明无效", 2000),
      seed: limitLength(data.config?.seed, "种子说明无效", 200),
      notes: limitLength(data.config?.notes, "配置备注无效", 2000),
    },
    metrics: normalizeMetrics(data.metrics, { requireSource: Boolean(data.imported) }),
    artifacts: normalizeArtifacts(data.artifacts),
    imported: Boolean(data.imported),
    error: limitLength(data.error, "失败原因无效", 4000),
    relation,
    startedAt: limitLength(data.startedAt, "开始时间无效", 40) || "",
    finishedAt: limitLength(data.finishedAt, "结束时间无效", 40) || "",
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^run_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的运行标识无效", 400);
  writeImportedRecord(runFile(projectId, record.id), runResourceId(record.id),
    "research-run", record.label + " · " + record.status, record);
  link(runResourceId(record.id), experimentResourceId(experiment.id), "uses");
  if (relation)
    link(runResourceId(record.id), runResourceId(relation.ofRunId), "derives");
  return { saved: record, pendingRelation };
}

function importComparisonRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的比较缺少标题", 200);
  const metricName = limitLength(data.metricName, "导入的比较缺少指标", 100);
  if (!title || !metricName) throw fault("导入的比较缺少标题或指标", 400);
  const runIds = Array.isArray(data.runIds) ? [...new Set(data.runIds)] : [];
  if (!runIds.length) throw fault("导入的比较没有运行集合", 400);
  for (const runId of runIds) getRun(projectId, runId);
  const rows = Array.isArray(data.rows)
    ? data.rows.filter((row) => runIds.includes(row?.runId)).slice(0, 30)
    : comparisonRows(projectId, runIds, metricName);
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    metricName,
    runIds,
    inclusionNote: limitLength(data.inclusionNote, "纳入与排除理由无效", 2000),
    comparabilityNote: limitLength(data.comparabilityNote, "口径差异说明无效", 2000),
    rows,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^cmp_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的比较标识无效", 400);
  writeImportedRecord(comparisonFile(projectId, record.id), comparisonResourceId(record.id),
    "research-comparison", "比较 · " + record.title, record);
  for (const runId of record.runIds)
    link(comparisonResourceId(record.id), runResourceId(runId), "uses");
  return { saved: record };
}

function importManuscriptRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的稿件缺少标题", 200);
  if (!title) throw fault("导入的稿件缺少标题", 400);
  const citations = Array.isArray(data.citations) ? data.citations.slice(0, 200) : [];
  for (const citation of citations)
    if (typeof citation?.key !== "string" || !citation.key) throw fault("导入的引用条目缺少引用键", 400);
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    filePath: limitLength(data.filePath, "稿件路径无效", 500),
    fileKind: data.fileKind === "latex" ? "latex" : "markdown",
    citations,
    linkedConclusions: Array.isArray(data.linkedConclusions) ? [...new Set(data.linkedConclusions)].slice(0, 50) : [],
    snapshots: Array.isArray(data.snapshots) ? data.snapshots.slice(-50) : [],
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^man_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的稿件标识无效", 400);
  writeImportedRecord(manuscriptFile(projectId, record.id), manuscriptResourceId(record.id),
    "research-manuscript", "稿件 · " + record.title, record);
  for (const citation of record.citations)
    link(manuscriptResourceId(record.id), "paper:" + citation.paperId, "uses");
  for (const conclusionId of record.linkedConclusions)
    link(manuscriptResourceId(record.id), conclusionResourceId(conclusionId), "uses");
  return { saved: record };
}

function importConclusionRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const statement = limitLength(data.statement, "导入的结论缺少表述", 4000);
  if (!statement) throw fault("导入的结论缺少表述", 400);
  if (!CONCLUSION_KINDS.includes(data.kind)) throw fault("导入的结论类型无效", 400);
  const record = {
    id: existing?.id || data.id,
    projectId,
    statement,
    kind: data.kind,
    scope: limitLength(data.scope, "适用范围无效", 1000),
    limits: limitLength(data.limits, "结论限制无效", 2000),
    support: normalizeSupport(data.support, projectId),
    checked: Boolean(data.checked),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^con_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的结论标识无效", 400);
  writeImportedRecord(conclusionFile(projectId, record.id), conclusionResourceId(record.id),
    "research-conclusion", record.statement.slice(0, 40), record);
  for (const ref of record.support) {
    const prefix = { run: runResourceId, comparison: comparisonResourceId, evidence: evidenceResourceId, hypothesis: hypothesisResourceId, matrix: matrixResourceId, protocol: protocolResourceId }[ref.kind];
    link(conclusionResourceId(record.id), prefix(ref.id), "uses");
  }
  return { saved: record };
}

function importReselectionRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const title = limitLength(data.title, "导入的二次选题缺少标题", 200);
  if (!title) throw fault("导入的二次选题缺少标题", 400);
  const contextRefs = normalizeContextRefs(data.contextRefs);
  const candidates = normalizeCandidates(data.candidates);
  let decision = null;
  if (data.decision && RESELECTION_CHOICES.includes(data.decision.choice))
    decision = {
      choice: data.decision.choice,
      reason: limitLength(data.decision.reason, "决定理由无效", 2000),
      at: typeof data.decision.at === "string" ? data.decision.at : now,
    };
  const record = {
    id: existing?.id || data.id,
    projectId,
    title,
    note: limitLength(data.note, "补充说明无效", 2000),
    contextRefs,
    contextSnapshot: Array.isArray(data.contextSnapshot) ? data.contextSnapshot.slice(0, 100) : snapshotContext(projectId, contextRefs),
    openQuestions: normalizeOpenQuestions(data.openQuestions),
    candidates,
    decision,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^rs_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的二次选题标识无效", 400);
  writeImportedRecord(reselectionFile(projectId, record.id), reselectionResourceId(record.id),
    "research-reselection", "二次选题 · " + record.title, record);
  return { saved: record };
}

function importSubmissionRecord(projectId, data, existing, force) {
  if (existing && !force) return { skipped: true };
  const now = new Date().toISOString();
  const target = normalizeSubmissionTarget(data.target);
  const manuscriptId = typeof data.manuscriptId === "string" ? data.manuscriptId : "";
  if (manuscriptId) getManuscript(projectId, manuscriptId);
  const comments = normalizeComments(data.comments);
  for (const comment of comments)
    for (const ref of comment.disposition.refs)
      DISPOSITION_REFS[ref.kind](projectId, ref.id);
  const record = {
    id: existing?.id || data.id,
    projectId,
    round: Number.isInteger(data.round) && data.round > 0 ? data.round : 1,
    manuscriptId,
    target,
    status: SUBMISSION_STATUS.includes(data.status) ? data.status : "preparing",
    dates: {
      preparedAt: limitLength(data.dates?.preparedAt, "准备时间无效", 40),
      submittedAt: limitLength(data.dates?.submittedAt, "提交时间无效", 40),
      decisionAt: limitLength(data.dates?.decisionAt, "结果时间无效", 40),
    },
    materials: normalizeMaterials(data.materials),
    comments,
    outcomeNote: limitLength(data.outcomeNote, "结局说明无效", 2000),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : now,
    updatedAt: now,
    revision: importedRevision(existing, data),
  };
  if (!/^sub_[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw fault("导入的投稿标识无效", 400);
  writeImportedRecord(submissionFile(projectId, record.id), submissionResourceId(record.id),
    "research-submission", "投稿 · " + record.target + " 第 " + record.round + " 轮", record);
  if (record.manuscriptId)
    link(submissionResourceId(record.id), manuscriptResourceId(record.manuscriptId), "uses");
  return { saved: record };
}

export function importBundle(projectId, bundle, { force = false } = {}) {
  assertProject(projectId);
  if (!bundle || bundle.schemaVersion !== RESEARCH_SCHEMA_VERSION)
    throw fault(`不支持的研究记录包版本：${bundle?.schemaVersion}`, 400);
  verifyBundleChecksums(bundle);
  const result = {
    imported: { profile: 0, evidence: 0, matrices: 0, hypotheses: 0, protocols: 0, experiments: 0, runs: 0, comparisons: 0, conclusions: 0, manuscripts: 0, reselections: 0, submissions: 0 },
    skipped: [],
    errors: [],
  };
  if (bundle.scope === "project")
    result.papers = paperReport(bundle.papers); // 外部缺口明示，不自动创建无原文的论文
  // 恢复顺序与依赖一致：档案/证据 → 矩阵/假设 → 方案 → 实验 → 运行 → 比较 → 结论。
  const existingProfile = readProfileState(projectId);
  const pendingRelations = [];
  const importStep = (label, items, importFn, readFn, countKey) => {
    for (const item of Array.isArray(items) ? items : []) {
      try {
        const outcome = importFn(projectId, item, readFn(projectId, item?.id), force);
        if (outcome.skipped) result.skipped.push(label + " " + item.id);
        else result.imported[countKey]++;
        if (outcome.pendingRelation) pendingRelations.push(outcome.pendingRelation);
      } catch (e) {
        result.errors.push(label + " " + (item?.id || "?") + "：" + e.message);
      }
    }
  };
  try {
    if (bundle.profile) {
      const outcome = importProfileRecord(projectId, bundle.profile, existingProfile, force);
      outcome.skipped ? result.skipped.push("研究档案（已存在）") : result.imported.profile++;
    }
  } catch (e) {
    result.errors.push("研究档案：" + e.message);
  }
  importStep("证据", bundle.evidence, importEvidenceRecord, readEvidenceState, "evidence");
  importStep("对比表", bundle.matrices, importMatrixRecord, readMatrixState, "matrices");
  importStep("假设", bundle.hypotheses, importHypothesisRecord, readHypothesisState, "hypotheses");
  importStep("方案", bundle.protocols, importProtocolRecord, readProtocolState, "protocols");
  importStep("实验", bundle.experiments, importExperimentRecord, readExperimentState, "experiments");
  importStep("运行", bundle.runs, importRunRecord, readRunState, "runs");
  importStep("比较", bundle.comparisons, importComparisonRecord, readComparisonState, "comparisons");
  importStep("结论", bundle.conclusions, importConclusionRecord, readConclusionState, "conclusions");
  importStep("稿件", bundle.manuscripts, importManuscriptRecord, readManuscriptState, "manuscripts");
  importStep("二次选题", bundle.reselections, importReselectionRecord, readReselectionState, "reselections");
  importStep("投稿", bundle.submissions, importSubmissionRecord, readSubmissionState, "submissions");
  // 批内运行关系（如续跑指向批次中较后的运行）在全部运行落盘后补建。
  for (const relation of pendingRelations) {
    try {
      const existing = readRunState(projectId, relation.ofRunId);
      if (!existing) {
        result.errors.push("运行关系目标缺失：" + relation.ofRunId);
        continue;
      }
      const source = readRunState(projectId, relation.runId);
      if (!source) continue;
      saveRunRecord(projectId, source, { label: source.label, relation: { type: relation.type, ofRunId: relation.ofRunId } });
    } catch (e) {
      result.errors.push("运行关系补建失败：" + e.message);
    }
  }
  return result;
}
