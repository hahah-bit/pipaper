import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_ROOT, PUBLIC_DIR, DATA_DIR, getConfig, saveConfig, redactedConfig } from "./config.js";
import { listPapers, getPaper, importPdfFile, mergeZoteroSnapshot, getPapers, getParseState, readBlocks, allSessionMeta, listProjects, createProject, updateProject, deleteProject, parsedDir, attachHash, flushHashCache, fileHash, findByHash } from "./store.js";
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

api.get("/papers/:id/blocks", (req, res) => {
  const p = getPaper(req.params.id);
  if (!p) return res.status(404).json({ error: "论文不存在" });
  const parsed = readBlocks(p.id); // v1: array | v2: {v:2, meta, blocks}
  const state = getParseState(p.id);
  res.json({
    paper: paperWithParseStatus(p),
    status: state?.status || (parsed ? "done" : "none"),
    engine: state?.engine || null,
    error: state?.error || null,
    v: parsed?.v || 1,
    meta: parsed?.meta || null,
    blocks: parsed?.v === 2 ? parsed.blocks : parsed || null,
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
  const base = parsedDir(req.params.id);
  const target = path.resolve(base, rel);
  if (!target.startsWith(path.resolve(base))) return res.status(403).end();
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
    const r = await harness.createChat({ paperId: req.body?.paperId || null, projectId: req.body?.projectId || null, title: req.body?.title || null });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.post("/sessions/:id/compact", async (req, res) => {
  try {
    res.json(await harness.compactSession(req.params.id, req.body?.instructions));
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
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
  const { text, images, paperId, projectId } = req.body || {};
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
    await harness.promptChat(req.params.id, { text, images, paperId, projectId }, send);
  } catch (e) {
    send(`data: ${JSON.stringify({ t: "error", message: String(e.message || e) })}\n\n`);
  } finally {
    clearInterval(ping);
    res.end();
  }
});

// ---- pi surface: commands (prompts/skills), files (@), projects ----

api.get("/pi/commands", async (_req, res) => {
  try {
    res.json(await harness.listCommands());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  return target.startsWith(path.resolve(base)) ? target : null;
}

api.get("/files", (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const out = [];
  // virtual: parsed papers
  for (const p of listPapers()) {
    const parsed = readBlocks(p.id);
    const blocks = parsed?.v === 2 ? parsed.blocks : parsed;
    if (blocks) out.push({ label: `《${p.title}》· 解析全文`, path: `paper:${p.id}/full.md`, kind: "text" });
    for (const b of blocks || []) {
      if (b.type === "image" && b.src) {
        out.push({ label: `《${p.title}》· ${b.caption || "插图"}`, path: `paper:${p.id}/asset/${String(b.src).replace(/^file\/assets\//, "")}`, kind: "image" });
      }
    }
  }
  // workspace + library files (depth-limited)
  const scan = (dir, rel, depth) => {
    if (depth > 3 || out.length > 400) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > 400) break;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (["node_modules", "data", "public", ".git", "library", ".pi"].includes(e.name)) continue;
        scan(path.join(dir, e.name), r, depth + 1);
      } else if (/\.(md|txt|tex|bib|json|csv|tsv|mjs|js|ts|py)$/i.test(e.name)) {
        out.push({ label: r, path: r, kind: "text" });
      }
    }
  };
  scan(APP_ROOT, "", 0);
  // library PDFs (attach as file reference for the agent to read via tools)
  try {
    for (const f of fs.readdirSync(LIBRARY_DIR)) {
      if (/\.pdf$/i.test(f)) out.push({ label: "library/" + f, path: "library/" + f, kind: "pdf" });
    }
  } catch {}
  const filtered = q ? out.filter((f) => f.label.toLowerCase().includes(q)) : out.slice(0, 80);
  res.json({ files: filtered.slice(0, 60) });
});

api.get("/file", async (req, res) => {
  const p = String(req.query.path || "");
  try {
    if (p.startsWith("paper:")) {
      const m = p.slice(6).match(/^([^/]+)\/(.+)$/);
      if (!m) return res.status(400).json({ error: "bad path" });
      const paper = getPaper(m[1]);
      if (!paper) return res.status(404).json({ error: "论文不存在" });
      if (m[2] === "full.md") {
        const { readParsedText } = await import("./store.js");
        const text = readParsedText(paper.id);
        if (!text) return res.status(404).json({ error: "未解析" });
        return res.json({ kind: "text", label: `《${paper.title}》解析全文`, content: text.slice(0, 80000) });
      }
      if (m[2].startsWith("asset/")) {
        const name = path.basename(m[2]);
        const file = safeJoin(parsedDir(paper.id), path.join("assets", name));
        if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "资源不存在" });
        const ext = path.extname(file).toLowerCase();
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext];
        if (!mime) return res.status(400).json({ error: "非图片资源" });
        const b64 = fs.readFileSync(file).toString("base64");
        if (b64.length > 6_000_000) return res.status(400).json({ error: "图片过大" });
        return res.json({ kind: "image", label: name, dataUrl: `data:${mime};base64,${b64}`, mimeType: mime });
      }
      return res.status(400).json({ error: "bad path" });
    }
    const file = safeJoin(APP_ROOT, p);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).json({ error: "文件不存在" });
    const ext = path.extname(file).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext];
    if (mime) {
      const b64 = fs.readFileSync(file).toString("base64");
      return res.json({ kind: "image", label: p, dataUrl: `data:${mime};base64,${b64}`, mimeType: mime });
    }
    if (ext === ".pdf") {
      return res.json({ kind: "pdf", label: p, content: `（PDF 文件：${p}。该文件已在文献库中，可用 read_paper 工具读取其解析内容。）` });
    }
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return res.status(400).json({ error: "二进制文件不能作为上下文" });
    res.json({ kind: "text", label: p, content: buf.toString("utf8").slice(0, 80000) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
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
  if (!name) return res.status(400).json({ error: "项目名不能为空" });
  res.json(createProject(name));
});

api.put("/projects/:id", (req, res) => {
  const p = updateProject(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: "项目不存在" });
  res.json(p);
});

