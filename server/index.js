import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_ROOT, PUBLIC_DIR, DATA_DIR, getConfig, saveConfig, redactedConfig } from "./config.js";
import { listPapers, getPaper, importPdfFile, mergeZoteroSnapshot, getPapers, getParseState, readBlocks, allSessionMeta, listProjects, createProject, updateProject, deleteProject, parsedDir, attachHash, flushHashCache, fileHash, findByHash } from "./store.js";
import { syncZotero } from "./zotero.js";
import { startParse, getJob, paperWithParseStatus, isParsing } from "./parser/index.js";
import { listVersions, readVersion, activateVersion } from "./parser/versions.js";
import { blocksToContext } from "./parser/mdblocks.js";
import { sourceBounds } from "./parser/regions.js";
import { renderPageCrop } from "./parser/render.js";
import { aggregateSearch, DEFAULT_SOURCES, tierOf } from "./search/engines.js";
import { toreadAdd, toreadList, toreadDelete } from "./toread.js";
import { clipAdd, clipList, clipDelete, clipClear } from "./clip.js";
import * as harness from "./harness.js";
import { registerSessionRoutes } from "./session-routes.js";
import { changePackage } from "./pi-packages.js";
import { setupStatus, setupTest } from "./setup-status.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const UA = "PiPaper/0.5 (academic reader; local app)";

const app = express();
app.use(express.json({ limit: "24mb" }));
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

