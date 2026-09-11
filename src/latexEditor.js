import { api, state, $, el, toast } from "./app.js";
import { registerModule } from "./modules.js";

// LaTeX 编辑器模块：文件树 + 源码编辑器 + PDF 预览 + 编译日志。
// 后端 /api/latex/* 严格限定在配置的 LaTeX 工作区（默认 latex-writing）内。

let alive = false;
let rootEl = null;
let current = null;       // 当前打开的相对路径
let dirty = false;
let compileSeq = 0;

const fmtName = (p) => p.split("/").pop();

async function latexApi(path, opts = {}) {
  const res = await fetch("/api/latex/" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function registerLatexModule() {
  registerModule({
    id: "latex",
    name: "LaTeX 编辑器",
    icon: "📄",
    mount(body) {
      alive = true; dirty = false; current = null;
      const status = el("span", { class: "res-note", style: { flex: "1", textAlign: "right", minWidth: "0", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } });
      const fileLabel = el("span", { class: "lm-file" }, "未打开文件");
      const tree = el("div", { class: "lm-tree" });
      const editor = el("textarea", { class: "lm-editor", spellcheck: "false", placeholder: "左侧选择 .tex / .bib 文件开始编辑…" });
      const pdfFrame = el("iframe", { class: "lm-pdf", title: "PDF 预览" });
      const logBox = el("pre", { class: "lm-log" }, "编译日志会显示在这里。");

      const setStatus = (t) => { status.textContent = t || ""; };

      async function save() {
        if (!current) return toast("先打开文件", true);
        try {
          await latexApi("file", { method: "PUT", body: { path: current, content: editor.value } });
          dirty = false;
          fileLabel.textContent = current;
          setStatus("已保存 ✓");
          refreshTree();
        } catch (e) { setStatus(""); toast("保存失败: " + e.message, true); }
      }

      async function doCompile() {
        if (!current || !/\.tex$/i.test(current)) return toast("请先打开 .tex 文件", true);
        if (dirty) await save();
        const seq = ++compileSeq;
        setStatus("编译中…");
        logBox.textContent = "编译中…（pdflatex → bibtex → pdflatex ×2）";
        try {
          const r = await latexApi("compile", { method: "POST", body: { path: current } });
          if (seq !== compileSeq || !alive) return;
          logBox.textContent = (r.log || "").split("\n").slice(-40).join("\n") || "(无输出)";
          if (r.ok) {
            setStatus(`编译成功 ✓ ${r.pages ? r.pages + " 页" : ""}`);
            pdfFrame.src = "/api/latex/pdf?path=" + encodeURIComponent(r.pdf) + "&t=" + Date.now();
          } else {
            setStatus(r.hasError ? "编译失败 ✗（见日志）" : "未产出 PDF ✗");
            toast("编译失败，查看底部日志", true);
          }
        } catch (e) {
          if (seq === compileSeq && alive) { setStatus(""); toast("编译失败: " + e.message, true); }
        }
      }

      async function openFile(rel) {
        try {
          const r = await latexApi("file?path=" + encodeURIComponent(rel));
          editor.value = r.content;
          current = rel; dirty = false;
          fileLabel.textContent = rel;
          setStatus(`${rel.split(".").pop().toUpperCase()} · ${r.content.split("\n").length} 行`);
          editor.focus();
        } catch (e) { toast("打开失败: " + e.message, true); }
      }

      async function refreshTree() {
        tree.replaceChildren(el("div", { class: "res-note", style: { padding: "8px" } }, "加载中…"));
        try {
          const data = await latexApi("files");
          const groups = { "papers/": [], "template/": [], "其他": [] };
          for (const f of data.files) {
            if (f.path.startsWith("papers/")) groups["papers/"].push(f);
            else if (f.path.startsWith("template/")) groups["template/"].push(f);
            else groups["其他"].push(f);
          }
          tree.replaceChildren();
          tree.append(el("div", { class: "lm-root", title: data.root }, "📁 " + data.root));
          for (const [g, files] of Object.entries(groups)) {
            if (!files.length) continue;
            tree.append(el("div", { class: "lm-group" }, g));
            for (const f of files) {
              const item = el("div", {
                class: "lm-item" + (current === f.path ? " active" : ""),
                title: f.path,
                onclick: () => { tree.querySelectorAll(".lm-item.active").forEach((n) => n.classList.remove("active")); item.classList.add("active"); openFile(f.path); },
              }, (f.path.endsWith(".tex") ? "📄 " : f.path.endsWith(".bib") ? "📚 " : "📃 ") + fmtName(f.path));
              tree.append(item);
            }
          }
        } catch (e) {
          tree.replaceChildren(el("div", { class: "res-note", style: { padding: "8px" } }, "加载失败: " + (e.message || e)));
        }
      }

      editor.addEventListener("input", () => {
        if (!dirty) { dirty = true; fileLabel.textContent = (current || "") + " ●"; }
      });
      editor.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      });

      const toolbar = el("div", { class: "lm-toolbar" },
        fileLabel,
        el("button", { class: "tool-btn", title: "保存（Ctrl+S）", onclick: save }, "保存"),
        el("button", { class: "tool-btn primary", title: "编译当前 .tex（pdflatex → bibtex → pdflatex×2）", onclick: doCompile }, "▶ 编译"),
        status
      );
      const main = el("div", { class: "lm-main" }, tree, editor, pdfFrame);
      rootEl = el("div", { class: "latex-mod" }, toolbar, main, logBox);
      body.append(rootEl);
      refreshTree();
      window.dispatchEvent(new Event("resize"));
    },
    unmount() {
      alive = false;
      compileSeq++;
      rootEl?.remove();
      rootEl = null;
    },
  });
}
