import path from "node:path";
import { getConfig } from "../config.js";
import { getPaper, writeParseState, readBlocks, getParseState, parsedDir } from "../store.js";
import { executePipeline } from "./pipeline.js";
import { snapshotLegacy, createRun, saveResult, activateVersion, jsonWrite, listVersions } from "./versions.js";

const jobs = new Map();
export const getJob = (id) => jobs.get(id);
export function availableEngines() {
  const cfg = getConfig().parse;
  const configured = (c) => c.mode === "local" || c.mode === "api" && Boolean(c.token || c.apiKey);
  return { hybrid: { configured: true }, mineru: { configured: configured(cfg.mineru) }, unstructured: { configured: configured(cfg.unstructured) }, fallback: { configured: true } };
}
export function resolveEngine(requested = "hybrid") {
  if (requested === "auto") {
    const av = availableEngines();
    return (getConfig().parse.engineOrder || ["mineru", "unstructured", "fallback"]).find((name) => av[name]?.configured) || "fallback";
  }
  if (!availableEngines()[requested]?.configured) throw new Error("解析引擎未配置: " + requested);
  return requested;
}
export function isParsing(paperId) {
  return [...jobs.values()].some((j) => parsedDir(j.paperId) === parsedDir(paperId) && j.status === "running");
}
export function startParse(paperId, requestedEngine = "hybrid", replayFrom) {
  const paper = getPaper(paperId);
  if (!paper) throw new Error("论文不存在");
  if (isParsing(paperId)) throw new Error("该论文已在解析中");
  const engine = resolveEngine(requestedEngine);
  snapshotLegacy(paperId);
  const previousVersion = listVersions(paperId).active;
  const run = createRun(paperId, engine);
  const job = { id: run.id, versionId: run.id, paperId, engine, status: "running", log: [], startedAt: run.createdAt };
  const log = (msg) => { job.log.push(msg); console.log("[parse:" + run.id + "] " + msg); };
  jobs.set(job.id, job);
  writeParseState(paperId, { status: "running", engine, error: null, jobId: job.id, startedAt: job.startedAt });
  (async () => {
    try {
      const doc = await executePipeline(paper, engine, run, log, replayFrom);
      const result = saveResult(run, doc);
      job.quality = doc.quality;
      job.status = result.status === "ready" ? "done" : "review";
      job.activated = result.status === "ready" && !previousVersion;
      if (job.activated) activateVersion(paperId, run.id);
      log(result.status === "ready" ? job.activated ? "完成并采用首个解析版本" : "新版本已保存，当前版本不变；预览后可采用" : "结构校验未通过，保留当前版本；请查看质量报告");
      log(doc.blocks.length + " 个内容块，" + doc.pages.length + " 页，" + doc.quality.errors.length + " 个结构错误，" + doc.quality.warnings.length + " 项待核对");
      writeParseState(paperId, { status: job.status, engine, jobId: job.id, versionId: run.id, finishedAt: new Date().toISOString() });
    } catch (e) {
      job.status = "error";
      job.error = String(e.message || e);
      log("解析失败，当前版本保持可用: " + job.error);
      jsonWrite(path.join(run.dir, "run.json"), { id: run.id, engine, createdAt: run.createdAt, status: "error", error: job.error });
      writeParseState(paperId, { status: "error", engine, error: job.error, jobId: job.id });
    } finally { job.endedAt = new Date().toISOString(); }
  })();
  return job;
}
export function paperWithParseStatus(p) {
  const doc = readBlocks(p.id);
  const job = getParseState(p.id);
  return { ...p, parse: doc ? { status: job?.status === "running" ? "running" : "done", engine: doc.meta?.engine || job?.engine, versionId: doc.meta?.versionId, warnings: doc.quality?.warnings?.length || 0 } : { status: job?.status || "none", error: job?.error || null } };
}
