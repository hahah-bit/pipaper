import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getPaper, writeParseState, readBlocks, getParseState, parsedDir } from "../store.js";
import { mdToBlocks, blocksToMd } from "./mdblocks.js";
import { parseMineru } from "./mineru.js";
import { parseUnstructured } from "./unstructured.js";
import { parseFallbackText } from "./fallback.js";
import { extractFigureElements, cropFigure } from "./elements-fallback.js";
import { parseMiddleJson, parseContentList, attachPositions, mergeBlocks, attachNaturalSize } from "./merge.js";

// Two-layer parse pipeline. The intermediate representation (blocks.json v2)
// is a page-anchored stream of content blocks:
//   {type:'heading'|'para'|'table'|'image'|'formula'|'code',
//    page: 1-based, bbox: [x0,y0(top),x1,y1(bottom)] at scale 1 (when known)}
// Layer 1 = text flow; layer 2 = positioned elements (images/tables/formulas);
// mergeBlocks() interleaves them by (page, y) so elements render in place.

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

function ensureAssetDir(paperId) {
  const dir = parsedDir(paperId);
  const assetDir = path.join(dir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  return { dir, assetDir };
}

function assetSaver(paperId, used = new Set()) {
  const { assetDir } = ensureAssetDir(paperId);
  return (srcPathOrName, buf) => {
    const base = path.basename(String(srcPathOrName)).replace(/[^\w.-]/g, "_") || "img.png";
    let name = base;
    let n = 1;
    while (used.has(name)) name = base.replace(/(\.\w+)?$/, `-${n++}$&`);
    used.add(name);
    if (buf) fs.writeFileSync(path.join(assetDir, name), buf);
    return "file/assets/" + name;
  };
}

// ---------------- engines: return {flow, elements} ----------------

async function runMineru(paper, log) {
  const { md, assets, middleJson, contentList } = await parseMineru(paper.pdfPath, getConfig().parse.mineru, log);
  const saveAsset = assetSaver(paper.id);
  const flow = mdToBlocks(md, { assetMap: {} });
  // rewrite asset paths in md blocks (md references images/<name>)
  const assetMap = {};
  for (const [name] of assets) assetMap[name] = "file/assets/" + name;
  for (const b of flow) if (b.type === "image" && b.src) {
    const base = b.src.split("/").pop();
    if (assetMap[base] && assets.has(base)) {
      saveAsset(base, assets.get(base));
      b.src = assetMap[base];
    }
  }
  let elements = [];
  let posFlow = null;
  if (contentList) {
    log("发现 content_list：启用第二层定位（块级坐标 + 元素插回）…");
    const parsed = parseContentList(contentList);
    posFlow = parsed.flow;
    elements = parsed.elements;
  } else if (middleJson) {
    log("发现 middle.json：启用第二层定位（块级坐标 + 元素插回）…");
    const parsed = parseMiddleJson(middleJson);
    posFlow = parsed.flow;
    elements = parsed.elements;
  }
  if (posFlow) {
    attachPositions(flow, posFlow);
    // save positioned element images into assets and rewrite src
    for (const e of elements) {
      if (e.type === "image" && e.src) {
        const base = String(e.src).split("/").pop();
        if (assets.has(base)) e.src = saveAsset(base, assets.get(base));
        else e.src = saveAsset(base);
      }
    }
    // the element layer supersedes the md layer for figures/tables/display
    // formulas — drop those from the md flow to avoid duplicates
    const flowFiltered = flow.filter((b) => !(b.type === "image" || b.type === "table" || b.type === "formula"));
    return { flow: flowFiltered, elements };
  }
  log("无定位信息（API 包未含 content_list/middle）：按 md 内嵌元素单层输出");
  return { flow, elements: [], inline: true };
}

function rectsOverlap(a, b, pad = 0) {
  return !(a[2] < b[0] - pad || b[2] < a[0] - pad || a[3] < b[1] - pad || b[3] < a[1] - pad);
}

async function runUnstructured(paper, log) {
  const blocks = await parseUnstructured(paper.pdfPath, getConfig().parse.unstructured, log);
  // single source, already element-level with page + bbox — normalize bbox from coordinates
  for (const b of blocks) {
    if (!b.bbox && b.coordinates) {
      const pts = b.coordinates;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      b.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
  return { flow: blocks, elements: [], inline: true };
}

async function runFallback(paper, log) {
  const { blocks } = await parseFallbackText(paper.pdfPath, {}, log);
  log("第二层：扫描图注并裁剪原图区域…");
  let elements = [];
  try {
    const figs = await extractFigureElements(paper.pdfPath, log);
    const saveAsset = assetSaver(paper.id);
    for (const f of figs) {
      try {
        const crop = await cropFigure(paper.pdfPath, f);
        if (!crop) continue;
        const src = saveAsset(`fig-${f.page}-${f.bbox[1] | 0}.png`, crop.buffer);
        elements.push({ type: "image", page: f.page, bbox: f.bbox, src, caption: f.caption });
      } catch {}
    }
    log(`第二层完成：裁出 ${elements.length} 张图`);
  } catch (e) {
    log("第二层（图表裁剪）失败，降级为纯文本：" + (e.message || e));
  }
  return { flow: blocks, elements };
}

async function runEngine(engine, paper, logFn) {
  let r;
  if (engine === "mineru") r = await runMineru(paper, logFn);
  else if (engine === "unstructured") r = await runUnstructured(paper, logFn);
  else r = await runFallback(paper, logFn);
  const { flow, elements } = r;
  const merged = r.inline ? flow : mergeBlocks(flow, elements);
  return merged;
}

export function startParse(paperId, requestedEngine) {
  const paper = getPaper(paperId);
  if (!paper) throw new Error("论文不存在: " + paperId);
  if (jobs.size) {
    for (const j of jobs.values()) if (j.paperId === paperId && j.status === "running") throw new Error("该论文已在解析中");
  }
  const engine = resolveEngine(requestedEngine);
  const jobId = "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const jb = { id: jobId, paperId, engine, status: "running", log: [], error: null, startedAt: new Date().toISOString(), endedAt: null };
  jobs.set(jobId, jb);
  writeParseState(paperId, { status: "running", engine, startedAt: jb.startedAt, jobId });
  (async () => {
    try {
      const blocks = await runEngine(engine, paper, (m) => pushLog(jb, m));
      const { dir } = ensureAssetDir(paperId);
      attachNaturalSize(blocks, dir);
      const meta = { v: 2, engine, elements: blocks.filter((b) => b.type === "image" || b.type === "table" || b.type === "formula").length, positioned: blocks.filter((b) => b.bbox).length, blocks: blocks.length, finishedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, "blocks.json"), JSON.stringify({ v: 2, meta, blocks }, null, 1));
      fs.writeFileSync(path.join(dir, "full.md"), blocksToMd(blocks));
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
      writeParseState(paperId, { status: "done", engine, finishedAt: new Date().toISOString(), jobId });
      jb.status = "done";
      pushLog(jb, `完成：${blocks.length} 个内容块（图/表/公式 ${meta.elements} 个，带坐标 ${meta.positioned} 个）`);
    } catch (err) {
      jb.status = "error";
      jb.error = String(err.message || err);
      pushLog(jb, "出错：" + jb.error);
      writeParseState(paperId, { status: "error", error: jb.error, finishedAt: new Date().toISOString(), jobId });
    } finally {
      jb.endedAt = new Date().toISOString();
    }
  })();
  return jb;
}

export function paperWithParseStatus(p) {
  const st = readBlocks(p.id) ? getParseState(p.id) : null;
  return { ...p, parse: st ? { status: st.status, engine: st.engine, error: st.error || null } : { status: "none" } };
}
