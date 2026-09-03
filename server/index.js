import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROOT, PUBLIC_DIR, PARSED_DIR, getConfig, saveConfig, redactedConfig } from "./config.js";
import { listPapers, getPaper, importPdfFile, mergeZoteroSnapshot, getPapers, getParseState, readBlocks, allSessionMeta } from "./store.js";
import { syncZotero } from "./zotero.js";
import { startParse, getJob, paperWithParseStatus } from "./parser/index.js";
import * as harness from "./harness.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  // raw body for uploads (PUT /api/papers/import)
  if (req.method === "PUT" && req.path.startsWith("/api/papers/import")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    return;
  }
  next();
});

const api = express.Router();

api.get("/health", (_req, res) => res.json({ ok: true, name: "PiPaper", time: new Date().toISOString() }));

// ---- config ----
api.get("/config", (_req, res) => res.json({ config: redactedConfig(), zotero: zoteroStatus() }));
api.put("/config", (req, res) => {
  try {
    const patch = req.body || {};
    // ignore masked secrets coming back
    const cur = getConfig();
    if (patch.parse?.mineru?.token?.includes("***")) patch.parse.mineru.token = cur.parse.mineru.token;
    if (patch.parse?.unstructured?.apiKey?.includes("***")) patch.parse.unstructured.apiKey = cur.parse.unstructured.apiKey;
    saveConfig(patch);
    res.json({ ok: true, config: redactedConfig(), zotero: zoteroStatus() });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

function zoteroStatus() {
  const papers = getPapers();
  return { syncedAt: papers.zoteroSyncedAt || null, dataDir: papers.zoteroDataDir || null, papers: papers.papers.filter((p) => p.source === "zotero").length };
}

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
  });
});

api.put("/papers/import", (req, res) => {
  try {
    const name = decodeURIComponent(req.headers["x-filename"] || "paper.pdf");
    if (!/\.pdf$/i.test(name)) return res.status(400).json({ error: "仅支持 PDF" });
    if (!req.rawBody?.length) return res.status(400).json({ error: "空文件" });
    const paper = importPdfFile(name, req.rawBody);
    res.json(paperWithParseStatus(paper));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.get("/papers/:id/pdf", (req, res) => {
  const p = getPaper(req.params.id);
  if (!p?.pdfPath || !fs.existsSync(p.pdfPath)) return res.status(404).json({ error: "PDF 不存在" });
  res.sendFile(p.pdfPath);
});

api.get("/papers/:id/blocks", (req, res) => {
  const p = getPaper(req.params.id);
  if (!p) return res.status(404).json({ error: "论文不存在" });
  const blocks = readBlocks(p.id);
  const state = getParseState(p.id);
  res.json({
    paper: paperWithParseStatus(p),
    status: state?.status || (blocks ? "done" : "none"),
    engine: state?.engine || null,
    error: state?.error || null,
    blocks: blocks || null,
  });
});

api.post("/papers/:id/parse", (req, res) => {
  try {
    const job = startParse(req.params.id, req.body?.engine || "auto");
    res.json({ jobId: job.id, engine: job.engine });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

api.get("/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: "任务不存在" });
  res.json(j);
});

api.get("/papers/:id/file/*", (req, res) => {
  const rel = req.params[0] || "";
  const target = path.resolve(PARSED_DIR, req.params.id, rel);
  if (!target.startsWith(path.resolve(PARSED_DIR, req.params.id))) return res.status(403).end();
  if (!fs.existsSync(target)) return res.status(404).end();
  res.sendFile(target);
});

// ---- sessions (pi harness) ----
api.get("/models", async (_req, res) => {
  try {
    res.json(await harness.modelList());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.get("/sessions", async (_req, res) => {
  try {
    res.json({ sessions: await harness.listSessions() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.post("/sessions", async (req, res) => {
  try {
    const r = await harness.createChat({ paperId: req.body?.paperId || null, title: req.body?.title || null });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.get("/sessions/:id", async (req, res) => {
  try {
    res.json(await harness.sessionHistory(req.params.id));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.delete("/sessions/:id", async (req, res) => {
  try {
    await harness.deleteChat(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.post("/sessions/:id/model", async (req, res) => {
  try {
    res.json(await harness.setChatModel(req.params.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

api.post("/sessions/:id/abort", async (req, res) => {
  try {
    await harness.abortChat(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

api.post("/sessions/:id/prompt", async (req, res) => {
  const { text, images, paperId } = req.body || {};
  if (!text && !(images || []).length) return res.status(400).json({ error: "空消息" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (s) => res.write(s);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  try {
    await harness.promptChat(req.params.id, { text, images, paperId }, send);
  } catch (e) {
    send(`data: ${JSON.stringify({ t: "error", message: String(e.message || e) })}\n\n`);
  } finally {
    clearInterval(ping);
    res.end();
  }
});

app.use("/api", api);
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

const port = Number(process.env.PORT || getConfig().port || 4318);
app.listen(port, "127.0.0.1", () => {
  console.log(`\n  PiPaper 论文精读工作台  →  http://127.0.0.1:${port}\n`);
});
