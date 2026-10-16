import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const storageRoot = path.join(
  process.env.PIPAPER_DATA_DIR || path.join(appRoot, "data"),
  "storage",
);
export const events = new EventEmitter();
events.setMaxListeners(100);
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export const fault = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export const stamp = () => new Date().toISOString();
let db;
export function closeCatalog() {
  if (db) {
    db.close();
    db = null;
  }
}
export function database() {
  if (db) return db;
  fs.mkdirSync(storageRoot, { recursive: true });
  db = new DatabaseSync(path.join(storageRoot, "catalog.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT,location TEXT,lifecycle TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS resource_owner ON resources(owner);
    CREATE INDEX IF NOT EXISTS resource_location ON resources(location);
    CREATE TABLE IF NOT EXISTS refs(source TEXT NOT NULL,target TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(source,target,relation));
    CREATE TABLE IF NOT EXISTS states(key TEXT PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(resource_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(resource_id,revision));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,status TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS job_resource ON jobs(resource_id,status);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_generation ON generations(resource_id) WHERE active=1;
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,generation_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS generation_records ON records(generation_id,kind);`);
  return db;
}
export function transaction(fn) {
  const d = database();
  if (d.isTransaction) return fn();
  d.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (error) {
    d.exec("ROLLBACK");
    throw error;
  }
}
const parse = (row) => (row ? JSON.parse(row.data) : null);
export function resource(id) {
  return parse(
    database().prepare("SELECT data FROM resources WHERE id=?").get(id),
  );
}
export function resourceAt(file) {
  return parse(
    database()
      .prepare(
        "SELECT data FROM resources WHERE location=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(path.resolve(file)),
  );
}
export function resources({
  kind,
  lifecycle,
  owner,
  q,
  limit = Infinity,
} = {}) {
  return database()
    .prepare("SELECT data FROM resources ORDER BY rowid DESC")
    .all()
    .map(parse)
    .filter(
      (r) =>
        (!kind || r.kind === kind) &&
        (!lifecycle || r.lifecycle === lifecycle) &&
        (!owner || r.owner === owner) &&
        (!q ||
          `${r.title || ""} ${r.location || ""} ${r.kind}`
            .toLowerCase()
            .includes(String(q).toLowerCase())),
    )
    .slice(0, Math.max(0, Number(limit)));
}
export function putResource(
  input,
  { expectedRevision, allowInactive = false } = {},
) {
  const old = resource(input.id);
  if (old && expectedRevision != null && expectedRevision !== old.revision)
    throw fault("资源已被更新，请刷新后合并修改", 409);
  if (old && old.lifecycle !== "active" && !allowInactive)
    throw fault("资源已删除，不能写入", 409);
  const next = {
    lifecycle: "active",
    availability: "ready",
    owned: true,
    createdAt: stamp(),
    ...old,
    ...input,
    updatedAt: stamp(),
    revision: (old?.revision || 0) + 1,
  };
  if (
    next.owner &&
    !allowInactive &&
    resource(next.owner)?.lifecycle &&
    resource(next.owner).lifecycle !== "active"
  )
    throw fault("所属资源已删除，不能发布新文件", 409);
  transaction(() => {
    if (old)
      database()
        .prepare("INSERT OR IGNORE INTO versions VALUES(?,?,?)")
        .run(
          old.id,
          old.revision,
          JSON.stringify({
            ...old,
            ...(old.hash === next.hash && next.objectPath
              ? { objectPath: next.objectPath }
              : {}),
          }),
        );
    database()
      .prepare(
        `INSERT INTO resources VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,owner=excluded.owner,location=excluded.location,lifecycle=excluded.lifecycle,data=excluded.data`,
      )
      .run(
        next.id,
        next.kind,
        next.owner || null,
        next.location ? path.resolve(next.location) : null,
        next.lifecycle,
        JSON.stringify(next),
      );
    if (old?.owner && old.owner !== next.owner)
      database()
        .prepare(
          "DELETE FROM refs WHERE source=? AND target=? AND relation='owns'",
        )
        .run(old.owner, next.id);
    if (next.owner) link(next.owner, next.id, "owns");
  });
  events.emit("change", {
    type: "resource",
    id: next.id,
    revision: next.revision,
  });
  return next;
}
export function history(id) {
  return database()
    .prepare(
      "SELECT data FROM versions WHERE resource_id=? ORDER BY revision DESC",
    )
    .all(id)
    .map(parse)
    .map((v) => {
      if (v.objectPath || !v.hash) return v;
      const file = path.join(
        storageRoot,
        "objects",
        v.hash.slice(0, 2),
        v.hash,
      );
      return fs.existsSync(file) ? { ...v, objectPath: file } : v;
    });
}
export function link(source, target, relation = "uses") {
  database()
    .prepare("INSERT OR IGNORE INTO refs VALUES(?,?,?)")
    .run(source, target, relation);
}
export function unlink(source, target) {
  database()
    .prepare("DELETE FROM refs WHERE source=? AND target=?")
    .run(source, target);
}
export function dependencies(id) {
  return database()
    .prepare("SELECT * FROM refs WHERE source=? OR target=?")
    .all(id, id);
}
export function isActive(id) {
  const r = resource(id);
  return !r || r.lifecycle === "active";
}
export function assertActive(id) {
  if (!isActive(id)) throw fault("资源已移入回收站或正在清理", 409);
}
export function invalidate(id, reason = "上游内容更新") {
  const seen = new Set([id]),
    queue = [id];
  while (queue.length) {
    for (const ref of database()
      .prepare("SELECT source FROM refs WHERE target=? AND relation='derives'")
      .all(queue.shift())) {
      if (seen.has(ref.source)) continue;
      seen.add(ref.source);
      queue.push(ref.source);
      const r = resource(ref.source);
      if (r?.lifecycle === "active")
        putResource({ ...r, availability: "stale", staleReason: reason });
    }
  }
  const original = resource(id);
  if (original?.indexEnabled) putResource({ ...original, indexStale: true });
  events.emit("invalidate", { id, reason });
  return [...seen];
}
export function readState(key, fallback) {
  return (
    parse(database().prepare("SELECT data FROM states WHERE key=?").get(key)) ??
    fallback
  );
}
export function writeState(key, value, expectedRevision) {
  const old = database()
    .prepare("SELECT revision FROM states WHERE key=?")
    .get(key);
  if (expectedRevision != null && expectedRevision !== (old?.revision || 0))
    throw fault("状态已变化，请刷新后重试", 409);
  const revision = (old?.revision || 0) + 1;
  database()
    .prepare(
      "INSERT INTO states VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,revision=excluded.revision",
    )
    .run(key, JSON.stringify(value), revision);
  return { value, revision };
}
export function stateRevision(key) {
  return (
    database().prepare("SELECT revision FROM states WHERE key=?").get(key)
      ?.revision || 0
  );
}
export function job(id) {
  return parse(database().prepare("SELECT data FROM jobs WHERE id=?").get(id));
}
export function jobs(id) {
  return database()
    .prepare("SELECT data FROM jobs ORDER BY rowid DESC")
    .all()
    .map(parse)
    .filter((j) => !id || j.resourceId === id);
}
export function saveJob(input) {
  const next = {
    createdAt: stamp(),
    attempts: 0,
    completedStages: [],
    ...job(input.id),
    ...input,
    updatedAt: stamp(),
  };
  database()
    .prepare(
      "INSERT INTO jobs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,fingerprint=excluded.fingerprint,data=excluded.data",
    )
    .run(
      next.id,
      next.resourceId,
      next.status,
      next.fingerprint,
      JSON.stringify(next),
    );
  events.emit("change", { type: "job", id: next.id, status: next.status });
  return next;
}
export function operation(input) {
  const old = input.id
    ? parse(
        database()
          .prepare("SELECT data FROM operations WHERE id=?")
          .get(input.id),
      )
    : null;
  const next = {
    id: randomUUID(),
    createdAt: stamp(),
    ...old,
    ...input,
    updatedAt: stamp(),
  };
  database()
    .prepare(
      "INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
    )
    .run(next.id, next.status, JSON.stringify(next));
  return next;
}
export function operations() {
  return database()
    .prepare("SELECT data FROM operations ORDER BY rowid DESC")
    .all()
    .map(parse);
}
export function saveGeneration(g, rows) {
  transaction(() => {
    database()
      .prepare(
        "INSERT INTO generations VALUES(?,?,0,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(g.id, g.resourceId, JSON.stringify(g));
    if (rows) {
      database().prepare("DELETE FROM records WHERE generation_id=?").run(g.id);
      const insert = database().prepare("INSERT INTO records VALUES(?,?,?,?)");
      for (const row of rows)
        insert.run(row.id, g.id, row.kind, JSON.stringify(row));
    }
  });
}
export function generation(id) {
  return parse(
    database().prepare("SELECT data FROM generations WHERE id=?").get(id),
  );
}
export function published(id) {
  return parse(
    database()
      .prepare("SELECT data FROM generations WHERE resource_id=? AND active=1")
      .get(id),
  );
}
export function generations(id) {
  return database()
    .prepare("SELECT data FROM generations ORDER BY rowid DESC")
    .all()
    .map(parse)
    .filter((g) => !id || g.resourceId === id);
}
export function records(id, kind) {
  return database()
    .prepare("SELECT data FROM records WHERE generation_id=?")
    .all(id)
    .map(parse)
    .filter((r) => !kind || r.kind === kind);
}
export function record(id) {
  return parse(
    database().prepare("SELECT data FROM records WHERE id=?").get(id),
  );
}
export function publish(generationId, expectedRevision) {
  transaction(() => {
    const g = generation(generationId),
      r = resource(g.resourceId);
    assertActive(g.resourceId);
    if (r.revision !== expectedRevision)
      throw fault("资源版本变化，拒绝发布旧结果", 409);
    database()
      .prepare("UPDATE generations SET active=0 WHERE resource_id=?")
      .run(g.resourceId);
    database().prepare("UPDATE generations SET active=1 WHERE id=?").run(g.id);
    putResource({
      ...r,
      indexStale: false,
      publishedGeneration: g.id,
      indexedAt: stamp(),
      coverage: g.coverage,
    });
  });
}
