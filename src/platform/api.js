import { requestJson } from "./http.js";
import { state } from "../shell/state.js";
import { workspaceContext } from "./workspace-context.js";
// ---------------- api ----------------
const jfetch = (url, { headers, ...options } = {}) => requestJson(url, {
  ...options, headers: { ...(state.controlId ? { "X-Pi-Control": state.controlId } : {}), ...headers },
});

export const api = {
  getConfig: () => jfetch("/api/config"),
  saveConfig: (patch) => jfetch("/api/config", { method: "PUT", body: patch }),
  papers: (refresh) => jfetch("/api/papers" + (refresh ? "?refresh=1" : "")),
  importPdf: async (file, projectId) => {
    const res = await fetch("/api/papers/import", {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
        "X-Filename": encodeURIComponent(file.name),
        ...(projectId ? { "X-Project-Id": projectId } : {}),
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  parse: (id, engine, sourceVersion) => jfetch(`/api/papers/${id}/parse`, { method: "POST", body: { engine, sourceVersion } }),
  parseVersions: (id) => jfetch(`/api/papers/${id}/versions`),
  parseVersion: (id, version) => jfetch(`/api/papers/${id}/versions/${version}`),
  activateParseVersion: (id, version) => jfetch(`/api/papers/${id}/versions/${version}/activate`, { method: "POST", body: {} }),
  job: (id) => jfetch(`/api/jobs/${id}`),
  models: () => jfetch("/api/models" + (state.sessionId ? "?sessionId=" + encodeURIComponent(state.sessionId) : "")),
  commands: () => jfetch("/api/pi/commands?" + new URLSearchParams(state.sessionId ? { sessionId: state.sessionId } : state.projectId ? { projectId: state.projectId } : {})),
  // 资源面板按侧边栏选中的项目管理；未选项目才回落到当前会话上下文
  resources: () => jfetch("/api/pi/resources?" + new URLSearchParams(state.projectId ? { projectId: state.projectId } : state.sessionId ? { sessionId: state.sessionId } : {})),
  pkgInstall: (spec, scope, projectId) => jfetch("/api/pi/packages/install", { method: "POST", body: { spec, scope, projectId } }),
  pkgRemoveProject: (spec, projectId) => jfetch("/api/pi/packages/remove", { method: "POST", body: { spec, projectId, scope: "project" } }),
  pkgRemove: (spec) => jfetch("/api/pi/packages/remove-global", { method: "POST", body: { spec } }),
  files: (q) => jfetch("/api/files?q=" + encodeURIComponent(q || "")),
  file: (path) => jfetch("/api/file?path=" + encodeURIComponent(path)),
  projects: () => jfetch("/api/projects"),
  createProject: (name, type) => jfetch("/api/projects", { method: "POST", body: { name, type } }),
  updateProject: (id, body) => jfetch(`/api/projects/${id}`, { method: "PUT", body }),
  deleteProject: (id) => jfetch(`/api/projects/${id}`, { method: "DELETE" }),
  sessions: () => jfetch("/api/sessions" + (workspaceContext.workspace === "video" ? "?workspace=video" : "")),
  createSession: (paperId, projectId, title) => jfetch("/api/sessions", { method: "POST", body: { paperId, projectId, title: title || (workspaceContext.workspace === "video" ? "视频分析" : undefined), ...(workspaceContext.workspace === "video" ? { workspace: "video" } : {}) } }),
  prompt: (id, body) => jfetch(`/api/sessions/${id}/prompt`, { method: "POST", body }),
  sessionAction: (id, action, body = {}) => jfetch(`/api/sessions/${id}/${action}`, { method: "POST", body }),
  sessionTree: (id) => jfetch(`/api/sessions/${id}/tree`),
  sessionState: (id) => jfetch(`/api/sessions/${id}/state`),
  history: (id) => jfetch(`/api/sessions/${id}`),
  delSession: (id) => jfetch(`/api/sessions/${id}`, { method: "DELETE" }),
  steer: (id, body) => jfetch(`/api/sessions/${id}/steer`, { method: "POST", body }),
  answerUserInput: (id, requestId, body) => jfetch(`/api/sessions/${id}/ui/${requestId}`, { method: "POST", body }),
  fork: (id, entryId, title) => jfetch(`/api/sessions/${id}/fork`, { method: "POST", body: { entryId, title } }),
  setModel: (id, body) => jfetch(`/api/sessions/${id}/model`, { method: "POST", body }),
  compact: (id) => jfetch(`/api/sessions/${id}/compact`, { method: "POST", body: {} }),
  abort: (id) => jfetch(`/api/sessions/${id}/abort`, { method: "POST" }),
  setupStatus: () => jfetch("/api/setup/status"),
  setupTest: (id) => jfetch(`/api/setup/test/${id}`, { method: "POST", body: {} }),
  notes: () => jfetch("/api/notes"),
  notesResolve: (paperId, title) => jfetch("/api/notes/resolve?" + new URLSearchParams({ paperId, title: title || "" })),
  notesEnsure: (body) => jfetch("/api/notes/ensure", { method: "POST", body }),
  notesWriteFile: (path, content, revision) => jfetch("/api/notes/file", { method: "PUT", body: { path, content, revision } }),
  notesReadFile: path => jfetch("/api/notes/file?path="+encodeURIComponent(path)),
  notesDeleteFile: (path) => jfetch("/api/notes/file?path=" + encodeURIComponent(path), { method: "DELETE" }),
  notesDeletePaper: (category, slug) => jfetch("/api/notes/paper?" + new URLSearchParams({ category, slug }), { method: "DELETE" }),
  searchSources: () => jfetch("/api/search/sources"),
  saveSearchSources: (sources) => jfetch("/api/search/sources", { method: "PUT", body: { sources } }),
};
