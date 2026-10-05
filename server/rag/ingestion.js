import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { marked } from "marked";
import { getConfig } from "../config.js";
import { getPaper, parsedDir, readBlocks } from "../store.js";
import { mdToBlocks } from "../parser/mdblocks.js";
import { executePipeline } from "../parser/pipeline.js";
import { createRun, saveResult, listVersions } from "../parser/versions.js";
import { renderPageCrop } from "../parser/render.js";
import {
  normalizeDocument,
  chunkDocument,
  validateCandidate,
  textOf,
} from "./document.js";
import {
  modelJson,
  expand,
  embed,
  waiting,
  expansionPromptVersion,
} from "./providers.js";
import { vectorIndex } from "./milvus.js";
import {
  resource,
  resourceAt,
  putResource,
  jobs,
  job,
  saveJob,
  readState,
  writeState,
  storageRoot,
  digest,
  fault,
  events,
  records,
  saveGeneration,
  publish,
  published,
  link,
} from "../storage/catalog.js";
import { asset, writeJson, writeFile } from "../storage/files.js";

export const stages = [
  "parse",
  "repair",
  "normalize",
  "chunk",
  "expand",
  "embed",
  "index",
  "publish",
];
const runners = new Map();
const mime = (file) =>
  ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  })[path.extname(file).toLowerCase()] || "image/png";
