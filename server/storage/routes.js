import fs from "node:fs";
import path from "node:path";
import express from "express";
import {
  resources,
  resource,
  history,
  dependencies,
  putResource,
  jobs,
  record,
  records,
  generation,
  generations,
  saveGeneration,
  readState,
  writeState,
  stateRevision,
  operation,
  operations,
  invalidate,
  events,
  fault,
  digest,
} from "./catalog.js";
import { trash, restore, purge, writeFile, collectObjects } from "./files.js";
import { migrationReport, roots } from "./migration.js";
import {
  listPapers,
  upsertPaper,
  setSessionMeta,
  restoreProject,
  makeLocalId,
} from "../store.js";
import { startIngestion, controlJob, loadAsset } from "../rag/ingestion.js";
import { searchKnowledge, getKnowledgeElement } from "../rag/search.js";
import { validateCandidate } from "../rag/document.js";
import { vectorIndex, removeResourceIndexes } from "../rag/milvus.js";
import { embeddingKey } from "../rag/providers.js";
import { getConfig, saveConfig } from "../config.js";
import { retryOperation } from "./maintenance.js";

const route = (handler) => async (req, res) => {
  try {
    const value = await handler(req, res);
    if (!res.headersSent) res.json(value);
  } catch (e) {
    if (!res.headersSent)
      res.status(e.status || 500).json({ error: e.message });
  }
};
export function registerStorageRoutes(api) {
  api.get(
    "/storage/resources",
    route((req) => ({ resources: resources(req.query), roots: roots() })),
  );
  api.get(
    "/storage/migration",
    route(() => migrationReport(listPapers({ includeTemporary: true }))),
  );
  api.get(
    "/storage/operations",
    route(() => ({
      operations: operations().filter((o) => o.status !== "succeeded"),
    })),
  );
  api.post(
    "/storage/operations/:id/retry",
    route((req) => retryOperation(req.params.id)),
  );
  api.get(
    "/storage/resources/:id",
    route((req) => {
      const r = resource(req.params.id);
      if (!r) throw fault("资源不存在", 404);
      return {
        resource: r,
        versions: history(r.id),
        dependencies: dependencies(r.id),
        jobs: jobs(r.id),
        generations: generations(r.id),
      };
    }),
  );
  api.get(
    "/storage/resources/:id/content",
    route((req, res) => {
      const r = resource(req.params.id);
      if (!r || r.lifecycle !== "active") throw fault("资源不可用", 404);
      const version =
        req.query.revision && Number(req.query.revision) !== r.revision
          ? history(r.id).find((v) => v.revision === Number(req.query.revision))
          : r;
      const file = version?.objectPath || version?.location;
      if (!file || !fs.existsSync(file)) throw fault("版本内容缺失", 404);
      if (
        version !== r &&
        !version.objectPath &&
        version.hash &&
        digest(fs.readFileSync(file)) !== version.hash
      )
        throw fault("历史版本内容缺失，不能返回当前版本代替", 404);
      res.sendFile(path.resolve(file));
    }),
  );
  api.put(
    "/storage/resources/:id",
    route((req) => {
      const r = resource(req.params.id);
      if (!r) throw fault("资源不存在", 404);
      if (req.body.revision == null) throw fault("更新需要修订号", 428);
      if (r.owned === false)
        throw fault("外部引用不能改写，请创建受管快照", 409);
      if (typeof req.body.content !== "string" || !r.location || r.directory)
        throw fault("仅支持文本内容更新", 422);
      return writeFile(r.location, req.body.content, {
        ...r,
        expectedRevision: req.body.revision,
        versionId: undefined,
      });
    }),
  );
  api.post(
    "/storage/resources/:id/repair",
    route((req) => {
      const r = resource(req.params.id);
      if (
        !r ||
        r.lifecycle !== "active" ||
        r.owned === false ||
        r.directory ||
        !r.objectPath ||
        !r.location ||
        !fs.existsSync(r.objectPath)
      )
        throw fault("没有可恢复的受管内容版本", 422);
      if (fs.existsSync(r.location))
        throw fault("文件仍存在，请通过版本更新处理", 409);
      if (req.body.revision !== r.revision)
        throw fault("资源修订变化，请刷新后重试", 409);
      const content = fs.readFileSync(r.objectPath);
      if (digest(content) !== r.hash) throw fault("备份内容哈希不一致", 422);
      return writeFile(r.location, content, {
        ...r,
        availability: "ready",
        expectedRevision: r.revision,
      });
    }),
  );
  api.put(
    "/storage/resources/:id/file",
    express.raw({ type: "application/pdf", limit: "100mb" }),
    route((req) => {
      const r = resource(req.params.id);
      if (!r || r.lifecycle !== "active" || r.kind !== "original")
        throw fault("原始资源不可用", 404);
      const revision = Number(req.headers["x-resource-revision"]);
      if (!revision) throw fault("更新需要 X-Resource-Revision", 428);
      if (r.owned === false)
        throw fault("外部原库仅能登记引用，请通过导入创建受管快照", 409);
      if (
        !Buffer.isBuffer(req.body) ||
        !req.body.subarray(0, 1024).includes(Buffer.from("%PDF-"))
      )
        throw fault("请选择有效 PDF", 422);
      const next = writeFile(r.location, req.body, {
        ...r,
        expectedRevision: revision,
      });
      const metadata = { ...r.metadata, contentHash: next.hash };
      upsertPaper(metadata);
      return resource(r.id);
    }),
  );
  api.delete(
    "/storage/resources/:id",
    route(async (req) => {
      await (
        await import("../native-harness.js")
      ).prepareResourceDeletion(req.params.id);
      return trash(req.params.id);
    }),
  );
  api.post(
    "/storage/resources/:id/adopt",
    route((req) => {
      const r = resource(req.params.id);
      if (
        !r ||
        r.lifecycle !== "active" ||
        r.kind !== "original" ||
        !r.location ||
        r.paperId ||
        !fs.existsSync(r.location) ||
        !/\.pdf$/i.test(r.location)
      )
        throw fault("请选择未登记的原始 PDF", 422);
      const id = makeLocalId(r.location);
      upsertPaper({
        id,
        title: r.title || path.basename(r.location, ".pdf"),
        pdfPath: r.location,
        contentHash: r.hash,
        source: "library",
        added: new Date().toISOString(),
      });
      putResource({
        ...r,
        kind: "original-alias",
        paperId: id,
        orphan: false,
        availability: "ready",
        adoptedResource: "paper:" + id,
      });
      return resource("paper:" + id);
    }),
  );
  api.post(
    "/storage/resources/:id/restore",
    route(async (req) => {
      const r = restore(req.params.id);
      if (r.paperId && r.metadata) upsertPaper(r.metadata);
      if (r.kind === "session" && r.metadata)
        setSessionMeta(r.id.replace(/^session:/, ""), r.metadata);
      if (r.kind === "project" && r.metadata) restoreProject(r.metadata);
      if (r.indexEnabled) {
        const g = generations(r.id).find((g) => g.id === r.publishedGeneration);
        let valid = false;
        if (g)
          try {
            valid = await vectorIndex(g.config).contains(g);
          } catch {}
        if (!valid) {
          putResource({ ...resource(r.id), indexStale: true });
          startIngestion(r.id, { rebuildIndex: true });
        }
      }
      return r;
    }),
  );
  api.post(
    "/storage/resources/:id/purge",
    route(async (req) => {
      const result = await purge(req.params.id, async (r) => {
        for (const child of resources().filter(
          (x) => x.id === r.id || x.trashGroup === r.id,
        ))
          await removeResourceIndexes(child.id);
      });
      collectObjects();
      return result;
    }),
  );
  api.post(
    "/storage/resources/:id/rebuild",
    route((req) =>
      startIngestion(req.params.id, { force: Boolean(req.body.force) }),
    ),
  );
  api.get(
    "/ingestion/jobs",
    route((req) => ({
      jobs: jobs(req.query.resourceId).filter((j) => j.type === "ingestion"),
    })),
  );
  api.post(
    "/ingestion/jobs",
    route((req) =>
      startIngestion(req.body.resourceId, { force: Boolean(req.body.force) }),
    ),
  );
  api.post(
    "/ingestion/jobs/:id/:action",
    route((req) => controlJob(req.params.id, req.params.action)),
  );
  api.post(
    "/rag/search",
    route((req) => searchKnowledge(req.body.query, req.body)),
  );
  api.get(
    "/rag/elements/:id",
    route((req) =>
      getKnowledgeElement(req.params.id, {
        generationId: req.query.generationId,
      }),
    ),
  );
  api.get(
    "/rag/reviews",
    route((req) => {
      const seen = new Set();
      return {
        reviews: generations()
          .filter(
            (g) =>
              !req.query.resourceId || g.resourceId === req.query.resourceId,
          )
          .filter((g) => {
            const r = resource(g.resourceId);
            if (
              r?.lifecycle !== "active" ||
              g.versionId !== (r.versionId || r.hash) ||
              seen.has(r.id)
            )
              return false;
            seen.add(r.id);
            return true;
          })
          .flatMap((g) =>
            records(g.id, "review")
              .filter((r) => r.decision === "pending")
              .map((r) => ({
                ...r,
                generationId: g.id,
                resourceId: g.resourceId,
              })),
          ),
      };
    }),
  );
  api.get(
    "/rag/reviews/:id/evidence",
    route((req) => {
      const row = record(req.params.id);
      if (
        !row ||
        row.kind !== "review" ||
        resource(row.resourceId)?.lifecycle !== "active"
      )
        throw fault("核对项不可用", 404);
      const g = generations(row.resourceId).find((g) =>
        records(g.id).some((x) => x.id === row.id),
      );
      const target =
        records(g.id).find((x) => x.id === row.targetId) ||
        records(g.id).find(
          (x) => x.blockId === row.blockId && x.kind !== "review",
        );
      return {
        review: row,
        target,
        image:
          target?.assetId || row.assetId
            ? loadAsset(target?.assetId || row.assetId)
            : null,
      };
    }),
  );
  api.put(
    "/rag/reviews/:id",
    route((req) => {
      const review = record(req.params.id);
      if (!review || review.kind !== "review") throw fault("核对项不存在", 404);
      const r = resource(review.resourceId);
      if (!r || r.lifecycle !== "active") throw fault("资源不可用", 404);
      if (review.versionId !== (r.versionId || r.hash))
        throw fault("来源版本已经更新，请使用当前核对项", 409);
      if (req.body.revision !== r.revision)
        throw fault("资源已变化，请刷新核对列表", 409);
      const candidate = req.body.candidate || review.candidate;
      if (
        req.body.decision !== "discard" &&
        validateCandidate({}, candidate).filter((x) => x !== "model-uncertain")
          .length
      )
        throw fault("修订结果未通过结构检查", 422);
      writeState(
        "human-repair:" + r.id + ":" + review.versionId + ":" + review.blockId,
        {
          ...candidate,
          uncertain: false,
          humanVerified: true,
          discard: req.body.decision === "discard",
          verifiedAt: new Date().toISOString(),
        },
      );
      const g = generations(r.id).find((g) =>
        records(g.id).some((x) => x.id === review.id),
      );
      const all = records(g.id);
      saveGeneration(
        g,
        all.map((v) =>
          v.id === review.id
            ? { ...v, decision: req.body.decision || "adopted" }
            : v,
        ),
      );
      putResource({ ...r, reviewRevision: (r.reviewRevision || 0) + 1 });
      invalidate(r.id, "人工核对修订");
      return { ok: true };
    }),
  );
  api.get(
    "/rag/config",
    route(() => ({
      config: getConfig().rag,
      embeddingConfigured: Boolean(embeddingKey()),
    })),
  );
  api.put(
    "/rag/config",
    route((req) => {
      if (JSON.stringify(req.body).match(/apiKey|token|secret/i))
        throw fault("密钥请设置在服务端环境变量或本地 credentials 目录", 422);
      const previous = getConfig().rag;
      saveConfig({ rag: req.body });
      if (JSON.stringify(previous) !== JSON.stringify(getConfig().rag))
        for (const r of resources().filter(
          (r) => r.indexEnabled && r.lifecycle === "active",
        ))
          invalidate(r.id, "流水线配置变化");
      return {
        config: getConfig().rag,
        embeddingConfigured: Boolean(embeddingKey()),
      };
    }),
  );
  api.get(
    "/storage/state/:namespace",
    route((req) => {
      const key = stateKey(req.params.namespace);
      return { value: readState(key, {}), revision: stateRevision(key) };
    }),
  );
  api.put(
    "/storage/state/:namespace",
    route((req) => {
      const key = stateKey(req.params.namespace);
      return writeState(key, req.body.value, req.body.revision);
    }),
  );
  api.get("/storage/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const listener = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    events.on("change", listener);
    const timer = setInterval(() => res.write(": heartbeat\n\n"), 20000);
    req.on("close", () => {
      clearInterval(timer);
      events.off("change", listener);
    });
  });
}
function stateKey(namespace) {
  if (!/^[\w.-]{1,80}$/.test(namespace)) throw fault("状态命名空间无效");
  return "ui:" + namespace;
}
