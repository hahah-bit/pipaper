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