api.delete("/projects/:id", (req, res) => {
  deleteProject(req.params.id);
  res.json({ ok: true });
});

// ---- pi surface: commands (prompts/skills), files (@), projects ----

// startup migration: attach content hashes and move legacy parse dirs to
// hash-keyed locations so parse state is shared across duplicate imports
function migrateLibrary() {
  const moved = [];
  for (const p of listPapers()) {
    if (!p.pdfPath || !fs.existsSync(p.pdfPath)) continue;
    const before = p.contentHash;
    attachHash(p);
    if (!before && p.contentHash) {
      const oldDir = path.join(DATA_DIR, "parsed", p.id);
      const newDir = path.join(DATA_DIR, "parsed", "h_" + p.contentHash.slice(0, 24));
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        try {
          fs.renameSync(oldDir, newDir);
          moved.push(p.id);
        } catch {}
      }
    }
  }
  if (moved.length) console.log(`[migrate] parse cache re-keyed for ${moved.length} papers`);
}

// ---- resource manager: skills / extensions / packages / MCP ----
api.get("/pi/resources", async (_req, res) => {
  try {
    const out = { skills: [], extensions: [], packages: [], mcp: [] };
    try {
      const sk = await import("./harness.js").then((h) => h.listCommands());
      out.skills = sk.skills || [];
    } catch {}
    try {
      const { sharedLoaderInfo } = await import("./harness.js");
      out.extensions = sharedLoaderInfo()?.extensions || [];
    } catch {}
    try {
      const settingsPath = path.join(process.env.USERPROFILE || "", ".pi", "agent", "settings.json");
      if (fs.existsSync(settingsPath)) {
        out.packages = JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages || [];
      }
    } catch {}
    // MCP: pi has no native MCP by design; scan common config files read-only
    const candidates = [
      path.join(process.env.USERPROFILE || "", ".claude", "claude_desktop_config.json"),
      path.join(process.env.USERPROFILE || "", ".codeium", "windsurf", "mcp_config.json"),
      path.join(APP_ROOT, ".mcp.json"),
    ];
    for (const f of candidates) {
      try {
        if (!fs.existsSync(f)) continue;
        const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
        for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
          out.mcp.push({ name, command: def.command || def.url || "", args: (def.args || []).slice(0, 4), config: f });
        }
      } catch {}
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

api.get("/projects/resources/:id", (req, res) => {
  const p = listProjects().find((x) => x.id === req.params.id);
  res.json(p?.resources || {});
});

// ---- package management: pi install/remove + per-project npm packages ----

const PKG_NPM_DIR = path.join(DATA_DIR, "npm");

function runCmd(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: true, cwd: APP_ROOT, env: process.env });
    let out = "";
    const t = setTimeout(() => {
      out += "\n[超时]";
      p.kill();
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, output: out + String(e) });
    });
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, output: out.slice(-4000) });
    });
  });
}

