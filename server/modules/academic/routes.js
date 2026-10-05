import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import { importPdfFile, updateProject } from "../../store.js";
import { paperWithParseStatus } from "../../parser/index.js";
import { aggregateSearch, DEFAULT_SOURCES, tierOf } from "../../search/engines.js";
import { toreadAdd, toreadList, toreadDelete } from "../../toread.js";
import { writeFile as managedWrite } from "../../storage/files.js";
const UA = "PiPaper/0.5 (academic reader; local app)";

export function registerAcademicRoutes(api) {
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
    managedWrite(path.join(DATA_DIR, "search-sources.json"), JSON.stringify(sources, null, 2));
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
      managedWrite(path.join(DATA_DIR, "search-sources.json"), JSON.stringify(sources, null, 2));
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
    managedWrite(path.join(DATA_DIR, "search-sources.json"), JSON.stringify(sources, null, 2));
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
}
