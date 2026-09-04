import fs from "node:fs";
import path from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { APP_ROOT, DATA_DIR } from "./config.js";
import { getProject, updateProject } from "./store.js";
import { resourceSource } from "./resource-config.js";

const locks = new Map();
export async function withPackageLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}

export function projectPackageManager(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error("项目不存在");
  // Never use an incoming path as the managed directory name.
  if (!/^[\w-]+$/.test(projectId)) throw new Error("项目 ID 无效");
  const cwd = path.join(DATA_DIR, "pi-projects", projectId);
  fs.mkdirSync(cwd, { recursive: true });
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, fn) {
      const current = scope === "project" ? { packages: getProject(projectId)?.resources?.packages || [] } : {};
      const next = fn(JSON.stringify(current));
      if (next !== undefined && scope === "project") updateProject(projectId, { resources: { packages: JSON.parse(next).packages || [] } });
    },
  });
  return { manager: new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager }), settingsManager };
}

export async function resolveProjectPackages(projectId) {
  if (!projectId || !getProject(projectId)?.resources?.packages?.length) return { extensions: [], skills: [], prompts: [], themes: [] };
  return withPackageLock(projectId, async () => {
    const { manager } = projectPackageManager(projectId);
    const result = await manager.resolve();
    return Object.fromEntries(Object.entries(result).map(([type, entries]) => [type, entries.filter(e => e.enabled).map(e => e.path)]));
  });
}

// Earlier versions put package-generated extension paths in the manual list.
// Remove only paths under the app-owned legacy npm root for declared packages.
export function manualExtensionPaths(resources) {
  const roots = (resources.packages || []).map(source => {
    const spec = resourceSource(source).replace(/^npm:/, "");
    const name = spec.startsWith("@") ? spec.replace(/(@[^/]+\/[^@]+)@.*$/, "$1") : spec.replace(/@.*$/, "");
    return path.resolve(DATA_DIR, "npm", "node_modules", name) + path.sep;
  });
  return (resources.extensions || []).filter(p => !roots.some(root => (path.resolve(p) + path.sep).startsWith(root)));
}

export async function changePackage({ spec, scope = "project", projectId, remove = false }) {
  const source = resourceSource(spec).trim();
  if (!source) throw new Error("缺少包来源");
  const key = scope === "global" ? "global" : projectId;
  return withPackageLock(key, async () => {
    const projectPackage = scope === "global" ? null : projectPackageManager(projectId);
    const settingsManager = projectPackage?.settingsManager || SettingsManager.create(APP_ROOT, getAgentDir());
    const manager = projectPackage?.manager || new DefaultPackageManager({ cwd: APP_ROOT, agentDir: getAgentDir(), settingsManager });
    const notes = [];
    manager.setProgressCallback(e => notes.push(e.message));
    // Capture old generated paths before removing the package declaration.
    if (projectId && scope !== "global") {
      const r = getProject(projectId).resources;
      updateProject(projectId, { resources: { extensions: manualExtensionPaths(r) } });
    }
    if (remove) await manager.removeAndPersist(source, { local: scope !== "global" });
    else await manager.installAndPersist(source, { local: scope !== "global" });
    await settingsManager.flush();
    return { ok: true, output: notes.join("\n"), scope, project: projectId ? getProject(projectId) : undefined };
  });
}
