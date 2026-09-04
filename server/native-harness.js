import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { APP_ROOT, DATA_DIR } from "./config.js";
import { getProject, sessionMeta, setSessionMeta, deleteSessionMeta, updateProject } from "./store.js";
import { buildPaperTools, SYSTEM_PROMPT, gatedSkillObjects, gatedSkills } from "./paper-tools.js";
import { userInputTool } from "./user-input.js";
import { SessionController } from "./session-controller.js";
import { normalizeResources, selectSkills } from "./resource-config.js";
import { manualExtensionPaths, resolveProjectPackages } from "./pi-packages.js";

const chats = new Map();
const opening = new Map();
const error = (text, status = 400) => Object.assign(new Error(text), { status });

function diagnostics(loader) {
  return [
    ...(loader.getExtensions().errors || []).map(e => ({ type: "error", message: `${e.path || "扩展"}: ${e.error}` })),
    ...[loader.getSkills(), loader.getPrompts(), loader.getThemes()].flatMap(r => (r.diagnostics || []).map(d => ({ type: d.type === "error" ? "error" : "warning", message: d.message || String(d) }))),
  ];
}
async function buildRuntime(options, controller) {
  const meta = options.sessionStartEvent?.reason === "resume" ? (sessionMeta(options.sessionManager.getSessionId()) || controller.meta) : controller.meta;
  const project = getProject(meta.projectId);
  const resources = normalizeResources(project?.resources);
  const pkgs = await resolveProjectPackages(project?.id);
  const nativeSettings = SettingsManager.create(APP_ROOT, getAgentDir());
  // Runtime settings are session-owned; native setter methods must not silently
  // turn a web dropdown into a write to the user's global Pi defaults.
  const settingsManager = SettingsManager.inMemory(nativeSettings.getGlobalSettings());
  settingsManager.applyOverrides(nativeSettings.getProjectSettings());
  if (resources.defaultTools) settingsManager.applyOverrides({ defaultTools: resources.defaultTools });
  const gated = meta.paperId || project?.type === "zotero" ? gatedSkillObjects() : [];
  let candidates = [];
  const resourceLoader = new DefaultResourceLoader({ cwd: APP_ROOT, agentDir: getAgentDir(), settingsManager,
    systemPromptOverride: () => SYSTEM_PROMPT,
    additionalExtensionPaths: [...manualExtensionPaths(resources), ...pkgs.extensions],
    additionalSkillPaths: pkgs.skills, additionalPromptTemplatePaths: pkgs.prompts, additionalThemePaths: pkgs.themes,
    skillsOverride: current => {
      candidates = [...new Map([...current.skills, ...gated].map(s => [s.name, s])).values()];
      return { ...current, skills: selectSkills(current.skills, gated, resources) };
    },
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create();
  const result = await createAgentSession({ ...options, cwd: APP_ROOT, modelRuntime, settingsManager, resourceLoader,
    customTools: [...buildPaperTools({ get id() { return controller.runtime?.session.sessionId || options.sessionManager.getSessionId(); } }), userInputTool(controller.ui)] });
  if (resources.activeTools) result.session.setActiveToolsByName(resources.activeTools);
  return { ...result, services: { cwd: APP_ROOT, agentDir: getAgentDir(), modelRuntime, settingsManager, resourceLoader },
    diagnostics: [...diagnostics(resourceLoader), ...(result.modelFallbackMessage ? [{ type: "warning", message: result.modelFallbackMessage }] : [])],
    candidates, revision: resources.revision };
}

async function makeController(sm, meta) {
  const c = await SessionController.create({ cwd: APP_ROOT, agentDir: getAgentDir(), sessionManager: sm, meta, build: buildRuntime,
    onMeta: patch => { if (c) setSessionMeta(c.id, patch); },
    onReplace: async (oldId, newId, controller) => {
      chats.delete(oldId); chats.set(newId, controller);
      const saved = sessionMeta(newId);
      controller.meta = saved ? { ...saved } : { ...controller.meta };
      setSessionMeta(newId, controller.meta);
    },
    beforeSwitch: async (file, controller) => {
      const info = (await SessionManager.list(APP_ROOT)).find(x => path.resolve(x.path) === path.resolve(file));
      if (!info) throw error("仅支持当前应用工作目录内的会话");
      const other = chats.get(info.id);
      if (other && other !== controller) {
        if (other.connection || other.busy) throw error("目标会话已被占用", 409);
        await other.dispose(); chats.delete(info.id);
      }
    },
  });
  chats.set(c.id, c);
  if (!c.session.sessionName && meta?.title) c.session.setSessionName(meta.title);
  setSessionMeta(c.id, meta || {});
  return c;
}

export async function controllerFor(id) {
  if (chats.has(id)) return chats.get(id);
  if (!opening.has(id)) opening.set(id, (async () => {
    const info = (await SessionManager.list(APP_ROOT)).find(s => s.id === id);
    if (!info) throw error("会话不存在", 404);
    return makeController(SessionManager.open(info.path), sessionMeta(id) || {});
  })().finally(() => opening.delete(id)));
  return opening.get(id);
}
export async function ownedController(id, controlId) { const c = await controllerFor(id); c.assertOwner(controlId); return c; }
export async function createChat({ paperId = null, projectId = null, title = null } = {}) {
  if (projectId && !getProject(projectId)) throw error("项目不存在");
  const c = await makeController(SessionManager.create(APP_ROOT), { paperId, projectId, title });
  return { id: c.id, model: c.state().model };
}
export async function sessionHistory(id) { return (await controllerFor(id)).history(); }
export async function sessionState(id) { return (await controllerFor(id)).state(); }
export async function listSessions() {
  const raw = await SessionManager.list(APP_ROOT);
  const rows = new Map(raw.map(info => [info.id, { ...sessionMeta(info.id), id: info.id, path: info.path, title: info.name || sessionMeta(info.id)?.title || info.firstMessage?.slice(0, 60) || "(空会话)",
    parentSession: info.parentSessionPath, updatedAt: info.modified?.toISOString?.(), messageCount: info.messageCount }]));
  for (const c of chats.values()) rows.set(c.id, { ...rows.get(c.id), ...c.meta, id: c.id, path: c.session.sessionFile,
    title: c.session.sessionName || c.meta.title || rows.get(c.id)?.title || "(空会话)", parentSession: c.session.sessionManager.getHeader()?.parentSession,
    busy: c.busy, connected: !!c.connection, updatedAt: sessionMeta(c.id)?.updatedAt || rows.get(c.id)?.updatedAt || new Date().toISOString() });
  const paths = new Map([...rows.values()].filter(r => r.path).map(r => [path.resolve(r.path), r.id]));
  return [...rows.values()].map(r => ({ ...r, parentId: r.parentSession ? paths.get(path.resolve(r.parentSession)) : null })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export async function deleteChat(id, controlId) {
  const c = await controllerFor(id); if (c.connection) c.assertOwner(controlId);
  const file = c.session.sessionFile; await c.dispose(); chats.delete(id);
  if (file && fs.existsSync(file)) fs.rmSync(file);
  deleteSessionMeta(id);
}
export async function updateBinding(c, { paperId, projectId }) {
  const next = { ...c.meta, ...(paperId !== undefined ? { paperId } : {}), ...(projectId !== undefined ? { projectId } : {}) };
  if (next.paperId === c.meta.paperId && next.projectId === c.meta.projectId) return;
  if (c.busy) throw error("执行期间不能切换论文或项目绑定", 409);
  if (next.projectId && !getProject(next.projectId)) throw error("项目不存在");
  const previous = c.meta; c.meta = next;
  try { await c.start("binding", () => c.reload(true)).completion; setSessionMeta(c.id, next); }
  catch (e) { c.meta = previous; throw e; }
}
export async function promptChat(id, body, controlId) {
  const c = await ownedController(id, controlId);
  await updateBinding(c, body);
  if (!c.session.sessionName && body.text) c.session.setSessionName(body.text.slice(0, 60));
  setSessionMeta(c.id, { updatedAt: new Date().toISOString() });
  return { ok: true, operationId: c.submit(body.text || "", body.images).id };
}
export async function steerChat(id, body, controlId) { return (await ownedController(id, controlId)).enqueue(body); }
export async function answerUserInput(id, requestId, answer, controlId) { (await ownedController(id, controlId)).ui.answer(requestId, answer); return { ok: true }; }
export async function abortChat(id, kind, controlId) { await (await ownedController(id, controlId)).abort(kind); return { ok: true }; }
export async function setChatModel(id, { provider, id: modelId, thinkingLevel }, controlId) {
  const c = await ownedController(id, controlId);
  if (c.busy) throw error("请在当前任务结束后切换模型", 409);
  if (provider && modelId) {
    const model = c.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw error("模型不存在");
    await c.session.setModel(model);
  }
  if (thinkingLevel) c.session.setThinkingLevel(thinkingLevel);
  c.emitState(); return c.state();
}
export async function compactSession(id, instructions, controlId) {
  const c = await ownedController(id, controlId);
  if (c.busy) throw error("请在当前任务结束后压缩", 409);
  return { operationId: c.start("compaction", () => c.session.compact(instructions)).id };
}
export async function forkChat(id, { entryId, title }, controlId) {
  const c = await ownedController(id, controlId);
  if (c.busy) throw error("请等待父任务完成后建立分支", 409);
  return { operationId: c.start("fork", async () => {
    const r = await c.replace("fork", entryId);
    if (!r.cancelled && title) c.session.setSessionName(title);
    if (!r.cancelled && r.selectedText) c.ui.setEditor(r.selectedText);
    c.emitSnapshot(); return { ...r, id: c.id, model: c.state().model };
  }).id };
}
export function refreshProjectResources(projectId) { for (const c of chats.values()) if (projectId === undefined || c.meta.projectId === projectId) c.markResourcesPending(); }

export async function modelList(sessionId) {
  const runtime = sessionId ? (await controllerFor(sessionId)).session.modelRuntime : await ModelRuntime.create();
  return { models: (await runtime.getAvailable()).map(m => ({ provider: m.provider, id: m.id, name: m.name || m.id, reasoning: !!m.reasoning, input: m.input, contextWindow: m.contextWindow })) };
}
async function catalog(sessionId, projectId) {
  if (sessionId) return { c: await controllerFor(sessionId), disposable: false };
  // Never hand this preview loader to a live session. No session_start is emitted.
  const c = await SessionController.create({ cwd: APP_ROOT, agentDir: getAgentDir(), sessionManager: SessionManager.inMemory(APP_ROOT), meta: { projectId }, build: buildRuntime });
  return { c, disposable: true };
}
export async function listCommands(sessionId, projectId) {
  const { c, disposable } = await catalog(sessionId, projectId);
  try {
    const loader = c.session.resourceLoader;
    const simple = s => ({ name: s.invocationName || s.name, description: s.description || "", source: s.source || s.sourceInfo?.path || "", path: s.filePath });
    return { prompts: loader.getPrompts().prompts.map(simple), skills: loader.getSkills().skills.map(simple),
      extensions: c.session.extensionRunner.getRegisteredCommands().map(simple) };
  } finally { if (disposable) c.session.dispose(); }
}
export async function resourceInfo(sessionId, projectId) {
  const { c, disposable } = await catalog(sessionId, projectId);
  try {
    const loader = c.session.resourceLoader, enabled = new Set(loader.getSkills().skills.map(s => s.name));
    return { sessionId: sessionId || null, projectId: c.meta.projectId || null, resources: c.resourceState,
      selection: normalizeResources(getProject(c.meta.projectId)?.resources),
      skills: c.candidates.map(s => ({ name: s.name, description: s.description, source: s.source, enabled: enabled.has(s.name) })),
      gatedSkills: gatedSkills(), extensions: loader.getExtensions().extensions.map(e => ({ name: path.basename(e.path), path: e.path, source: e.sourceInfo?.source || "" })),
      tools: c.session.getAllTools().map(t => ({ name: t.name, description: t.description, source: t.sourceInfo, enabled: c.session.getActiveToolNames().includes(t.name) })),
      diagnostics: [...c.runtime.diagnostics, ...c.session.extensionRunner.getCommandDiagnostics().map(d => ({ type: d.type, message: d.message }))],
    };
  } finally { if (disposable) c.session.dispose(); }
}
export async function operate(id, action, body, controlId) {
  const c = await ownedController(id, controlId);
  if (action === "binding") { await updateBinding(c, body); c.emitState(); return c.state(); }
  if (action === "editor") { c.ui.displayState.editor = String(body.text || ""); c.ui.editorInitialized = true; return { ok: true }; }
  if (action === "queue/take") return c.takeQueue();
  if (action === "queue/mode") {
    for (const [key, method] of [["steering", "setSteeringMode"], ["followUp", "setFollowUpMode"]]) {
      if (body[key] && !["all", "one-at-a-time"].includes(body[key])) throw error("队列模式无效");
      if (body[key]) c.session[method](body[key]);
    }
    c.emitState(); return c.state();
  }
  if (c.busy) throw error("请等待当前操作完成", 409);
  if (action === "name") { c.session.setSessionName(String(body.name || "").trim()); c.emitState(); return c.state(); }
  if (action === "reload") return { operationId: c.start("reload", () => c.reload(true)).id };
  if (action === "tree/navigate") return { operationId: c.start("tree", () => c.navigate(body.entryId, { summarize: !!body.summarize, customInstructions: body.instructions, label: body.label })).id };
  if (action === "tree/label") {
    if (!c.session.sessionManager.getEntry(body.entryId)) throw error("节点不存在");
    c.session.sessionManager.appendLabelChange(body.entryId, String(body.label || "").trim() || undefined); return c.tree();
  }
  if (action === "tools") {
    if (body.saveProjectDefault && !c.meta.projectId) throw error("请先选择项目");
    if (!Array.isArray(body.names)) throw error("工具清单无效");
    const all = new Set(c.session.getAllTools().map(t => t.name));
    if (body.names.some(n => !all.has(n))) throw error("存在未知工具");
    c.session.setActiveToolsByName(body.names); c.activeTools = [...body.names];
    if (body.saveProjectDefault) {
      // defaultTools config applies to built-ins; preserve the exact session
      // selection separately for extension/custom tools.
      const builtins = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
      updateProject(c.meta.projectId, { resources: { defaultTools: body.names.filter(n => builtins.has(n)), activeTools: body.names } });
      refreshProjectResources(c.meta.projectId);
    }
    c.emitState(); return { tools: c.session.getActiveToolNames() };
  }
  throw error("未知会话操作");
}
export async function exportSession(id, format, controlId) {
  const c = await ownedController(id, controlId);
  if (!["html", "jsonl"].includes(format)) throw error("导出格式无效");
  if (c.busy) throw error("任务结束后才能导出", 409);
  const directory = path.join(DATA_DIR, "tmp", "exports"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${c.id}-${randomUUID()}.${format}`);
  if (format === "html") await c.session.exportToHtml(file);
  else c.session.exportToJsonl(file);
  return file;
}
