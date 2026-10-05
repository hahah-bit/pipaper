import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  resource,
  resourceAt,
  resources,
  putResource,
  digest,
  storageRoot,
  fault,
  invalidate,
  dependencies,
  operation,
  operations,
  jobs,
  saveJob,
  readState,
  writeState,
  transaction,
  events,
  history as historyFor,
} from "./catalog.js";

export const fileId = (file) =>
  "file:" + digest(path.resolve(file)).slice(0, 32);
export function infer(file) {
  const name = path.resolve(file).replaceAll("\\", "/");
  const kind = name.includes("/parsed/")
    ? "parsed"
    : name.includes("/tmp/")
      ? "temporary"
      : name.includes("/backups/")
        ? "backup"
        : name.endsWith(".log")
          ? "log"
          : "artifact";
  const study = name.match(/\/studies\/(study_[a-f0-9-]+)\//),
    topic = name.match(/\/topic-analysis\/tasks\/(topic_[a-f0-9-]+)\//);
  return {
    kind,
    owner: study
      ? "study:" + study[1]
      : topic
        ? "topic:" + topic[1]
        : undefined,
    expiresAt: ["temporary", "log"].includes(kind)
      ? new Date(Date.now() + (kind === "log" ? 7 : 1) * 86400000).toISOString()
      : null,
  };
}
function objectFile(hash) {
  return path.join(storageRoot, "objects", hash.slice(0, 2), hash);
}
function preserve(buffer) {
  const hash = digest(buffer),
    file = objectFile(hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer, { flag: "wx" });
  }
  return { hash, file };
}
export function registerFile(file, meta = {}) {
  file = path.resolve(file);
  const prior = meta.id
    ? resource(meta.id) || resourceAt(file)
    : resourceAt(file) || resource(fileId(file));
  if (prior && prior.lifecycle !== "active") return prior;
  const exists = fs.existsSync(file),
    isDirectory = exists && fs.statSync(file).isDirectory();
  const hash =
    exists && !isDirectory ? meta.hash || digest(fs.readFileSync(file)) : null;
  if (
    prior?.hash === hash &&
    prior?.location === file &&
    Object.entries(meta).every(
      ([k, v]) => JSON.stringify(prior[k]) === JSON.stringify(v),
    )
  )
    return prior;
  const next = putResource({
    ...infer(file),
    ...prior,
    objectPath: prior?.hash === hash ? prior?.objectPath : null,
    ...meta,
    id: meta.id || prior?.id || fileId(file),
    location: file,
    hash,
    directory: isDirectory,
    bytes: exists && !isDirectory ? fs.statSync(file).size : 0,
    availability: exists ? meta.availability || "ready" : "missing",
  });
  if (prior?.hash && next.hash !== prior.hash) invalidate(next.id);
  return next;
}
export function writeFile(file, value, meta = {}) {
  if (!meta || typeof meta !== "object") meta = {};
  file = path.resolve(file);
  const old = meta.id
    ? resource(meta.id) || (!meta.newResource && resourceAt(file))
    : resourceAt(file) || resource(fileId(file));
  if (old && old.lifecycle !== "active")
    throw fault("已删除资源不能重新写入", 409);
  const owner = Object.hasOwn(meta, "owner")
    ? meta.owner
    : old?.owner || infer(file).owner;
  if (
    owner &&
    resource(owner)?.lifecycle &&
    resource(owner).lifecycle !== "active"
  )
    throw fault("所属资源已删除，拒绝迟到写入", 409);
  if (
    meta.expectedRevision != null &&
    meta.expectedRevision !== (old?.revision || 0)
  )
    throw fault("内容已更新，请合并后重试", 409);
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const saved = preserve(buffer);
  const previousLocation = old?.location || file;
  if (
    fs.existsSync(previousLocation) &&
    fs.statSync(previousLocation).isFile()
  ) {
    const previous = preserve(fs.readFileSync(previousLocation));
    if (old && !old.objectPath)
      putResource({ ...old, hash: previous.hash, objectPath: previous.file });
  }
  const op = operation({
    type: "write",
    resourceId: old?.id || meta.id || fileId(file),
    location: file,
    objectPath: saved.file,
    baseRevision: resource(old?.id || meta.id || fileId(file))?.revision || 0,
    metadata: meta,
    status: "pending",
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
    const next = putResource({
      ...infer(file),
      ...old,
      ...meta,
      id: old?.id || meta.id || fileId(file),
      location: file,
      hash: saved.hash,
      versionId: saved.hash,
      objectPath: saved.file,
      bytes: buffer.length,
      availability: meta.availability || "ready",
    });
    if (old?.hash && old.hash !== next.hash) invalidate(next.id);
    // Keep imported JSON state synchronized when a legacy module writes its mirror.
    if (readState("legacy:" + file, null) !== null) {
      try {
        writeState("legacy:" + file, JSON.parse(buffer.toString("utf8")));
      } catch {}
    }
    operation({ ...op, status: "succeeded" });
    return next;
  } catch (error) {
    operation({ ...op, status: "failed", error: error.message });
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function collectObjects() {
  const retained = resources().filter((r) => r.lifecycle !== "deleted");
  for (const r of retained.filter((r) => r.id.startsWith("blob:")))
    if (
      !dependencies(r.id).some(
        (d) => d.target === r.id && resource(d.source)?.lifecycle !== "deleted",
      )
    )
      putResource(
        { ...r, lifecycle: "deleted", deletedAt: new Date().toISOString() },
        { allowInactive: true },
      );
  const protectedPaths = new Set();
  for (const op of operations().filter(
    (o) => ["pending", "failed"].includes(o.status) && o.objectPath,
  ))
    protectedPaths.add(path.resolve(op.objectPath));
  for (const r of resources().filter((r) => r.lifecycle !== "deleted"))
    for (const version of [r, ...historyFor(r.id)])
      if (version.objectPath)
        protectedPaths.add(path.resolve(version.objectPath));
  const objects = path.join(storageRoot, "objects");
  let count = 0;
  if (fs.existsSync(objects))
    for (const dir of fs
      .readdirSync(objects, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink()))
      for (const e of fs.readdirSync(path.join(objects, dir.name), {
        withFileTypes: true,
      }))
        if (
          e.isFile() &&
          !protectedPaths.has(path.resolve(objects, dir.name, e.name))
        ) {
          fs.rmSync(path.join(objects, dir.name, e.name));
          count++;
        }
  return count;
}
export function auditResources() {
  let missing = 0;
  for (const r of resources().filter(
    (r) => r.lifecycle === "active" && r.location,
  ))
    if (!fs.existsSync(r.location)) {
      missing++;
      if (r.availability !== "missing")
        putResource({
          ...r,
          availability: "missing",
          missingSince: new Date().toISOString(),
        });
    }
  return { missing };
}
export function relocate(from, to) {
  const entries = descendants(from),
    origin = path.resolve(from);
  fs.renameSync(from, to);
  for (const r of entries)
    putResource({
      ...r,
      location: path.join(path.resolve(to), path.relative(origin, r.location)),
    });
}
export function commitDirectory(from, to) {
  const prior = descendants(to),
    staged = descendants(from),
    backup = to + ".previous-" + randomUUID();
  // Freeze old versions before replacing the directory's public names.
  for (const r of prior.filter(
    (r) => !r.directory && fs.existsSync(r.location) && !r.objectPath,
  )) {
    const saved = preserve(fs.readFileSync(r.location));
    putResource({ ...r, objectPath: saved.file, hash: saved.hash });
  }
  const op = operation({
    type: "directory-publish",
    location: path.resolve(to),
    from: path.resolve(from),
    backup,
    prior,
    staged,
    status: "pending",
  });
  return finishDirectory(op);
}
export function finishDirectory(op) {
  const { from, location: to, backup, prior, staged } = op;
  try {
    if (fs.existsSync(from)) {
      if (fs.existsSync(to) && !fs.existsSync(backup))
        fs.renameSync(to, backup);
      try {
        fs.renameSync(from, to);
      } catch (e) {
        if (fs.existsSync(backup) && !fs.existsSync(to))
          fs.renameSync(backup, to);
        throw e;
      }
    } else if (!fs.existsSync(to)) throw fault("待发布目录缺失", 409);
    const changed = [];
    transaction(() => {
      for (const r of staged) {
        const target = path.resolve(
            to,
            path.relative(path.resolve(from), r.location),
          ),
          old = prior.find((v) => v.location === target);
        if (old && old.id !== r.id) {
          const current = resource(old.id);
          if (current.hash !== r.hash || current.location !== target)
            putResource({
              ...current,
              location: target,
              hash: r.hash,
              versionId: r.hash,
              objectPath: r.objectPath,
              availability: "ready",
              bytes: r.bytes,
            });
          if (resource(r.id)?.lifecycle !== "deleted")
            putResource(
              { ...r, lifecycle: "deleted", supersededBy: old.id },
              { allowInactive: true },
            );
          if (old.hash !== r.hash) changed.push(old.id);
        } else if (resource(r.id)?.location !== target)
          putResource({ ...r, location: target });
      }
      for (const r of prior.filter(
        (r) =>
          !r.directory &&
          !staged.some(
            (s) =>
              path.relative(from, s.location) === path.relative(to, r.location),
          ),
      ))
        putResource({
          ...resource(r.id),
          availability: "stale",
          location: path.join(backup, path.relative(to, r.location)),
        });
    });
    for (const id of changed) invalidate(id);
    operation({ ...op, status: "succeeded" });
    if (fs.existsSync(backup)) {
      const parent = path.resolve(path.dirname(to)),
        relative = path.relative(parent, path.resolve(backup));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw fault("备份路径越界");
      fs.rmSync(backup, { recursive: true, force: true });
    }
  } catch (e) {
    operation({ ...op, status: "failed", error: e.message });
    throw e;
  }
}
export function registerTree(root, meta = {}) {
  if (!fs.existsSync(root)) return;
  registerFile(root, { kind: "artifact-folder", ...meta });
  for (const e of fs.readdirSync(root, { withFileTypes: true }))
    if (!e.isSymbolicLink()) {
      const file = path.join(root, e.name);
      if (e.isDirectory()) registerTree(file, meta);
      else registerFile(file, meta);
    }
}
export const writeJson = (file, value, meta) =>
  writeFile(file, JSON.stringify(value, null, 2), meta);
// Use only for an explicit new import at a previously deleted path.
export function createFile(file, value, meta = {}) {
  return writeFile(file, value, {
    ...meta,
    id: "file:" + randomUUID(),
    newResource: true,
  });
}
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
// SQLite is authoritative; mirrors keep existing links and exports compatible.
export function readJsonState(file, fallback) {
  const entry = resourceAt(file);
  if (entry && entry.lifecycle !== "active")
    throw Object.assign(fault("资源已删除", 404), { code: "ENOENT" });
  const key = "legacy:" + path.resolve(file),
    saved = readState(key, null);
  if (saved !== null) return saved;
  let value;
  try {
    value = readJson(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return fallback;
  }
  const backup = path.join(
    storageRoot,
    "migration-backup",
    digest(path.resolve(file)) + ".json",
  );
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  writeState(key, value);
  registerFile(file);
  return value;
}
export function writeJsonState(file, value, meta) {
  writeJson(file, value, meta);
  writeState("legacy:" + path.resolve(file), value);
  return value;
}
function descendants(root) {
  const resolved = path.resolve(root);
  return resources().filter(
    (r) =>
      r.location &&
      (r.location === resolved ||
        (path.relative(resolved, r.location) &&
          !path.relative(resolved, r.location).startsWith("..") &&
          !path.isAbsolute(path.relative(resolved, r.location)))),
  );
}
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
export function trashPath(file, meta = {}) {
  const r = registerFile(file, meta);
  return trash(r.id);
}
export function trash(id) {
  const root = resource(id);
  if (!root) throw fault("资源不存在", 404);
  if (root.lifecycle === "trashed") {
    const pending = operations().find(
      (o) =>
        o.resourceId === id && o.type === "trash" && o.status !== "succeeded",
    );
    if (pending) return finishTrash(pending);
    return root;
  }
  if (root.lifecycle !== "active") throw fault("资源正在清理", 409);
  const affected = new Map([
    [root.id, root],
    ...descendants(root.location || path.join(storageRoot, "nonexistent")).map(
      (r) => [r.id, r],
    ),
  ]);
  const queue = [root.id];
  while (queue.length)
    for (const ref of dependencies(queue.shift()).filter(
      (d) => d.source && d.relation === "owns",
    )) {
      if (!affected.has(ref.target)) {
        const child = resource(ref.target);
        if (child) {
          affected.set(child.id, child);
          queue.push(child.id);
        }
      }
    }
  // Shared files and independent snapshots never inherit another owner's deletion.
  for (const [key, r] of affected)
    if (
      key !== root.id &&
      dependencies(key).some(
        (d) =>
          d.target === key &&
          ["uses", "snapshot"].includes(d.relation) &&
          !affected.has(d.source) &&
          resource(d.source)?.lifecycle === "active",
      )
    )
      affected.delete(key);
  const moves = [];
  const all = resources();
  for (const r of [...affected.values()].sort(
    (a, b) => (a.location?.length || 0) - (b.location?.length || 0),
  )) {
    if (r.owned === false || !r.location || !fs.existsSync(r.location))
      continue;
    const protectedChild =
      r.directory &&
      all.some(
        (child) =>
          child.lifecycle === "active" &&
          !affected.has(child.id) &&
          child.location &&
          child.location !== r.location &&
          descendants(r.location).some((d) => d.id === child.id),
      );
    if (
      protectedChild ||
      moves.some(
        (m) =>
          r.location === m.from ||
          (m.directory && descendants(m.from).some((d) => d.id === r.id)),
      )
    )
      continue;
    moves.push({
      from: r.location,
      to: path.join(storageRoot, "trash", digest(id), digest(r.id)),
      directory: r.directory,
      id: r.id,
      done: false,
    });
  }
  const op = operation({
    type: "trash",
    resourceId: id,
    status: "pending",
    affected: [...affected.keys()],
    moves,
  });
  transaction(() => {
    for (const r of affected.values()) {
      for (const j of jobs(r.id).filter((j) =>
        ["running", "queued", "paused", "blocked", "interrupted"].includes(
          j.status,
        ),
      ))
        saveJob({ ...j, status: "cancelled", epoch: (j.epoch || 0) + 1 });
      putResource(
        {
          ...r,
          lifecycle: "trashed",
          trashedAt: new Date().toISOString(),
          purgeAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          trashGroup: id,
        },
        { allowInactive: true },
      );
    }
    putResource(
      { ...resource(id), trashMoves: moves },
      { allowInactive: true },
    );
  });
  events.emit("lifecycle", {
    id,
    type: "trash",
    affected: [...affected.keys()],
  });
  return finishTrash(op);
}
function finishTrash(op) {
  try {
    for (const m of op.moves || []) {
      if (m.done) continue;
      if (fs.existsSync(m.from)) move(m.from, m.to);
      else if (!fs.existsSync(m.to)) throw fault("待回收文件缺失", 409);
      m.done = true;
      operation({ ...op, status: "pending" });
    }
    const result = putResource(
      { ...resource(op.resourceId), trashMoves: op.moves },
      { allowInactive: true },
    );
    operation({ ...op, status: "succeeded" });
    return result;
  } catch (error) {
    operation({ ...op, status: "failed", error: error.message });
    throw error;
  }
}
export function restore(id) {
  const root = resource(id);
  if (!root) throw fault("资源不存在", 404);
  if (root.lifecycle === "active") return root;
  if (root.lifecycle !== "trashed")
    throw fault("已永久清理的资源不能恢复", 409);
  const op =
    operations().find(
      (o) =>
        o.resourceId === id && o.type === "restore" && o.status !== "succeeded",
    ) ||
    operation({
      type: "restore",
      resourceId: id,
      status: "pending",
      restored: [],
    });
  try {
    for (const m of root.trashMoves || [])
      if (
        !(op.restored || []).includes(m.id) &&
        fs.existsSync(m.from) &&
        fs.existsSync(m.to)
      )
        throw fault("恢复位置已有新文件，请先处理冲突", 409);
    for (const m of root.trashMoves || []) {
      if ((op.restored || []).includes(m.id)) continue;
      if (fs.existsSync(m.to)) move(m.to, m.from);
      else if (!fs.existsSync(m.from)) throw fault("回收站文件缺失", 409);
      (op.restored ||= []).push(m.id);
      operation({ ...op, status: "pending" });
    }
    for (const r of resources({ limit: 10000 }).filter(
      (r) => r.id === id || r.trashGroup === id,
    ))
      putResource(
        {
          ...r,
          lifecycle: "active",
          trashedAt: null,
          purgeAt: null,
          trashGroup: null,
          trashMoves: null,
        },
        { allowInactive: true },
      );
    operation({ ...op, status: "succeeded" });
    events.emit("lifecycle", { id, type: "restore" });
    return resource(id);
  } catch (error) {
    operation({ ...op, status: "failed", error: error.message });
    throw error;
  }
}
export async function purge(id, removeIndex = async () => {}) {
  const root = resource(id);
  if (!root) throw fault("资源不存在", 404);
  if (root.lifecycle === "deleted") return root;
  if (!["trashed", "purging"].includes(root.lifecycle))
    throw fault("请先将资源移入回收站", 409);
  const op = operation({ type: "purge", resourceId: id, status: "pending" });
  putResource({ ...root, lifecycle: "purging" }, { allowInactive: true });
  try {
    await removeIndex(root);
    for (const m of root.trashMoves || []) {
      const relative = path.relative(storageRoot, m.to);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw fault("回收站路径越界");
      fs.rmSync(m.to, { recursive: true, force: true });
    }
    for (const r of resources({ limit: 10000 }).filter(
      (r) => r.id === id || r.trashGroup === id,
    ))
      putResource(
        { ...r, lifecycle: "deleted", deletedAt: new Date().toISOString() },
        { allowInactive: true },
      );
    operation({ ...op, status: "succeeded" });
    return resource(id);
  } catch (error) {
    operation({ ...op, status: "failed", error: error.message });
    throw error;
  }
}
export function asset(buffer, meta = {}) {
  const saved = preserve(buffer),
    id = "blob:" + saved.hash;
  const old = resource(id);
  if (!old || old.lifecycle === "deleted")
    putResource(
      {
        ...old,
        id,
        kind: "element-asset",
        lifecycle: "active",
        location: saved.file,
        objectPath: saved.file,
        hash: saved.hash,
        bytes: buffer.length,
        ...meta,
      },
      { allowInactive: true },
    );
  return { id, path: saved.file, hash: saved.hash };
}
