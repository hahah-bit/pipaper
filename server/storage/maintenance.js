import { resources, resource, dependencies, operations } from "./catalog.js";
import {
  trash,
  restore,
  purge,
  collectObjects,
  finishDirectory,
  auditResources,
} from "./files.js";
import { removeResourceIndexes } from "../rag/milvus.js";
export async function runMaintenance({
  now = Date.now(),
  removeIndex = async (r) => {
    for (const child of resources().filter(
      (x) => x.id === r.id || x.trashGroup === r.id,
    ))
      await removeResourceIndexes(child.id);
  },
} = {}) {
  const results = [];
  results.push({ type: "catalog-audit", ...auditResources() });
  for (const r of resources()) {
    try {
      const referenced = dependencies(r.id).some(
        (d) => d.target === r.id && resource(d.source)?.lifecycle !== "deleted",
      );
      if (
        r.lifecycle === "active" &&
        ["temporary", "log"].includes(r.kind) &&
        r.expiresAt &&
        Date.parse(r.expiresAt) <= now &&
        !referenced
      ) {
        trash(r.id);
        results.push({ id: r.id, type: "expired" });
      }
      if (
        r.lifecycle === "trashed" &&
        (!r.trashGroup || r.trashGroup === r.id) &&
        r.purgeAt &&
        Date.parse(r.purgeAt) <= now
      ) {
        await purge(r.id, removeIndex);
        results.push({ id: r.id, type: "purged" });
      }
    } catch (e) {
      results.push({ id: r.id, error: e.message });
    }
  }
  results.push({ type: "object-gc", count: collectObjects() });
  return results;
}
export async function retryOperation(id) {
  const op = operations().find((o) => o.id === id);
  if (!op) throw new Error("操作不存在");
  if (op.type === "trash") return trash(op.resourceId);
  if (op.type === "restore") return restore(op.resourceId);
  if (op.type === "directory-publish" && op.staged) return finishDirectory(op);
  if (op.type === "purge")
    return purge(op.resourceId, async (r) => {
      for (const child of resources().filter(
        (x) => x.id === r.id || x.trashGroup === r.id,
      ))
        await removeResourceIndexes(child.id);
    });
  throw new Error("该操作应通过资源更新重新执行");
}
export function startMaintenance() {
  const timer = setInterval(() => void runMaintenance(), 3600000);
  timer.unref();
  return () => clearInterval(timer);
}
