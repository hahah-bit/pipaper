import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import { importPdfFile, updateProject, upsertPaper, getProject } from "../../store.js";
import { paperWithParseStatus } from "../../parser/index.js";
import { aggregateSearch, DEFAULT_SOURCES, tierOf } from "../../search/engines.js";
import { toreadAdd, toreadList, toreadDelete, toreadUpdate } from "../../toread.js";
import { writeFile as managedWrite } from "../../storage/files.js";
import { enrichResearchResults } from "../../search/research-match.js";
import { pickResearchMatch } from "../../search/literature-purpose.js";
import { normalizePurposeCategories } from "../../../shared/literature-purpose.js";
import { remote } from "../../platform/academic/transport.js";
const UA = "PiPaper/0.5 (academic reader; local app)";

export function registerAcademicRoutes(api, services = {}) {
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
    if ((lower.includes("panda985") || lower.includes("scholar")) && !lower.includes("semanticscholar")) {
      def = {
        id: "scholar-" + Date.now().toString(36),
        name: "Google 学术（自定义镜像）",
        type: "scholar-mirror",
        enabled: true,
        url: u.replace(/\/$/, ""),
        note: cookie ? "已配置 Cookie" : "未配 Cookie — 浏览器过一次验证后把 Cookie 粘贴进来",
      };
      if (cookie) def.cookie = cookie.trim();
    } else if (lower.includes("semanticscholar") || lower.includes("openalex")) {
      const id = lower.includes("openalex") ? "openalex" : "semanticscholar";
      const name = id === "openalex" ? "OpenAlex" : "Semantic Scholar";
      const existing = sources.find((x) => x.id === id);
      if (existing) {
        if (apiKey) existing.apiKey = apiKey.trim();
        existing.enabled = true;
        def = existing;
      } else {
        def = { id, name, type: id, enabled: true, note: apiKey ? "已配置 apiKey" : "开放（限速）" };
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
    if (Buffer.byteLength(q) > 8192) return res.status(400).json({ error: "检索词过长" });
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
      const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
      if (projectId && !getProject(projectId)) return res.status(404).json({ error: "项目不存在" });
      const controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", abort);
      const r = await (services.aggregateSearch || aggregateSearch)(q, {
        sources: Object.hasOwn(req.query, "sources") ? requestedSources : sources,
        yearFrom: req.query.yearFrom,
        yearTo: req.query.yearTo,
        oa: req.query.oa === "1",
        sort: req.query.sort === "research" ? "recommended" : req.query.sort,
        quartile: req.query.quartile,
        projectId,
        anchorPaperId: req.query.anchor,
        limit: Math.max(1, Math.min(60, Math.floor(Number(req.query.limit) || 15))),
        signal: controller.signal,
      });
      if (req.query.research !== "0") {
        try {
          const enriched = await (services.enrichResearchResults || enrichResearchResults)(r.results, q, {
            projectId, anchorPaperId: req.query.anchor, signal: controller.signal,
          });
          r.results = enriched.results;
          r.researchContext = enriched.researchContext;
        } catch (error) {
          controller.signal.throwIfAborted();
          r.researchContext = { enabled: true, projectId: projectId || null, status: "unavailable",
            warnings: ["研究匹配暂不可用，请查看研究档案与知识库状态"], reason: "研究匹配暂不可用" };
        }
      } else {
        r.researchContext = { enabled: false, projectId: projectId || null, status: "disabled" };
      }
      if (req.query.sort === "research") r.results.sort((a, b) =>
        (Number(b.researchMatch?.score) || 0) - (Number(a.researchMatch?.score) || 0) ||
        (Number(b.readScore) || 0) - (Number(a.readScore) || 0));
      r.results = r.results.map((x) => ({ ...x, tier: tierOf(x) }));
      res.json({ ...r, sources: sources || null });
    } catch (e) {
      if (!res.destroyed) res.status(e.status || 502).json({ error: String(e.message || e) });
    }
  });

  // import a search result: download the OA pdf and manage it like any import
  api.post("/search/import", async (req, res) => {
    const { pdfUrl, title, projectId, researchMatch, purposeCategories } = req.body || {};
    if (!pdfUrl) return res.status(400).json({ error: "该结果没有可下载的 PDF（非开放获取）" });
    try {
      if (projectId && !getProject(projectId)) return res.status(404).json({ error: "项目不存在" });
      const purposes = purposeCategories == null ? undefined : normalizePurposeCategories(purposeCategories);
      const response = await (services.remote || remote)(pdfUrl, { headers: { "User-Agent": UA }, timeoutMs: 120000, maxBytes: 100 * 1024 * 1024 });
      if (projectId && !getProject(projectId)) return res.status(404).json({ error: "下载期间项目已删除，文献尚未导入" });
      const buf = response.buffer;
      if (buf.length < 10000 || buf[0] !== 0x25) throw new Error("下载内容不是有效 PDF（可能被出版社拦截）");
      const { paper, reused } = importPdfFile((title || "paper") + ".pdf", buf);
      const incomingMatch = pickResearchMatch(researchMatch);
      // A reading-list snapshot can belong to a different project. Preserve its
      // provenance instead of relabelling that project's evidence as this one's.
      const match = incomingMatch && incomingMatch.projectId === (projectId || "") ? incomingMatch : null;
      if (match || purposes !== undefined) {
        const contextKey = projectId || "library";
        const previous = paper.literatureContexts?.[contextKey] || {};
        paper.literatureContexts = { ...paper.literatureContexts, [contextKey]: {
          ...previous,
          ...(match ? { researchMatch: match } : {}),
          ...(purposes !== undefined ? { purposeCategories: purposes } : {}),
          savedAt: new Date().toISOString(),
        } };
        upsertPaper(paper);
      }
      if (projectId) updateProject(projectId, { addPaper: paper.id });
      res.json({ ...paperWithParseStatus(paper), reused, imported: true, matchDiscarded: !!incomingMatch && !match });
    } catch (e) {
      res.status(e.status || 502).json({ error: String(e.message || e).slice(0, 200) });
    }
  });

  // ---- to-read list: 检索结果元数据暂存（不下载）；“加入项目”时前端再调 /api/search/import ----
  api.get("/search/toread", (_req, res) => {
    res.json({ entries: toreadList() });
  });

  api.post("/search/toread", (req, res) => {
    try {
      const r = toreadAdd(req.body || {});
      if (!r.ok) return res.status(400).json({ error: r.reason || "无效条目" });
      res.json({ ok: true, entry: r.entry, dup: r.dup });
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message });
    }
  });

  api.patch("/search/toread/:id", (req, res) => {
    try { res.json({ ok: true, entry: toreadUpdate(req.params.id, req.body || {}) }); }
    catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  });

  api.delete("/search/toread/:id", (req, res) => {
    res.json({ ok: toreadDelete(req.params.id) });
  });
}