const terminal = new Set(["succeeded", "failed", "cancelled"]);
function inputOf(r) {
  return {
    hash: r.hash,
    versionId: r.versionId || r.hash,
    parseVersion: r.paperId ? listVersions(r.paperId).active : null,
  };
}
function fingerprints(r, input) {
  const cfg = getConfig(),
    parts = [
      cfg.parse,
      [cfg.rag.vision, r.reviewRevision || 0, "repair-v2"],
      "normalize-v3",
      cfg.rag.chunk,
      [cfg.rag.expansion, cfg.rag.expansionModel, expansionPromptVersion],
      cfg.rag.embedding,
      cfg.rag.milvus,
      "publish-v1",
    ];
  let previous = digest([r.id, input]);
  return stages.map((stage, i) => ({
    stage,
    key: (previous = digest([previous, parts[i]])),
  }));
}
export function startIngestion(
  resourceId,
  { force = false, schedule = true, rebuildIndex = false } = {},
) {
  let r = resource(resourceId);
  if (!r || r.lifecycle !== "active") throw fault("资源不可用", 404);
  if (
    !r.location ||
    r.directory ||
    !/\.(pdf|md|markdown|txt|json)$/i.test(r.location) ||
    !["original", "knowledge", "report"].includes(r.kind)
  )
    throw fault("请选择 PDF、Markdown 笔记或已保存报告", 422);
  const input = inputOf(r),
    keys = fingerprints(r, input),
    fingerprint = keys.at(-1).key;
  const existing = jobs(resourceId).find(
    (j) =>
      j.type === "ingestion" &&
      j.fingerprint === fingerprint &&
      !["failed", "cancelled"].includes(j.status),
  );
  if (existing && !force && !rebuildIndex) {
    if (["interrupted", "blocked"].includes(existing.status))
      return controlJob(existing.id, "resume");
    return existing;
  }
  for (const j of jobs(resourceId).filter(
    (j) => j.type === "ingestion" && !terminal.has(j.status),
  ))
    controlJob(j.id, "cancel");
  if (!r.indexEnabled) r = putResource({ ...r, indexEnabled: true });
  const id = "ing_" + randomUUID(),
    generationId = "g_" + randomUUID();
  const created = saveJob({
    id,
    type: "ingestion",
    resourceId,
    status: "queued",
    stage: "parse",
    progress: 0,
    epoch: 0,
    revision: r.revision,
    input,
    fingerprint,
    keys,
    generationId,
    force,
    completedStages: [],
    attempts: 0,
  });
  if (schedule) dispatch(id);
  return created;
}
export function controlJob(id, action) {
  const old = job(id);
  if (!old || old.type !== "ingestion") throw fault("入库任务不存在", 404);
  if (["pause", "cancel"].includes(action)) {
    if (terminal.has(old.status)) return old;
    const next = saveJob({
      ...old,
      status: action === "pause" ? "paused" : "cancelled",
      epoch: (old.epoch || 0) + 1,
    });
    runners.get(id)?.abort();
    return next;
  }
  if (!["resume", "retry"].includes(action)) throw fault("无效任务操作");
  const r = resource(old.resourceId);
  if (!r || r.lifecycle !== "active" || r.revision !== old.revision)
    return startIngestion(old.resourceId, { force: true });
  if (old.status === "succeeded" || runners.has(id)) return old;
  const next = saveJob({
    ...old,
    status: "queued",
    error: null,
    epoch: (old.epoch || 0) + 1,
    attempts: old.attempts + 1,
  });
  dispatch(id);
  return next;
}
function dispatch(id) {
  const controller = new AbortController();
  runners.set(id, controller);
  setImmediate(() =>
    runJob(id, { signal: controller.signal })
      .catch(() => {})
      .finally(() => runners.delete(id)),
  );
}
function guard(j, signal) {
  signal?.throwIfAborted();
  const current = job(j.id),
    r = resource(j.resourceId);
  if (
    current?.epoch !== j.epoch ||
    !["running", "queued"].includes(current?.status) ||
    r?.lifecycle !== "active" ||
    r.revision !== j.revision
  )
    throw Object.assign(fault("任务或文献版本已变化，拒绝旧结果", 409), {
      obsolete: true,
    });
  return r;
}
const checkpointKey = (key) => "ingestion-stage:" + key;
export async function runJob(
  id,
  { signal = new AbortController().signal, services = {} } = {},
) {
  let j = job(id);
  if (!j || !["queued", "interrupted", "running"].includes(j.status)) return j;
  j = saveJob({ ...j, status: "running", error: null });
  const cfg = structuredClone(getConfig().rag),
    values = {};
  const mark = (patch) => {
    guard(j, signal);
    j = saveJob({ ...j, ...patch });
  };
  try {
    const r = guard(j, signal);
    mark({ stage: "configuration", detail: "检查 Embedding 与 Milvus 连接" });
    if (!services.embed)
      await embed(["PiPaper embedding connectivity check"], {
        type: "query",
        signal,
        config: cfg.embedding,
        cache: false,
      });
    if (!services.index) await vectorIndex(cfg).ready();
    for (const [i, stage] of stages.entries()) {
      guard(j, signal);
      mark({ stage, progress: Math.floor((i / stages.length) * 100) });
      const key = checkpointKey(j.keys[i].key),
        cached = !j.force && readState(key, null);
      if (cached && !["index", "publish"].includes(stage))
        values[stage] = cached;
      else {
        if (stage === "parse") {
          values.parse = await (services.parse || parseSource)(r, j, signal);
          if (
            r.paperId &&
            !j.input.parseVersion &&
            listVersions(r.paperId).active
          ) {
            const input = {
                ...j.input,
                parseVersion: listVersions(r.paperId).active,
              },
              keys = fingerprints(r, input);
            mark({ input, keys, fingerprint: keys.at(-1).key });
          }
        }
        if (stage === "repair")
          values.repair = await (services.repair || repairSource)(
            r,
            values.parse,
            j,
            signal,
            mark,
          );
        if (stage === "normalize")
          values.normalize = normalizeDocument(values.parse, {
            resourceId: r.id,
            versionId: j.input.versionId,
            generationId: j.generationId,
            repairs: values.repair,
          });
        if (stage === "chunk")
          values.chunk = chunkDocument(values.normalize, cfg.chunk);
        if (stage === "expand") {
          values.expand = {};
          if (cfg.expansion)
            for (const [n, chunk] of values.chunk.entries()) {
              guard(j, signal);
              values.expand[chunk.id] = await (services.expand || expand)(
                chunk,
                r.title || "",
                { signal },
              );
              mark({ detail: `扩写 ${n + 1}/${values.chunk.length}` });
            }
        }
        if (stage === "embed") {
          const representations = representationRows(r, j, values);
          if (!values.chunk.length)
            throw Object.assign(
              fault("没有可核验的正文块，请处理待核对内容后重试", 422),
              { waitingReview: true },
            );
          const vectors = await (services.embed || embed)(
            representations.map((x) => x.text),
            { signal, config: cfg.embedding },
          );
          values.embed = representations.map((row, n) => ({
            ...row,
            dense_vector: vectors[n],
          }));
        }
        if (stage === "index") {
          guard(j, signal);
          const generation = persistGeneration(r, j, cfg, values);
          await (services.index || vectorIndex(cfg)).write(
            generation,
            values.embed,
            {
              signal,
              onBatch: (n, total) => mark({ detail: `写入索引 ${n}/${total}` }),
            },
          );
          values.index = generation;
        }
        if (stage === "publish") {
          guard(j, signal);
          publish(j.generationId, j.revision);
          values.publish = { generationId: j.generationId };
        }
        // Cache only deterministic/source-bound values. Rebase generated IDs on reuse below.
        if (!["index", "publish"].includes(stage)) {
          guard(j, signal);
          writeState(key, values[stage]);
          writeJson(
            path.join(storageRoot, "rag", j.id, stage + ".json"),
            values[stage],
            { kind: "rag-checkpoint", owner: j.resourceId },
          );
        }
      }
      if (cached && ["normalize", "chunk", "expand", "embed"].includes(stage)) {
        // IDs must remain consistent across a resumed or configuration-only rebuild.
        // The generation ID used by cached normalization becomes this job's generation ID.
        if (
          stage === "normalize" &&
          values.normalize.generationId !== j.generationId
        ) {
          // Element/chunk hashes cannot be string-replaced: rebuild normalization/chunk IDs.
          values.normalize = normalizeDocument(values.parse, {
            resourceId: r.id,
            versionId: j.input.versionId,
            generationId: j.generationId,
            repairs: values.repair,
          });
        }
        if (stage === "chunk")
          values.chunk = chunkDocument(values.normalize, cfg.chunk);
        if (stage === "expand") {
          const byOrder = Object.values(cached);
          values.expand = Object.fromEntries(
            values.chunk.map((c, n) => [c.id, byOrder[n]]),
          );
        }
        if (stage === "embed") {
          const fresh = representationRows(r, j, values);
          if (fresh.length !== cached.length)
            throw fault("缓存表示数量变化，请重新入库", 409);
          const changed = fresh
            .map((row, n) => (row.text === cached[n].text ? -1 : n))
            .filter((n) => n >= 0);
          const vectors = changed.length
            ? await (services.embed || embed)(
                changed.map((n) => fresh[n].text),
                { signal },
              )
            : [];
          values.embed = fresh.map((row, n) => ({
            ...row,
            dense_vector: changed.includes(n)
              ? vectors[changed.indexOf(n)]
              : cached[n].dense_vector,
          }));
        }
      }
      if (stage === "chunk") {
        guard(j, signal);
        persistGeneration(r, j, cfg, values);
      }
      if (stage !== "publish")
        mark({ completedStages: [...new Set([...j.completedStages, stage])] });
    }
    return saveJob({
      ...job(id),
      status: "succeeded",
      stage: "publish",
      progress: 100,
      completedStages: stages,
      finishedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    const current = job(id);
    if (["cancelled", "paused"].includes(current?.status)) return current;
    const status = error.obsolete
      ? "cancelled"
      : error.waitingConfiguration
        ? "blocked"
        : "failed";
    return saveJob({
      ...current,
      status,
      error: error.message,
      waitingFor: error.waitingReview
        ? "review"
        : error.waitingConfiguration
          ? "configuration"
          : null,
    });
  }
}
function persistGeneration(r, j, cfg, values) {
  const normalized = values.normalize;
  const generation = {
    id: j.generationId,
    resourceId: r.id,
    versionId: j.input.versionId,
    parseVersion: values.parse.meta?.versionId,
    sourceType: r.sourceType,
    sourceMetadata: r.metadata || {},
    sourceCreatedAt: r.createdAt,
    sourceRevision: j.revision,
    inputFingerprint: j.fingerprint,
    config: cfg,
    createdAt: new Date().toISOString(),
    coverage: {
      total: normalized.texts.length + normalized.elements.length,
      review: normalized.reviews.length,
      chunks: values.chunk.length,
      partial: normalized.reviews.length > 0,
    },
    indexCounts: [
      (values.embed || []).filter((row) => row.kind === "chunk").length,
      (values.embed || []).filter((row) => row.kind !== "chunk").length,
    ],
  };
  saveGeneration(generation, [
    ...normalized.sections.map((s) => ({
      ...s,
      id: `${j.generationId}:${s.id}`,
      nodeId: s.id,
      kind: "section",
    })),
    ...normalized.texts,
    ...normalized.elements,
    ...values.chunk,
    ...normalized.reviews.map((v, n) => ({
      ...v,
      id: `${j.generationId}:review:${n}`,
      kind: "review",
      targetId: v.id,
      decision: "pending",
    })),
    ...Object.entries(values.expand || {}).map(([chunkId, v]) => ({
      ...v,
      id: `${j.generationId}:expansion:${chunkId}`,
      kind: "expansion",
      chunkId,
    })),
  ]);
  return generation;
}
function representationRows(r, j, values) {
  const rows = [],
    push = (canonical_id, kind, variant, text) =>
      rows.push({
        id: "v_" + digest([j.generationId, canonical_id, variant]).slice(0, 48),
        resource_id: r.id,
        generation_id: j.generationId,
        canonical_id,
        kind,
        variant,
        source_type: r.sourceType || "original",
        text,
      });
  for (const c of values.chunk) {
    const prefix = c.sectionPath.join(" > ");
    push(c.id, "chunk", "original", prefix + "\n" + c.text);
    const expanded = values.expand[c.id];
    if (expanded) {
      push(c.id, "chunk", "background", prefix + "\n" + expanded.background);
      expanded.questions.forEach((q, n) =>
        push(c.id, "chunk", "question_" + n, prefix + "\n" + q.text),
      );
    }
  }
  for (const e of values.normalize.elements.filter(
    (e) => e.quality === "ready",
  ))
    push(
      e.id,
      e.kind,
      "element",
      [
        e.caption,
        e.shortDescription,
        e.description,
        e.kind === "formula" ? e.latex : "",
      ]
        .filter(Boolean)
        .join("\n") ||
        e.text ||
        e.kind,
    );
  return rows;
}
async function parseSource(r, j, signal) {
  const contentFile =
    r.objectPath && fs.existsSync(r.objectPath) ? r.objectPath : r.location;
  if (!fs.existsSync(contentFile)) throw fault("源文件缺失", 404);
  if (/\.pdf$/i.test(r.location)) {
    const paper = getPaper(r.paperId);
    if (!paper) throw fault("文献不存在", 404);
    const old = readBlocks(paper.id);
    if (old && j.input.parseVersion) return old;
    const run = createRun(paper.id, "hybrid");
    const immutable = asset(fs.readFileSync(contentFile), {
      kind: "original-snapshot",
    });
    link(r.id, immutable.id, "uses");
    const doc = await executePipeline(
      { ...paper, pdfPath: immutable.path },
      "hybrid",
      run,
      (message) => {
        guard(j, signal);
        saveJob({ ...job(j.id), detail: message });
      },
    );
    for (const error of doc.quality?.errors || [])
      if (error.blockId) {
        const b = doc.blocks.find((b) => b.id === error.blockId);
        if (b) b.issues = [...(b.issues || []), error.code];
      }
    guard(j, signal);
    saveResult(run, doc);
    // Adopt the first structural parse without emitting an update to this running job.
    if (!doc.quality?.errors?.length && !listVersions(paper.id).active)
      writeFile(
        path.join(parsedDir(paper.id), "current.json"),
        JSON.stringify({ versionId: run.id }),
        { kind: "parse-pointer" },
      );
    return doc;
  }
  let content = fs.readFileSync(contentFile, "utf8");
  if (/\.json$/i.test(r.location)) {
    const value = JSON.parse(content);
    content = value.markdown || value.report || value.md;
    if (typeof content !== "string")
      throw fault("报告未包含可解析的 Markdown", 422);
  }
  const blocks = mdToBlocks(content).map((b, n) => ({ ...b, id: "md_" + n }));
  return { blocks, meta: { title: r.title }, pages: [] };
}
async function sourceImage(r, b) {
  if (b.assetId) return loadAsset(b.assetId);
  if (b.b64) return { data: b.b64, mimeType: b.mimeType || "image/png" };
  const src = b.src || b.sourceImage;
  if (src && /^data:image\/(png|jpeg|webp|gif);base64,/.test(src))
    return {
      data: src.split(",")[1],
      mimeType: src.slice(5, src.indexOf(";")),
    };
  if (src && !/^[a-z]+:/i.test(src)) {
    const base = r.paperId ? parsedDir(r.paperId) : path.dirname(r.location),
      file = path.resolve(base, src.replace(/^file\//, ""));
    const relative = path.relative(base, file);
    const content = fs.existsSync(file) ? file : resourceAt(file)?.objectPath;
    if (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      content &&
      fs.existsSync(content)
    )
      return {
        data: fs.readFileSync(content).toString("base64"),
        mimeType: mime(file),
      };
  }
  if (r.paperId && b.page && b.bbox) {
    const crop = await renderPageCrop(r.location, b.page, b.bbox);
    if (crop)
      return { data: crop.buffer.toString("base64"), mimeType: "image/png" };
  }
  return null;
}
export function loadAsset(id) {
  const r = resource(id);
  if (!r || r.lifecycle !== "active" || !fs.existsSync(r.location)) return null;
  return {
    data: fs.readFileSync(r.location).toString("base64"),
    mimeType: r.mimeType || mime(r.location),
  };
}
async function repairSource(r, doc, j, signal, mark) {
  const repairs = {};
  const blocks = doc.blocks;
  for (const page of doc.pages || [])
    if (!blocks.some((b) => b.page === page.page && textOf(b).trim())) {
      const block = {
        id: "scan_" + page.page,
        type: "para",
        page: page.page,
        bbox: [0, 0, page.width, page.height],
        issues: ["scanned-page"],
        md: "",
      };
      const next = blocks.findIndex((b) => b.page > page.page);
      if (next < 0) blocks.push(block);
      else blocks.splice(next, 0, block);
    }
  for (const [i, b] of blocks.entries()) {
    guard(j, signal);
    const human = readState(
      "human-repair:" + r.id + ":" + j.input.versionId + ":" + b.id,
      null,
    );
    if (human) {
      repairs[b.id] = human;
      continue;
    }
    if (b.type === "table" && !b.html && b.md?.trim().startsWith("|"))
      b.html = marked.parse(b.md);
    const needs =
      b.type === "image" ||
      b.issues?.length ||
      (["table", "formula", "code"].includes(b.type) &&
        (!textOf(b).trim() || (b.type === "table" && !b.html)));
    const image = await sourceImage(r, b);
    if (image) {
      const blob = asset(Buffer.from(image.data, "base64"), {
        mimeType: image.mimeType,
      });
      b.assetId = blob.id;
      link(j.resourceId, blob.id, "uses");
    }
    if (!needs) continue;
    if (!image) {
      b.issues = [...(b.issues || []), "missing-visual-evidence"];
      continue;
    }
    const key =
        "repair:" +
        digest(["repair-v2", getConfig().rag.vision, b, textOf(b), image.data]),
      cached = readState(key, null);
    if (cached) {
      repairs[b.id] = cached;
      continue;
    }
    mark({ detail: `视觉清洗 ${i + 1}/${blocks.length}` });
    let result;
    try {
      result = await modelJson({
        signal,
        images: [image],
        system:
          "核验论文区域，恢复截图正文并描述科学图像。表格保留合并单元格、表头、单位、表注；公式输出 LaTeX、编号和可确认的符号含义。图像说明讲什么、包含什么及上下文关系。禁止猜测不清晰数值。输出 JSON 的顶层字段为 kind、text、html、latex、shortDescription、description、uncertain；kind 从 text、image、table、formula、code、note 中选择一个，填写适用于该类型的内容。直接返回识别结果，不复述输入，不嵌套在 format 字段中。",
        text: JSON.stringify({
          block: b,
          context: blocks.slice(Math.max(0, i - 2), i + 3).map(textOf),
          format: {
            kind: "text|image|table|formula|code|note",
            text: "正文/代码",
            html: "表格 HTML",
            latex: "公式 LaTeX",
            shortDescription: "简述",
            description: "详细说明",
            uncertain: false,
          },
        }),
      });
    } catch (e) {
      if (!e.modelDiagnostics) throw e;
      guard(j, signal);
      b.issues = [...(b.issues || []), "invalid-model-output"];
      repairs[b.id] = {
        kind: b.type === "image" ? "image" : "text",
        uncertain: true,
        assetId: b.assetId,
        diagnostics: e.modelDiagnostics,
      };
      continue;
    }
    guard(j, signal);
    const candidate = {
      ...result.value,
      assetId: b.assetId,
      model: result.model,
      source: { page: b.page, bbox: b.bbox, blockId: b.id },
      checks: validateCandidate(b, result.value),
    };
    repairs[b.id] = candidate;
    writeState(key, candidate);
  }
  return repairs;
}
events.on("lifecycle", ({ affected, id, type }) => {
  if (type === "trash")
    for (const j of jobs().filter((j) =>
      [...(affected || []), id].includes(j.resourceId),
    ))
      runners.get(j.id)?.abort();
});
const rebuildTimers = new Map();
events.on("invalidate", ({ id }) => {
  for (const j of jobs(id).filter(
    (j) => j.type === "ingestion" && !terminal.has(j.status),
  ))
    controlJob(j.id, "cancel");
  const r = resource(id);
  if (!r?.indexEnabled || r.lifecycle !== "active") return;
  clearTimeout(rebuildTimers.get(id));
  const timer = setTimeout(() => {
    rebuildTimers.delete(id);
    try {
      startIngestion(id);
    } catch {}
  }, 500);
  timer.unref();
  rebuildTimers.set(id, timer);
});
export function resumeIngestion() {
  for (const j of jobs().filter(
    (j) => j.type === "ingestion" && j.status === "interrupted",
  )) {
    try {
      controlJob(j.id, "resume");
    } catch {}
  }
}
