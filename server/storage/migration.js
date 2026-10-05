import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, LIBRARY_DIR, PARSED_DIR, APP_ROOT } from "../config.js";
import {
  resources,
  resource,
  resourceAt,
  putResource,
  link,
  readState,
  writeState,
  storageRoot,
  operations,
  operation,
  jobs,
  saveJob,
  database,
} from "./catalog.js";
import {
  registerFile,
  writeJson,
  writeFile,
  finishDirectory,
  trash,
  restore,
  fileId,
  infer,
} from "./files.js";
import { scanLayout } from "./scan.js";

const knowledgeRoot =
  process.env.PIPAPER_KNOWLEDGE_DIR || path.join(APP_ROOT, "knowledge");
function scan(root, kind, owner = null) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, e.name);
    if (e.isSymbolicLink()) {
      files.push({ file, kind, owner, issue: "linked-path" });
      continue;
    }
    if (e.isDirectory()) files.push(...scan(file, kind, owner));
    else files.push({ file, kind, owner });
  }
  return files;
}
export function migrationReport(papers = []) {
  return scanLayout({
    dataDir: DATA_DIR,
    libraryDir: LIBRARY_DIR,
    knowledgeDir: knowledgeRoot,
    papers,
  });
}
export function migrateStorage(papers = []) {
  if (readState("storage-migration-v3", null)) {
    for (const paper of papers) registerPaper(paper);
    return readState("storage-migration-v3");
  }
  const report = migrationReport(papers);
  const backup = path.join(
    storageRoot,
    "migration-backup",
    "catalog-before-migration.sqlite",
  );
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!fs.existsSync(backup))
    database().exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
  writeJson(path.join(storageRoot, "migration-report.json"), report, {
    kind: "migration-report",
  });
  for (const item of report.files.filter((f) => !f.issue)) {
    let availability;
    if (/\.json$/i.test(item.file) && fs.existsSync(item.file))
      try {
        JSON.parse(fs.readFileSync(item.file, "utf8"));
      } catch {
        availability = "damaged";
      }
    registerFile(item.file, {
      ...item,
      owner: item.owner || infer(item.file).owner || null,
      ...(availability ? { availability } : {}),
    });
  }
  for (const p of papers) registerPaper(p);
  for (const [kind, base] of [
    ["study", path.join(DATA_DIR, "studies")],
    ["topic", path.join(DATA_DIR, "topic-analysis", "tasks")],
  ]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())) {
      const folder = path.join(base, entry.name),
        file = path.join(folder, "task.json");
      let metadata;
      try {
        metadata = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      registerFile(folder, {
        id: kind + ":" + entry.name,
        kind,
        title: metadata?.title || entry.name,
        metadata,
        availability: metadata ? "ready" : "needs_review",
      });
    }
  }
  for (const item of report.files.filter(
    (f) => f.kind === "knowledge" && /\.md$/i.test(f.file),
  ))
    registerKnowledge(item.file, {
      sourceType: item.file.replaceAll("\\", "/").includes("/论文研读/")
        ? "study"
        : item.file.replaceAll("\\", "/").includes("/选题报告/")
          ? "topic"
          : "note",
    });
  const result = {
    schemaVersion: 3,
    migratedAt: new Date().toISOString(),
    count: report.files.length,
    missing: report.missing.length,
    damaged: report.damaged.length,
    warnings: report.warnings.length,
  };
  writeState("storage-migration-v3", result);
  return result;
}
export function registerPaper(paper) {
  const id = "paper:" + paper.id,
    old = resource(id);
  if (old && old.lifecycle !== "active") return old;
  const changed =
    old?.metadata?.contentHash &&
    old.metadata.contentHash !== paper.contentHash;
  const r = paper.pdfPath
    ? registerFile(paper.pdfPath, {
        id,
        kind: "original",
        title: paper.title,
        paperId: paper.id,
        sourceType: "original",
        metadata: paper,
        hash: paper.contentHash,
        versionId: paper.contentHash || null,
        owned: paper.source !== "zotero",
        indexStale: changed || old?.indexStale || false,
        availability: "ready",
        orphan: false,
      })
    : putResource({
        ...old,
        id,
        kind: "original",
        title: paper.title,
        metadata: paper,
        availability: "missing",
        owned: false,
      });
  // Metadata-only changes are part of document identity, even with unchanged bytes.
  if (JSON.stringify(r.metadata) !== JSON.stringify(paper))
    putResource({ ...r, title: paper.title, metadata: paper });
  const key = paper.contentHash
    ? "h_" + paper.contentHash.slice(0, 24)
    : paper.id;
  const root = path.join(PARSED_DIR, key);
  if (fs.existsSync(root)) {
    registerFile(root, { id: "parse:" + key, kind: "parse-root" });
    link(id, "parse:" + key, "uses");
    link(id, "parse:" + key, "owns");
  }
  return resource(id);
}
export function registerKnowledge(file, metadata = {}) {
  const old = resourceAt(file) || resource(fileId(file));
  let origin;
  try {
    origin = JSON.parse(
      fs.readFileSync(path.join(path.dirname(file), "meta.json"), "utf8"),
    );
  } catch {}
  return registerFile(file, {
    ...old,
    id: old?.id || fileId(file),
    kind: "knowledge",
    sourceType: metadata.sourceType || old?.sourceType || "note",
    title: metadata.title || old?.title || path.basename(file),
    sourcePaperId:
      metadata.sourcePaperId || old?.sourcePaperId || origin?.paperId || null,
    ...metadata,
  });
}
export function recoverStorage() {
  for (const j of jobs().filter((j) =>
    ["running", "queued"].includes(j.status),
  ))
    saveJob({
      ...j,
      status: "interrupted",
      error: "服务重启中断了操作，可从检查点继续",
      epoch: (j.epoch || 0) + 1,
    });
  for (const op of operations().filter((op) => op.status === "pending")) {
    try {
      if (op.type === "trash") {
        trash(op.resourceId);
        continue;
      }
      if (op.type === "restore") {
        restore(op.resourceId);
        continue;
      }
      if (op.type === "directory-publish") {
        if (op.staged) finishDirectory(op);
        else
          operation({
            ...op,
            status: "failed",
            error: "旧操作没有检查点，请重新导出",
          });
        continue;
      }
      if (op.type !== "write") continue;
      const current = resource(op.resourceId);
      if (current && current.lifecycle !== "active") {
        operation({
          ...op,
          status: "cancelled",
          error: "资源已删除，拒绝恢复迟到写入",
        });
        continue;
      }
      if (!fs.existsSync(op.objectPath)) throw new Error("恢复内容缺失");
      if (current?.objectPath !== op.objectPath) {
        if (
          op.baseRevision == null ||
          (current?.revision || 0) !== op.baseRevision
        ) {
          operation({
            ...op,
            status: "cancelled",
            error: "资源修订变化，拒绝恢复旧写入",
          });
          continue;
        }
        writeFile(op.location, fs.readFileSync(op.objectPath), {
          ...op.metadata,
          id: op.resourceId,
          expectedRevision: op.baseRevision,
        });
      }
      operation({ ...op, status: "succeeded", recovered: true });
    } catch (e) {
      operation({ ...op, status: "failed", error: e.message });
    }
  }
}
export function roots() {
  return {
    data: DATA_DIR,
    originals: LIBRARY_DIR,
    parsed: PARSED_DIR,
    knowledge: knowledgeRoot,
  };
}
