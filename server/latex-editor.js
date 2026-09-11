import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { APP_ROOT, getConfig, saveConfig } from "./config.js";

// PiPaper 内置 LaTeX 编辑器后端：把一个外部目录（默认 latex-writing 工作区）
// 作为可编辑的 LaTeX 项目打开。所有路径经 safeJoin 严格限定在该根目录内。
const MIKTEX_BIN = "C:\\Users\\fbl\\AppData\\Local\\Programs\\MiKTeX\\miktex\\bin\\x64";
const TEXT_EXT = /\.(tex|bib|sty|cls|md|txt)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".pi", "reports", "knowledge", "_build"]);

const error = (text, status = 400) => Object.assign(new Error(text), { status });

export function latexRoot() {
  const configured = String(getConfig().latex?.workspaceRoot || "").trim();
  if (configured && fs.existsSync(configured)) return path.resolve(configured);
  const fallback = "E:\\codex_skills_create\\latex-writing";
  if (fs.existsSync(fallback)) return fallback;
  return APP_ROOT;
}

export function setLatexRoot(root) {
  const p = path.resolve(String(root || "").trim());
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw error("目录不存在");
  saveConfig({ latex: { workspaceRoot: p } });
  return latexRoot();
}

function insideRoot(rel) {
  const base = latexRoot();
  const target = path.resolve(base, String(rel || ""));
  const r = path.relative(base, target);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? target : null;
}

export function listFiles() {
  const root = latexRoot();
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 4 || out.length > 500) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length > 500) break;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(dir, e.name), r, depth + 1);
      } else if (TEXT_EXT.test(e.name)) {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ path: r, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, "", 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files: out };
}

export function readFile(rel) {
  const target = insideRoot(rel);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw error("文件不存在", 404);
  if (!TEXT_EXT.test(target)) throw error("仅支持文本文件（tex/bib/sty/cls/md/txt）");
  return { path: String(rel), content: fs.readFileSync(target, "utf8") };
}

export function writeFile(rel, content) {
  const target = insideRoot(rel);
  if (!target) throw error("路径越界");
  if (!TEXT_EXT.test(target)) throw error("仅支持文本文件（tex/bib/sty/cls/md/txt）");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(content ?? ""), "utf8");
  return { ok: true, path: String(rel), bytes: Buffer.byteLength(String(content ?? ""), "utf8") };
}

function runCmd(cmd, args, cwd, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const extraPath = fs.existsSync(MIKTEX_BIN) ? MIKTEX_BIN + path.delimiter : "";
    const env = { ...process.env, PATH: extraPath + process.env.PATH };
    const bin = fs.existsSync(path.join(MIKTEX_BIN, cmd + ".exe")) ? path.join(MIKTEX_BIN, cmd + ".exe") : cmd;
    execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || "") + String(stderr || "") });
    });
  });
}

export async function compile(relTex) {
  const target = insideRoot(relTex);
  if (!target || !fs.existsSync(target) || !/\.tex$/i.test(target)) throw error("需要工作区内的 .tex 文件");
  const dir = path.dirname(target);
  const base = path.basename(target, ".tex");

  const p1 = await runCmd("pdflatex", ["-interaction=nonstopmode", base + ".tex"], dir);
  const bibExist = fs.existsSync(path.join(dir, base + ".aux")) &&
    fs.readFileSync(path.join(dir, base + ".aux"), "utf8").includes("bibdata");
  if (bibExist) await runCmd("bibtex", [base], dir);
  const p2 = await runCmd("pdflatex", ["-interaction=nonstopmode", base + ".tex"], dir);
  const p3 = await runCmd("pdflatex", ["-interaction=nonstopmode", base + ".tex"], dir);

  const log = [p1.out, p2.out, p3.out].join("\n");
  const lastLogPath = path.join(dir, base + ".log");
  const lastLog = fs.existsSync(lastLogPath) ? fs.readFileSync(lastLogPath, "utf8") : "";
  const hasError = /^!/m.test(lastLog);
  const pagesMatch = log.match(/Output written on [^ ]+\.pdf \((\d+) page/);
  const pdfRel = path.relative(latexRoot(), path.join(dir, base + ".pdf")).split(path.sep).join("/");
  const pdfExists = fs.existsSync(path.join(dir, base + ".pdf"));
  return {
    ok: !hasError && pdfExists,
    pages: pagesMatch ? Number(pagesMatch[1]) : null,
    pdf: pdfExists ? pdfRel : null,
    hasError,
    log: log.slice(-8000),
  };
}

export function registerLatexRoutes(api) {
  api.get("/latex/config", (_req, res) => res.json({ root: latexRoot() }));
  api.put("/latex/config", (req, res) => {
    try { res.json({ ok: true, root: setLatexRoot(req.body?.root) }); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
  api.get("/latex/files", (_req, res) => {
    try { res.json(listFiles()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.get("/latex/file", (req, res) => {
    try { res.json(readFile(req.query.path)); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
  api.put("/latex/file", (req, res) => {
    try { res.json(writeFile(req.body?.path, req.body?.content)); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
  api.post("/latex/compile", async (req, res) => {
    try { res.json(await compile(req.body?.path)); }
    catch (e) { res.status(e.status || 400).json({ error: String(e.message || e) }); }
  });
  api.get("/latex/pdf", (req, res) => {
    const target = insideRoot(req.query.path);
    if (!target || !fs.existsSync(target) || !/\.pdf$/i.test(target)) return res.status(404).json({ error: "PDF 不存在" });
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(target);
  });
}
