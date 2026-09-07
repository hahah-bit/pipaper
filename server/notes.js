import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { APP_ROOT } from "./config.js";

// 知识库：粗读 / 精读两类目录彼此隔离，每篇论文一个子文件夹（含 meta.json），
// 删除以文件夹为单位递归移除，保证「删得彻底」。
export const KNOWLEDGE_DIR = path.join(APP_ROOT, "knowledge");
export const NOTE_CATEGORIES = ["粗读", "精读"];

const error = (text, status = 400) => Object.assign(new Error(text), { status });

const shortHash = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 6);

function slugify(title) {
  const base = String(title || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return base || "untitled";
}

// rel 必须严格落在 knowledge/ 内部，拒绝一切穿越
function insideKnowledge(rel) {
  const target = path.resolve(KNOWLEDGE_DIR, String(rel || ""));
  const r = path.relative(path.resolve(KNOWLEDGE_DIR), target);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? target : null;
}

export function ensurePaper({ paperId, title, category = "粗读" } = {}) {
  if (!NOTE_CATEGORIES.includes(category)) throw error("未知的知识库类别");
  if (!paperId) throw error("缺少论文 id");
  const slug = slugify(title) + "-" + shortHash(paperId);
  const dir = path.join(KNOWLEDGE_DIR, category, slug);
  fs.mkdirSync(dir, { recursive: true });
  const metaFile = path.join(dir, "meta.json");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
  meta = { paperId, title: title || meta.title || slug, category, slug, createdAt: meta.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return meta;
}

export function listNotes() {
  const categories = NOTE_CATEGORIES.map((category) => {
    const root = path.join(KNOWLEDGE_DIR, category);
    const papers = [];
    let entries = [];
    try { entries = fs.readdirSync(root); } catch {}
    for (const slug of entries) {
      const dir = path.join(root, slug);
      let stat = null;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch {}
      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter((f) => f !== "meta.json" && /\.md$/i.test(f))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { name: f, path: `${category}/${slug}/${f}`, size: st.size, mtime: st.mtimeMs };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {}
      papers.push({ slug, title: meta.title || slug, paperId: meta.paperId || null, files });
    }
    papers.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return { category, papers };
  });
  return { root: "knowledge", categories };
}

export function deleteNoteFile(rel) {
  const target = insideKnowledge(rel);
  if (!target) throw error("路径越界");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw error("文件不存在", 404);
  fs.rmSync(target, { force: true });
  if (fs.existsSync(target)) throw error("删除失败：文件仍存在", 500);
  return { ok: true };
}

export function deleteNotePaper(category, slug) {
  if (!NOTE_CATEGORIES.includes(category)) throw error("未知的知识库类别");
  if (!slug || /[\\/:*?"<>|]/.test(slug)) throw error("非法的论文目录名");
  const dir = insideKnowledge(path.join(category, slug));
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw error("论文目录不存在", 404);
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(dir)) throw error("删除失败：目录仍存在", 500);
  return { ok: true };
}

export function registerNoteRoutes(api) {
  api.get("/notes", (_req, res) => {
    try { res.json(listNotes()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // 仅计算 slug，不创建任何目录（浏览笔记时用；ensure 才落盘）
  api.get("/notes/resolve", (req, res) => {
    const paperId = String(req.query.paperId || "");
    if (!paperId) return res.status(400).json({ error: "缺少论文 id" });
    res.json({ slug: slugify(req.query.title) + "-" + shortHash(paperId) });
  });
  api.post("/notes/ensure", (req, res) => {
    try { res.json(ensurePaper(req.body || {})); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
  api.delete("/notes/file", (req, res) => {
    try { res.json(deleteNoteFile(req.query.path)); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
  api.delete("/notes/paper", (req, res) => {
    try { res.json(deleteNotePaper(String(req.query.category || ""), String(req.query.slug || ""))); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
}