// resolve pi extension entry files from an installed npm package
function resolvePiEntries(pkgDir) {
  const entries = [];
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return entries;
  }
  let declared = manifest?.pi?.extensions;
  if (!declared && fs.existsSync(path.join(pkgDir, "extensions"))) declared = ["./extensions"];
  for (const rel of declared || []) {
    const full = path.resolve(pkgDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      for (const f of fs.readdirSync(full)) {
        if (/\.(ts|js|mjs)$/i.test(f)) entries.push(path.join(full, f));
      }
    } else if (fs.existsSync(full)) {
      entries.push(full);
    }
  }
  return entries;
}

api.post("/pi/packages/install", async (req, res) => {
  const { spec, scope, projectId } = req.body || {};
  const s = String(spec || "").trim();
  if (!s) return res.status(400).json({ error: "请填写包名（如 npm:pi-web-access）" });
  if (scope === "global") {
    const r = await runCmd("pi", ["install", s]);
    return res.json({ ok: r.code === 0, output: r.output, scope });
  }
  // project scope: npm install into our managed prefix, wire entry paths into
  // the project's resources.extensions (per-project ResourceLoader picks them up)
  if (!projectId) return res.status(400).json({ error: "未选择项目" });
  const npmName = s.replace(/^npm:/, "");
  if (!/^(@[\w.-]+\/)?[\w.-]+(@[\w.^~*-]*)?$/.test(npmName)) {
    return res.status(400).json({ error: "项目级安装仅支持 npm 包名（git/URL 请用全局安装）" });
  }
  fs.mkdirSync(PKG_NPM_DIR, { recursive: true });
  const r = await runCmd("npm", ["install", npmName, "--prefix", PKG_NPM_DIR, "--no-audit", "--no-fund"], { timeoutMs: 15 * 60 * 1000 });
  if (r.code !== 0) return res.json({ ok: false, output: r.output, scope });
  const pkgName = npmName.split("@")[0] && npmName.startsWith("@") ? npmName : npmName.replace(/@[^@]*$/, "");
  const pkgDir = path.join(PKG_NPM_DIR, "node_modules", ...(npmName.startsWith("@") ? npmName.split("/") : [npmName]));
  const entries = resolvePiEntries(pkgDir);
  if (!entries.length) return res.json({ ok: false, output: "包内未找到 pi 扩展入口（package.json 的 pi.extensions 或 extensions/ 目录）" });
  const proj = updateProject(projectId, {
    resources: {
      extensions: [...new Set([...(listProjects().find((x) => x.id === projectId)?.resources?.extensions || []), ...entries])],
      packages: [...new Set([...(listProjects().find((x) => x.id === projectId)?.resources?.packages || []), s])],
    },
  });
  res.json({ ok: true, output: r.output, scope, entries, project: proj });
});

api.post("/pi/packages/remove-global", async (req, res) => {
  const spec = String(req.body?.spec || "").trim();
  if (!spec) return res.status(400).json({ error: "缺少包名" });
  const r = await runCmd("pi", ["remove", spec]);
  res.json({ ok: r.code === 0, output: r.output });
});

// ---- translation (LibreTranslate from our docker stack) ----
api.post("/translate", async (req, res) => {
  const { text, target = "zh", source = "auto" } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "空文本" });
  const url = getConfig().translate?.url || "http://localhost:5001";
  try {
    const r = await fetch(`${url}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: String(text).slice(0, 5000), source, target, format: "text" }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error || `HTTP ${r.status}` });
    res.json({ translated: j.translatedText, detected: j.detectedLanguage });
  } catch (e) {
    res.status(502).json({ error: "翻译服务不可用（docker compose up -d 启动 libretranslate）：" + String(e.message || e).slice(0, 160) });
  }
});

app.use("/api", api);
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

const port = Number(process.env.PORT || getConfig().port || 4318);
migrateLibrary();
app.listen(port, "127.0.0.1", () => {
  console.log(`\n  PiPaper 论文精读工作台  →  http://127.0.0.1:${port}\n`);
});