// ---- setup：环境自检（首次使用引导数据源） ----
api.get("/setup/status", async (_req, res) => {
  try { res.json(await setupStatus()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
api.post("/setup/test/:id", async (req, res) => {
  try { res.json(await setupTest(req.params.id)); }
  catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
});

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
  const rel = req.params[0] || "";
  const base = parsedDir(req.params.id);
  const target = path.resolve(base, rel);
  if (!safeJoin(base, rel)) return res.status(403).end();
  if (!fs.existsSync(target)) return res.status(404).end();
  res.sendFile(target);
});

registerSessionRoutes(api);

function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  const relative = path.relative(path.resolve(base), target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) ? target : null;
}

api.get("/files", (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const out = [];
  // virtual: parsed papers
  for (const p of listPapers()) {
    const parsed = readBlocks(p.id);
    const blocks = Array.isArray(parsed) ? parsed : parsed?.blocks;
    if (blocks) out.push({ label: `《${p.title}》· 解析全文`, path: `paper:${p.id}/${parsed.meta?.versionId ? "version/" + parsed.meta.versionId + "/" : ""}full.md`, kind: "text" });
    for (const b of blocks || []) {
      if (b.type === "image" && b.src) {
        out.push({ label: `《${p.title}》· ${b.caption || "插图"}`, path: `paper:${p.id}/asset/${String(b.src).replace(/^file\//, "")}`, kind: "image" });
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
      const version = m[2].match(/^version\/(v_[a-zA-Z0-9_-]+)\/full\.md$/)?.[1];
      if (m[2] === "full.md" || version) {
        const doc = version ? readVersion(paper.id, version) : readBlocks(paper.id);
        if (!doc) return res.status(404).json({ error: "未解析" });
        const blocks = Array.isArray(doc) ? doc : doc.blocks;
        const text = `[解析版本 ${doc.meta?.versionId || "legacy"}]\n` + blocksToContext(blocks);
        return res.json({ kind: "text", label: `《${paper.title}》解析全文`, versionId: doc.meta?.versionId, content: text.slice(0, 80000) });
      }
      if (m[2].startsWith("asset/")) {
        const name = path.basename(m[2]);
        const relative = m[2].slice("asset/".length);
        const file = safeJoin(parsedDir(paper.id), relative.includes("/") ? relative : path.join("assets", name));
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
// local plugin registry: skills/*/.codex-plugin/plugin.json
function scanLocalPlugins() {
  const out = [];
  const skillsRoot = path.join(getAgentDir(), "skills");
  try {
    for (const d of fs.readdirSync(skillsRoot)) {
      const mf = path.join(skillsRoot, d, ".codex-plugin", "plugin.json");
      if (!fs.existsSync(mf)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(mf, "utf8"));
        out.push({
          id: d,
          name: j.interface?.displayName || j.name || d,
          version: j.version || "",
          description: j.description || j.interface?.shortDescription || "",
          category: j.interface?.category || "",
          dir: path.join(skillsRoot, d),
          skillPath: path.join(skillsRoot, d, "skills"),
        });
      } catch {}
    }
  } catch {}
  return out;
}

api.get("/pi/resources", async (req, res) => {
  try {
    const out = { ...(await harness.resourceInfo(req.query.sessionId, req.query.projectId)), packages: [], mcp: [] };
    out.plugins = scanLocalPlugins();
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
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

// Native package management; project installs are isolated from the tool cwd.
for (const [endpoint, remove, globalOnly] of [["install", false, false], ["remove", true, false], ["remove-global", true, true]]) {
  api.post("/pi/packages/" + endpoint, async (req, res) => {
    try {
      const body = { ...req.body, remove, ...(globalOnly ? { scope: "global" } : {}) };
      const result = await changePackage(body);
      harness.refreshProjectResources(body.scope === "global" ? undefined : body.projectId);
      res.json(result);
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}

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

// ---- video proxy (fixes CORS + allows frame capture for remote URLs) ----
api.get("/video/proxy", async (req, res) => {
  const target = String(req.query.url || "");
  if (!target.startsWith("http://") && !target.startsWith("https://")) return res.status(400).end("bad url");
  try {
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PiPaper/0.8" };
    const ref = String(req.query.referer || "");
    if (ref && ref.startsWith("http")) headers.Referer = ref;
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(target, { headers, redirect: "follow", signal: AbortSignal.timeout(600000) });
    const h = {
      "content-type": upstream.headers.get("content-type") || "video/mp4",
      "access-control-allow-origin": "*",
    };
    for (const k of ["content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(upstream.status, h);
    const { Readable } = await import("node:stream");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(502).end(String(e.message || e).slice(0, 200));
  }
});

// ---- bilibili resolver (official public APIs, per bilibili-API-collect) ----
api.get("/video/bili", async (req, res) => {
  const pageUrl = String(req.query.url || "");
  const bv = (pageUrl.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  if (!bv) return res.status(400).json({ error: "未找到 BV 号" });
  const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://www.bilibili.com/" };
  try {
    const vj = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
    if (vj.code !== 0) throw new Error("view API: " + (vj.message || vj.code));
    const d = vj.data;
    let mp4 = null;
    try {
      const pj = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bv}&cid=${d.cid}&qn=64&platform=html5&high_quality=1`, { headers: H, signal: AbortSignal.timeout(20000) })).json();
      if (pj.code === 0 && pj.data?.durl?.[0]?.url) mp4 = pj.data.durl[0].url;
    } catch {}
    res.json({
      ok: true,
      bv,
      title: d.title,
      duration: d.duration,
      cover: d.pic,
      desc: (d.desc || "").slice(0, 2000),
      owner: d.owner?.name || "",
      pages: d.videos || 1,
      mp4: mp4 ? "/api/video/proxy?referer=" + encodeURIComponent("https://www.bilibili.com/") + "&url=" + encodeURIComponent(mp4) : null,
    });
  } catch (e) {
    res.status(502).json({ error: "B站解析失败: " + String(e.message || e).slice(0, 160) });
  }
});

// ---- clipboard history (2-day TTL) ----
api.get("/clip", (_req, res) => res.json({ entries: clipList() }));
api.post("/clip", (req, res) => {
  const e = clipAdd(req.body?.text);
  res.json(e ? { ok: true, entry: e } : { ok: false });
});
api.delete("/clip/:id", (req, res) => { clipDelete(req.params.id); res.json({ ok: true }); });
api.post("/clip/clear", (_req, res) => { clipClear(); res.json({ ok: true }); });

// ---- academic search ----
// 检索源凭证（apiKey/cookie）与 config 密钥同机制：出接口一律掩码，
// 写回时含 *** 的值还原为已存值，空串表示清除。
const SECRET_FIELDS = ["apiKey", "cookie"];
const maskSecret = (s) => (s ? (s.length <= 6 ? "***" : s.slice(0, 3) + "***" + s.slice(-3)) : s);
function readSourcesFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "search-sources.json"), "utf8"));
  } catch {
    return null;
  }
}
function maskSources(list) {
  return (list || []).map((s) => {
    const out = { ...s };
    for (const f of SECRET_FIELDS) if (out[f]) out[f] = maskSecret(out[f]);
    return out;
  });
}
function restoreMasked(incoming, current) {
  for (const s of incoming) {
    for (const f of SECRET_FIELDS) {
      const v = s[f];
      if (typeof v !== "string") continue;
      if (v.includes("***")) {
        const prev = (current || []).find((c) => c.id === s.id);
        if (prev?.[f]) s[f] = prev[f];
        else delete s[f];
      } else if (v === "") delete s[f];
    }
  }
  return incoming;
}

api.get("/search/sources", (_req, res) => {
  const custom = readSourcesFile();
  res.json({ sources: custom ? maskSources(custom) : DEFAULT_SOURCES, custom: !!custom, defaults: DEFAULT_SOURCES });
});

api.put("/search/sources", (req, res) => {
  const sources = req.body?.sources;
  if (!Array.isArray(sources)) return res.status(400).json({ error: "sources 必须是数组" });
  restoreMasked(sources, readSourcesFile());
  fs.writeFileSync(path.join(DATA_DIR, "search-sources.json"), JSON.stringify(sources, null, 2));
  res.json({ ok: true, sources: maskSources(sources) });
});

// user-facing add: only needs a URL (+optional key/cookie); metadata auto-filled
api.post("/search/sources/add", (req, res) => {
  const { url, apiKey, cookie } = req.body || {};
  const u = String(url || "").trim();
  if (!u) return res.status(400).json({ error: "请填写网址" });
  let sources;
  try {
    sources = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "search-sources.json"), "utf8"));
  } catch {
    sources = JSON.parse(JSON.stringify(DEFAULT_SOURCES));
  }
  let def;
  const lower = u.toLowerCase();
  if (lower.includes("panda985") || lower.includes("scholar")) {
    def = {
      id: "scholar-" + Date.now().toString(36),
      name: "Google 学术（自定义镜像）",
      type: "scholar-mirror",
      enabled: true,
      url: u.replace(/\/$/, ""),
      note: cookie ? "已配置 Cookie" : "未配 Cookie — 浏览器过一次验证后把 Cookie 粘贴进来",
    };
    if (cookie) def.cookie = cookie.trim();
  } else if (lower.includes("semanticscholar")) {
    const existing = sources.find((x) => x.id === "semanticscholar");
    if (existing) {
      if (apiKey) existing.apiKey = apiKey.trim();
      def = existing;
    } else {
      def = { id: "semanticscholar", name: "Semantic Scholar", type: "semanticscholar", enabled: true, note: apiKey ? "已配置 apiKey" : "开放（限速）" };
      if (apiKey) def.apiKey = apiKey.trim();
      sources.push(def);
    }
    fs.writeFileSync(path.join(DATA_DIR, "search-sources.json"), JSON.stringify(sources, null, 2));
    return res.json({ ok: true, source: maskSources([def])[0], sources: maskSources(sources) });
  } else {
    // generic mirror entry; the adapter scraper handles scholar-style layouts
    def = {
      id: "mirror-" + Date.now().toString(36),
      name: "自定义学术站点",
      type: "scholar-mirror",
      enabled: true,
      url: u.replace(/\/$/, ""),
      note: cookie ? "已配置 Cookie" : "未配 Cookie",
    };
    if (cookie) def.cookie = cookie.trim();
  }
  const i = sources.findIndex((x) => x.id === def.id);
  if (i >= 0) sources[i] = def;
  else sources.push(def);
  fs.writeFileSync(path.join(DATA_DIR, "search-sources.json"), JSON.stringify(sources, null, 2));
  res.json({ ok: true, source: maskSources([def])[0], sources: maskSources(sources) });
});

api.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ results: [], total: 0, errors: [] });
  let sources;
  try {
    const f = path.join(DATA_DIR, "search-sources.json");
    if (fs.existsSync(f)) sources = (JSON.parse(fs.readFileSync(f, "utf8")) || []).filter((s) => s.enabled).map((s) => s.id);
  } catch {}
  const requestedSources = String(req.query.sources || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const r = await aggregateSearch(q, {
      sources: requestedSources.length ? requestedSources : sources,
      yearFrom: req.query.yearFrom,
      yearTo: req.query.yearTo,
      oa: req.query.oa === "1",
      sort: req.query.sort,
      quartile: req.query.quartile,
      projectId: req.query.projectId,
      anchorPaperId: req.query.anchor,
      limit: Number(req.query.limit || 15),
    });
    r.results = r.results.map((x) => ({ ...x, tier: tierOf(x) }));
    res.json({ ...r, sources: sources || null });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// import a search result: download the OA pdf and manage it like any import
api.post("/search/import", async (req, res) => {
  const { pdfUrl, title, projectId } = req.body || {};
  if (!pdfUrl) return res.status(400).json({ error: "该结果没有可下载的 PDF（非开放获取）" });
  try {
    const r = await fetch(pdfUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000), redirect: "follow" });
    if (!r.ok) throw new Error("下载失败 HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10000 || buf[0] !== 0x25) throw new Error("下载内容不是有效 PDF（可能被出版社拦截）");
    const { paper, reused } = importPdfFile((title || "paper") + ".pdf", buf);
    if (projectId) updateProject(projectId, { addPaper: paper.id });
    res.json({ ...paperWithParseStatus(paper), reused, imported: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
});

// ---- to-read list: 检索结果元数据暂存（不下载）；“加入项目”时前端再调 /api/search/import ----
api.get("/search/toread", (_req, res) => {
  res.json({ entries: toreadList() });
});

api.post("/search/toread", (req, res) => {
  const r = toreadAdd(req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.reason || "无效条目" });
  res.json({ ok: true, entry: r.entry, dup: r.dup });
});

api.delete("/search/toread/:id", (req, res) => {
  res.json({ ok: toreadDelete(req.params.id) });
});

app.use("/api", api);
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

const port = Number(process.env.PORT || getConfig().port || 4318);
migrateLibrary();
app.listen(port, "127.0.0.1", () => {
  console.log(`\n  PiPaper 论文精读工作台  →  http://127.0.0.1:${port}\n`);
});
