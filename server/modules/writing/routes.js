import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, LIBRARY_DIR } from "../../config.js";
import { listPapers, getPaper, readBlocks, parsedDir } from "../../store.js";
import { readVersion } from "../../parser/versions.js";
import { blocksToContext } from "../../parser/mdblocks.js";
import { safeJoin } from "../../platform/files/paths.js";

export function registerWorkspaceFileRoutes(api) {
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


}
