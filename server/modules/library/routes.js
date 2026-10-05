import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../../config.js";
import { listPapers, getPaper, importPdfFile, mergeZoteroSnapshot, getPapers, getParseState, readBlocks, allSessionMeta, listProjects, createProject, updateProject, deleteProject, parsedDir } from "../../store.js";
import { syncZotero } from "../../zotero.js";
import { startParse, getJob, paperWithParseStatus, isParsing } from "../../parser/index.js";
import { listVersions, readVersion, activateVersion } from "../../parser/versions.js";
import { sourceBounds } from "../../parser/regions.js";
import { renderPageCrop } from "../../parser/render.js";
import * as harness from "../../harness.js";
import { safeJoin } from "../../platform/files/paths.js";
import { zoteroStatus } from "./metadata.js";

export function registerLibraryRoutes(api) {
  // ---- zotero / papers ----
  api.get("/papers", async (req, res) => {
    if (req.query.refresh === "1") {
      try {
        const snap = syncZotero(getConfig().zotero);
        mergeZoteroSnapshot(snap);
      } catch (e) {
        res.status(500).json({ error: String(e.message || e), papers: listPapers().map(paperWithParseStatus), collections: getPapers().collections });
        return;
      }
    }
    const collections = getPapers().collections || [];
    res.json({
      papers: listPapers().map(paperWithParseStatus),
      collections,
      zotero: zoteroStatus(),
      projects: listProjects(),
    });
  });

  api.put("/papers/import", (req, res) => {
    try {
      const name = decodeURIComponent(req.headers["x-filename"] || "paper.pdf");
      if (!/\.pdf$/i.test(name)) return res.status(400).json({ error: "仅支持 PDF" });
      if (!req.rawBody?.length) return res.status(400).json({ error: "空文件" });
      const { paper, reused } = importPdfFile(name, req.rawBody);
      // project-scoped import: file lands in the currently selected project
      const projectId = req.headers["x-project-id"];
      if (projectId) {
        const proj = updateProject(projectId, { addPaper: paper.id });
        if (!proj) return res.status(400).json({ error: "项目不存在" });
      }
      res.json({ ...paperWithParseStatus(paper), reused, projectId: projectId || null });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  api.get("/papers/:id/pdf", (req, res) => {
    const p = getPaper(req.params.id);
    if (!p?.pdfPath || !fs.existsSync(p.pdfPath)) return res.status(404).json({ error: "PDF 不存在" });
    res.sendFile(p.pdfPath);
  });

  api.get("/papers/:id/blocks", async (req, res) => {
    const p = getPaper(req.params.id);
    if (!p) return res.status(404).json({ error: "论文不存在" });
    const parsed = readBlocks(p.id);
    const state = getParseState(p.id);
    const rawBlocks = Array.isArray(parsed) ? parsed : parsed?.blocks || null;
    res.json({
      paper: paperWithParseStatus(p),
      status: state?.status === "running" ? "running" : parsed ? "done" : state?.status || "none",
      engine: parsed?.meta?.engine || state?.engine || null,
      error: state?.error || null,
      v: parsed?.v || 1,
      meta: parsed?.meta || null,
      blocks: rawBlocks,
      pages: parsed?.pages || null,
      sections: parsed?.sections || null,
      quality: parsed?.quality || null,
    });
  });

  api.post("/papers/:id/parse", (req, res) => {
    try {
      const job = startParse(req.params.id, req.body?.engine || "hybrid", req.body?.sourceVersion);
      res.json({ jobId: job.id, engine: job.engine });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  api.get("/papers/:id/versions", (req, res) => {
    if (!getPaper(req.params.id)) return res.status(404).json({ error: "论文不存在" });
    res.json(listVersions(req.params.id));
  });
  api.get("/papers/:id/versions/:version", (req, res) => {
    if (!getPaper(req.params.id)) return res.status(404).json({ error: "论文不存在" });
    try { res.json(readVersion(req.params.id, req.params.version)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  api.post("/papers/:id/versions/:version/activate", (req, res) => {
    if (!getPaper(req.params.id)) return res.status(404).json({ error: "论文不存在" });
    if (isParsing(req.params.id)) return res.status(409).json({ error: "解析期间暂不能切换版本" });
    try { res.json(activateVersion(req.params.id, req.params.version)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  api.get("/papers/:id/regions/:block", async (req, res) => {
    const paper = getPaper(req.params.id);
    if (!paper) return res.status(404).end();
    try {
      const doc = req.query.version ? readVersion(paper.id, String(req.query.version)) : readBlocks(paper.id);
      const block = doc?.blocks?.find((b) => b.id === req.params.block);
      if (!block?.bbox || !block.page || doc.v !== 4) return res.status(404).end();
      const bounds = sourceBounds(block, doc.blocks);
      const crop = await renderPageCrop(paper.pdfPath, block.page, bounds);
      if (!crop) return res.status(404).end();
      res.type("png").send(crop.buffer);
    } catch { res.status(500).end(); }
  });

  api.get("/jobs/:id", (req, res) => {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ error: "任务不存在" });
    res.json(j);
  });

  api.get("/papers/:id/file/*", (req, res) => {
    if (!getPaper(req.params.id)) return res.status(404).json({ error: "文献不可用" });
    const rel = req.params[0] || "";
    const base = parsedDir(req.params.id);
    const target = path.resolve(base, rel);
    if (!safeJoin(base, rel)) return res.status(403).end();
    if (!fs.existsSync(target)) return res.status(404).end();
    res.sendFile(target);
  });


  api.get("/projects", (_req, res) => {
    const sessions = allSessionMeta();
    res.json({
      projects: listProjects().map((p) => ({
        ...p,
        sessionCount: Object.values(sessions).filter((s) => s.projectId === p.id).length,
      })),
    });
  });

  api.post("/projects", (req, res) => {
    const name = String(req.body?.name || "").trim();
    const type = req.body?.type === "zotero" ? "zotero" : "temp";
    if (!name) return res.status(400).json({ error: "项目名不能为空" });
    res.json(createProject(name, type));
  });

  api.put("/projects/:id", (req, res) => {
    const p = updateProject(req.params.id, req.body || {});
    if (!p) return res.status(404).json({ error: "项目不存在" });
    if (req.body?.resources) harness.refreshProjectResources(p.id);
    res.json(p);
  });

  api.delete("/projects/:id", (req, res) => {
    deleteProject(req.params.id);
    res.json({ ok: true });
  });


}
