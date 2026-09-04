import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parsedDir } from "../store.js";
import { blocksToMd } from "./mdblocks.js";

const validId = (id) => /^v_[a-zA-Z0-9_-]+$/.test(id);
export function versionDir(paperId, id) {
  if (!validId(id)) throw new Error("无效的解析版本");
  return path.join(parsedDir(paperId), "versions", id);
}
export function jsonWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
export function readVersion(paperId, id) {
  return JSON.parse(fs.readFileSync(path.join(versionDir(paperId, id), "blocks.json"), "utf8"));
}
export function listVersions(paperId) {
  const root = parsedDir(paperId);
  let active = null;
  try { active = JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8")).versionId; } catch {}
  const dir = path.join(root, "versions");
  const versions = fs.existsSync(dir) ? fs.readdirSync(dir).filter(validId).flatMap((id) => {
    try { return [{ ...JSON.parse(fs.readFileSync(path.join(dir, id, "run.json"), "utf8")), active: id === active, replayable: ["mineru", "unstructured"].some((engine) => fs.existsSync(path.join(dir, id, "raw", engine + ".json"))) }]; }
    catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  return { active, versions };
}
export function activateVersion(paperId, id) {
  const dir = versionDir(paperId, id);
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  if (!["ready", "legacy"].includes(run.status)) throw new Error("此版本尚未通过结构校验，不能采用");
  const doc = readVersion(paperId, id);
  if (!fs.existsSync(path.join(dir, "full.md"))) throw new Error("版本内容不完整");
  if (run.contentHash) {
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    if (hash(fs.readFileSync(path.join(dir, "full.md"))) !== run.contentHash || hash(blocksToMd(doc.blocks)) !== run.contentHash) throw new Error("版本内容校验失败，保留当前版本");
  }
  const root = parsedDir(paperId);
  const temp = path.join(root, `current-${randomUUID()}.tmp`);
  jsonWrite(temp, { versionId: id });
  fs.renameSync(temp, path.join(root, "current.json"));
  return run;
}
export function createRun(paperId, engine) {
  const id = "v_" + Date.now().toString(36) + "_" + randomUUID().slice(0, 8);
  const dir = versionDir(paperId, id);
  const run = { id, engine, status: "running", createdAt: new Date().toISOString() };
  jsonWrite(path.join(dir, "run.json"), run);
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  return { ...run, dir };
}
export function snapshotLegacy(paperId) {
  const root = parsedDir(paperId);
  if (fs.existsSync(path.join(root, "current.json")) || !fs.existsSync(path.join(root, "blocks.json"))) return;
  const run = createRun(paperId, "legacy");
  const source = JSON.parse(fs.readFileSync(path.join(root, "blocks.json"), "utf8"));
  jsonWrite(path.join(run.dir, "raw", "legacy-blocks.json"), source);
  if (fs.existsSync(path.join(root, "full.md"))) fs.copyFileSync(path.join(root, "full.md"), path.join(run.dir, "raw", "legacy-full.md"));
  if (fs.existsSync(path.join(root, "assets"))) fs.cpSync(path.join(root, "assets"), path.join(run.dir, "assets"), { recursive: true });
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "src" && typeof v === "string" ? v.replace(/^file\/assets\//, `file/versions/${run.id}/assets/`) : rewrite(v)]));
    return value;
  };
  const doc = rewrite(source);
  jsonWrite(path.join(run.dir, "blocks.json"), doc);
  fs.writeFileSync(path.join(run.dir, "full.md"), blocksToMd(Array.isArray(doc) ? doc : doc.blocks));
  jsonWrite(path.join(run.dir, "run.json"), { id: run.id, engine: source.meta?.engine || "legacy", status: "legacy", createdAt: run.createdAt, blocks: (source.blocks || source).length, note: "升级前快照，未重新解析" });
  activateVersion(paperId, run.id);
}
export function saveResult(run, doc) {
  const md = blocksToMd(doc.blocks);
  doc.meta.contentHash = createHash("sha256").update(md).digest("hex");
  doc.meta.versionId = run.id;
  jsonWrite(path.join(run.dir, "blocks.json"), doc);
  fs.writeFileSync(path.join(run.dir, "full.md"), md);
  jsonWrite(path.join(run.dir, "quality.json"), doc.quality);
  const info = { id: run.id, createdAt: run.createdAt, finishedAt: new Date().toISOString(), engine: run.engine, status: doc.quality.errors.length ? "review" : "ready", blocks: doc.blocks.length, quality: doc.quality, contentHash: doc.meta.contentHash, engines: doc.meta.engines };
  jsonWrite(path.join(run.dir, "run.json"), info);
  return info;
}
