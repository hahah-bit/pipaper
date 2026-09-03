import fs from "node:fs";
import path from "node:path";
import { getConfig, PARSED_DIR } from "../config.js";
import { getPaper, writeParseState, readBlocks, getParseState } from "../store.js";
import { mdToBlocks, blocksToMd } from "./mdblocks.js";
import { parseMineru } from "./mineru.js";
import { parseUnstructured } from "./unstructured.js";
import { parseFallbackText } from "./fallback.js";

const jobs = new Map(); // jobId -> {id, paperId, engine, status, log[], error, startedAt, endedAt}

export function getJob(id) {
  return jobs.get(id);
}

function pushLog(job, msg) {
  job.log.push(msg);
  if (job.log.length > 200) job.log.shift();
  console.log(`[parse:${job.id.slice(0, 6)}] ${msg}`);
}

export function availableEngines() {
  const cfg = getConfig();
  const e = {
    mineru: { configured: cfg.parse.mineru.mode === "api" ? !!cfg.parse.mineru.token : cfg.parse.mineru.mode === "local", mode: cfg.parse.mineru.mode },
    unstructured: { configured: cfg.parse.unstructured.mode === "api" ? !!cfg.parse.unstructured.apiKey : cfg.parse.unstructured.mode === "local", mode: cfg.parse.unstructured.mode },
    fallback: { configured: true, mode: "builtin" },
  };
  return e;
}

export function resolveEngine(requested) {
  const cfg = getConfig();
  const av = availableEngines();
  if (requested && requested !== "auto") {
    if (!av[requested]?.configured) throw new Error(`解析引擎 ${requested} 未配置`);
    return requested;
  }
  for (const name of cfg.parse.engineOrder || ["mineru", "unstructured", "fallback"]) {
    if (av[name]?.configured) return name;
  }
  return "fallback";
}

async function runEngine(engine, paper, log) {
  if (!paper.pdfPath || !fs.existsSync(paper.pdfPath)) {
    throw new Error("找不到论文 PDF 文件（Zotero 附件缺失或未导入）");
  }
  if (engine === "mineru") {
    const { md, assets } = await parseMineru(paper.pdfPath, getConfig().parse.mineru, log);
    return finalizeMd(paper.id, md, assets, log);
  }
  if (engine === "unstructured") {
    const blocks = await parseUnstructured(paper.pdfPath, getConfig().parse.unstructured, log);
    return finalizeBlocks(paper.id, blocks, log);
  }
  const { blocks, pages } = await parseFallbackText(paper.pdfPath, {}, log);
  return finalizeBlocks(paper.id, blocks, log, pages);
}

async function finalizeMd(paperId, md, assets, log) {
  const dir = path.join(PARSED_DIR, paperId);
  const assetDir = path.join(dir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  const assetMap = {};
  for (const [name, buf] of assets || []) {
    const safe = name.replace(/[^\w.-]/g, "_");
    fs.writeFileSync(path.join(assetDir, safe), buf);
    assetMap[name] = "file/assets/" + safe;
  }
  const blocks = mdToBlocks(md, { assetMap });
  return { blocks, dir };
}

async function finalizeBlocks(paperId, blocks, log, pages) {
  const dir = path.join(PARSED_DIR, paperId);
  const assetDir = path.join(dir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  let imgN = 0;
  for (const b of blocks) {
    if (b.type === "image" && (b.src?.startsWith("__IMG__") || b.b64)) {
      imgN++;
      const name = `image-${imgN}.png`;
      fs.writeFileSync(path.join(assetDir, name), Buffer.from(b.b64, "base64"));
      delete b.b64;
      b.src = "file/assets/" + name;
    }
  }
  return { blocks, dir };
}

export function startParse(paperId, requestedEngine) {
  const paper = getPaper(paperId);
  if (!paper) throw new Error("论文不存在: " + paperId);
  if (jobs.size) {
    for (const j of jobs.values()) if (j.paperId === paperId && j.status === "running") throw new Error("该论文已在解析中");
  }
  const engine = resolveEngine(requestedEngine);
  const jobId = "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { id: jobId, paperId, engine, status: "running", log: [], error: null, startedAt: new Date().toISOString(), endedAt: null };
  jobs.set(jobId, job);
  writeParseState(paperId, { status: "running", engine, startedAt: job.startedAt, jobId });
  (async () => {
    try {
      const { blocks, dir } = await runEngine(engine, paper, (m) => pushLog(job, m));
      fs.writeFileSync(path.join(dir, "blocks.json"), JSON.stringify(blocks, null, 1));
      fs.writeFileSync(path.join(dir, "full.md"), blocksToMd(blocks));
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ engine, pages: Math.max(0, ...blocks.map((b) => b.page || 0)), blocks: blocks.length, finishedAt: new Date().toISOString() }, null, 2)
      );
      writeParseState(paperId, { status: "done", engine, finishedAt: new Date().toISOString(), jobId });
      job.status = "done";
      pushLog(job, `完成：${blocks.length} 个内容块`);
    } catch (err) {
      job.status = "error";
      job.error = String(err.message || err);
      pushLog(job, "出错：" + job.error);
      writeParseState(paperId, { status: "error", error: job.error, finishedAt: new Date().toISOString(), jobId });
    } finally {
      job.endedAt = new Date().toISOString();
    }
  })();
  return job;
}

export function paperWithParseStatus(p) {
  const st = readBlocks(p.id) ? getParseState(p.id) : null;
  return { ...p, parse: st ? { status: st.status, engine: st.engine, error: st.error || null } : { status: "none" } };
}
