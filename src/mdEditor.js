import { api, state, el, toast, askText } from "./app.js";
import { registerModule } from "./modules.js";
import { renderMd } from "./chat.js";
import { runTempPrompt, removeTempSession } from "./tempSession.js";
import { diffLines } from "diff";

// LaTeX·MD 编辑模式（dock 抽屉）：手工 + 模型辅助编辑知识库里的 Markdown 文档。
// - 左源码右 KaTeX 实时预览（与阅读器同一套渲染管道），可 编辑/分屏/预览 切换
// - 文件来源：knowledge/ 三类知识库（粗读/精读/图表分析）的 .md；可为当前论文新建精读笔记
// - AI 辅助：指令框 + 快捷动作（润色选段 / 中译英 / LaTeX 纠错 / 公式转编号），
//   走 tempSession 临时会话，返回修改稿后先看行级 diff，确认后才应用（应用后仍需手动保存）
// 保存走 POST /api/notes/file（严格限定 knowledge/ 内 .md）。

let alive = false;

const INSERTS = [
  { label: "$x$", title: "插入行内公式", wrap: ["$", "$"] },
  { label: "$$…$$", title: "插入块级公式", wrap: ["$$\n", "\n$$"] },
  { label: "B", title: "加粗", wrap: ["**", "**"] },
  { label: "I", title: "斜体", wrap: ["*", "*"] },
  { label: "`", title: "行内代码", wrap: ["`", "`"] },
  { label: "H2", title: "二级标题", prefix: "## " },
  { label: "表格", title: "插入 3×3 表格骨架", block: "| 列A | 列B | 列C |\n|---|---|---|\n|  |  |  |\n|  |  |  |\n" },
];

const QUICK_ACTIONS = [
  { label: "✨ 润色选中段落", scope: "selection", instruction: "润色下面这段文字：让表述更学术、更精炼、逻辑更顺，保持原意与所有公式、引用不变。用中文输出。" },
  { label: "🀄 中译英（学术）", scope: "selection", instruction: "把下面这段中文翻译为学术英语（论文风格），保留全部 LaTeX 公式、引用标记与 Markdown 结构。" },
  { label: "🧮 LaTeX 纠错", scope: "doc", instruction: "检查全文中的 LaTeX 公式：修正括号不配对、定界符缺失、命令拼写错误等语法问题；不要改动公式以外的任何内容与措辞。" },
];

function fileLabel(path) {
  const parts = String(path || "").split("/");
  return parts.length > 1 ? `${parts[0]} · ${parts[parts.length - 1]}` : path;
}

// 从 AI 回复里提取 markdown 代码块；没有围栏就把整段回复当结果
function extractMarkdown(text) {
  const blocks = [...String(text || "").matchAll(/```(?:markdown|md)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1]);
  if (!blocks.length) return String(text || "").trim();
  return blocks.sort((a, b) => b.length - a.length)[0].trim();
}

// 行级 diff（jsdiff diffLines）：[{type:'same'|'add'|'del', text}]
function diffRows(oldText, newText) {
  return diffLines(oldText, newText).map((p) => ({
    type: p.added ? "add" : p.removed ? "del" : "same",
    text: p.value.replace(/\n$/, ""),
  }));
}

export function registerMdEditorModule() {
  registerModule({
    id: "mdedit",
    name: "LaTeX·MD 编辑",
    icon: "✍️",
    mount(body, ctx) {
      alive = true;
      const setStatus = (t) => { statusEl.textContent = t || ""; ctx?.setStatus?.(t || ""); };

      // ---- 顶部工具条 ----
      const fileSel = el("select", { class: "mde-file", title: "选择要编辑的知识库 Markdown 文件" }, el("option", { value: "" }, "— 选择文件 —"));
      const statusEl = el("span", { class: "res-note", style: { flex: "1", textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } });
      const btnNew = el("button", { class: "tool-btn", title: "为当前论文新建一篇精读笔记", onclick: createNote }, "＋新建");
      const btnSave = el("button", { class: "tool-btn primary", title: "保存（Ctrl+S）", onclick: save }, "保存");
      const modeBtns = {};
      const aiToggle = el("button", { class: "tool-btn", title: "模型辅助改稿（点开指令栏）", onclick: () => { aiBar.hidden = !aiBar.hidden; aiToggle.classList.toggle("active", !aiBar.hidden); if (!aiBar.hidden) aiInput.focus(); } }, "🤖 AI");
      const toolbar = el("div", { class: "mde-toolbar" }, fileSel, btnNew, mkInsertBar(), el("div", { class: "spacer" }), modeBtn("edit", "编辑"), modeBtn("split", "分屏"), modeBtn("preview", "预览"), aiToggle, btnSave, statusEl);

      function modeBtn(mode, label) {
        const b = el("button", { class: "tool-btn", onclick: () => setMode(mode) }, label);
        modeBtns[mode] = b;
        return b;
      }

      // ---- 编辑区 + 预览 ----
      const editor = el("textarea", { class: "mde-editor", spellcheck: "false", placeholder: "左侧选择知识库文件开始编辑…支持 Markdown + LaTeX 数学（$…$ / $$…$$）" });
      const preview = el("div", { class: "mde-preview paper-doc" });
      const main = el("div", { class: "mde-main mode-split" }, editor, preview);

      let currentPath = "";
      let dirty = false;
      let mode = "split";
      let previewTimer = null;

      function setMode(m) {
        mode = m;
        main.className = "mde-main mode-" + m;
        for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle("active", k === m);
      }
      setMode("split");

      function markDirty() {
        if (!dirty) { dirty = true; statusEl.textContent = (currentPath || "") + " ●"; }
        schedulePreview();
      }
      function schedulePreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => { try { renderMd(editor.value, preview); } catch {} }, 320);
      }

      editor.addEventListener("input", markDirty);
      editor.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
        if (e.key === "Tab") {
          e.preventDefault();
          insertBlock("    ");
        }
      });

      function insertWrap(prefix, suffix) {
        const s = editor.selectionStart, epos = editor.selectionEnd;
        const selected = editor.value.slice(s, epos);
        editor.setRangeText(prefix + selected + suffix, s, epos, "end");
        if (selected) editor.setSelectionRange(s + prefix.length, s + prefix.length + selected.length);
        else editor.setSelectionRange(s + prefix.length, s + prefix.length);
        editor.focus();
        markDirty();
      }

      function insertBlock(text) {
        const s = editor.selectionStart, epos = editor.selectionEnd;
        editor.setRangeText(text, s, epos, "end");
        editor.focus();
        markDirty();
      }

      function mkInsertBar() {
        return el("div", { class: "mde-inserts" }, ...INSERTS.map((ins) => el("button", {
          class: "tool-btn mde-ins", title: ins.title,
          onclick: () => ins.block != null ? insertBlock(ins.block) : ins.prefix ? insertBlock(ins.prefix) : insertWrap(ins.wrap[0], ins.wrap[1]),
        }, ins.label)));
      }

      // ---- AI 辅助改稿 ----
      const scopeSel = el("select", { class: "mde-scope", title: "AI 修改范围" },
        el("option", { value: "auto" }, "范围: 自动"),
        el("option", { value: "doc" }, "范围: 整篇"),
        el("option", { value: "selection" }, "范围: 选中"));
      const aiInput = el("input", { class: "mde-ai-input", type: "text", placeholder: "告诉 AI 怎么改（如：把第 2 节改写成三段式；给公式加编号…），Enter 提交" });
      const aiRun = el("button", { class: "tool-btn primary", onclick: () => runAi() }, "▶ AI 改稿");
      const aiBar = el("div", { class: "mde-ai", hidden: true },
        el("span", { class: "mde-ai-label" }, "🤖 模型辅助"),
        scopeSel, aiInput, aiRun,
        ...QUICK_ACTIONS.map((q) => el("button", { class: "tool-btn mde-quick", onclick: () => runAi(q) }, q.label)));
      aiInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) runAi(); });

      // diff 结果面板
      const diffBox = el("div", { class: "mde-diff" });
      const aiPanel = el("div", { class: "mde-panel", hidden: true },
        el("div", { class: "mde-panel-head" },
          el("span", { class: "mde-panel-title" }, "AI 修改稿 · 对比预览"),
          el("span", { class: "res-note", style: { flex: "1" } }, "绿色=新增，红色=删除；确认后写入编辑器（还需手动保存）"),
          el("button", { class: "tool-btn primary", onclick: applyAi }, "✓ 应用"),
          el("button", { class: "tool-btn", onclick: () => (aiPanel.hidden = true) }, "✕ 放弃")),
        diffBox);
      let aiPending = null; // { target: 'doc'|{start,end}, text }

      function currentScope(explicit) {
        const scope = explicit || scopeSel.value;
        const s = editor.selectionStart, epos = editor.selectionEnd;
        if (scope === "doc") return { target: "doc" };
        if (scope === "selection" || (scope === "auto" && epos > s)) {
          if (epos > s) return { target: { start: s, end: epos } };
          toast("没有选中文本，已改为整篇", false);
        }
        return { target: "doc" };
      }

      async function runAi(quick) {
        if (!currentPath) return toast("先选择要编辑的文件", true);
        const { target } = currentScope(quick?.scope);
        const instruction = (quick?.instruction || aiInput.value.trim());
        if (!instruction) return toast("先输入修改指令", true);
        const full = editor.value;
        const source = target === "doc" ? full : full.slice(target.start, target.end);
        if (!source.trim()) return toast("改写内容为空", true);

        aiRun.disabled = true;
        setStatus("AI 改稿中…");
        const prompt =
          `你正在辅助编辑一篇论文笔记（Markdown + LaTeX 数学，$…$ 行内 / $$…$$ 块级）。\n` +
          `用户指令：${instruction}\n\n` +
          `要求：\n` +
          `- 只输出一个 \`\`\`markdown 围栏代码块，内容为「改写后的完整文本」（与原文同等粒度：给整篇就回整篇，给片段就回片段），不要任何解释\n` +
          `- 除指令要求外，不得改动其他内容；保持公式定界符、图表引用、标题层级完整\n` +
          `- 数学公式一律用 $…$ / $$…$$，不要用 \\( \\)\n\n` +
          `--- 原文开始 ---\n${source.slice(0, 60000)}\n--- 原文结束 ---`;
        try {
          const { sessionId, controlId, assistantText } = await runTempPrompt({
            title: "MD 编辑 · AI 改稿",
            prompt,
            paperId: state.currentPaper?.id || null,
            projectId: state.projectId || null,
            onStatus: setStatus,
          });
          await removeTempSession(sessionId, controlId);
          const text = extractMarkdown(assistantText);
          if (!text) throw new Error("AI 没有返回内容");
          aiPending = { target, text };
          renderDiff(target === "doc" ? full : full.slice(target.start, target.end), text);
          setStatus("");
        } catch (e) {
          setStatus("");
          toast("AI 改稿失败: " + (e.message || e), true);
        }
        aiRun.disabled = false;
      }

      function renderDiff(oldText, newText) {
        diffBox.replaceChildren(...diffRows(oldText, newText).map((row) =>
          el("div", { class: "mde-diff-row " + row.type },
            el("span", { class: "mde-diff-glyph" }, row.type === "add" ? "+" : row.type === "del" ? "−" : " "),
            el("span", { class: "mde-diff-text" }, row.text || " "))));
        aiPanel.hidden = false;
      }

      function applyAi() {
        if (!aiPending) return;
        const { target, text } = aiPending;
        if (target === "doc") editor.value = text;
        else {
          editor.setRangeText(text, target.start, target.end, "end");
          editor.setSelectionRange(target.start, target.start + text.length);
        }
        aiPending = null;
        aiPanel.hidden = true;
        dirty = true;
        statusEl.textContent = (currentPath || "") + " ●（AI 修改已写入，记得保存）";
        schedulePreview();
        editor.focus();
      }

      // ---- 文件列表 / 打开 / 保存 / 新建 ----
      async function refreshFiles(preferPath) {
        fileSel.replaceChildren(el("option", { value: "" }, "— 选择文件 —"));
        try {
          const data = await api.notes();
          for (const cat of data.categories) {
            const opts = cat.papers.flatMap((paper) => paper.files.map((f) => ({ paper, f })));
            if (!opts.length) continue;
            const group = el("optgroup", { label: cat.category });
            for (const { paper, f } of opts) {
              group.append(el("option", { value: f.path }, `${paper.title} / ${f.name}`));
            }
            fileSel.append(group);
          }
          if (preferPath) fileSel.value = preferPath;
        } catch (e) {
          setStatus("知识库列表加载失败: " + e.message);
        }
      }

      async function openPath(rel) {
        try {
          const r = await api.file("knowledge/" + rel);
          editor.value = r.content || "";
          currentPath = rel; dirty = false;
          statusEl.textContent = fileLabel(rel) + " · " + editor.value.split("\n").length + " 行";
          fileSel.value = rel;
          schedulePreview();
          editor.focus();
        } catch (e) { toast("打开失败: " + e.message, true); }
      }

      fileSel.addEventListener("change", () => {
        const v = fileSel.value;
        if (v) openPath(v);
      });

      async function save() {
        if (!currentPath) return toast("先选择文件", true);
        try {
          await api.notesWriteFile(currentPath, editor.value);
          dirty = false;
          statusEl.textContent = fileLabel(currentPath) + " · 已保存 ✓";
          toast("已保存到知识库");
        } catch (e) { toast("保存失败: " + e.message, true); }
      }

      async function createNote() {
        const paper = state.currentPaper;
        if (!paper?.id) return toast("先在文献库选择一篇论文", true);
        const name = (await askText({ title: "新建精读笔记", message: `为《${String(paper.title).slice(0, 40)}》新建笔记文件名：`, placeholder: "例如：精读笔记-方法篇.md", initial: "精读笔记.md", okText: "创建" }))?.trim();
        if (!name) return;
        const fileName = /\.md$/i.test(name) ? name : name + ".md";
        try {
          const meta = await api.notesEnsure({ paperId: paper.id, title: paper.title, category: "精读" });
          const rel = `精读/${meta.slug}/${fileName}`;
          await api.notesWriteFile(rel, `# ${paper.title}\n\n`);
          await refreshFiles(rel);
          await openPath(rel);
          toast("已创建 " + rel);
        } catch (e) { toast("创建失败: " + e.message, true); }
      }

      // 默认打开当前论文的精读笔记（若有）
      (async () => {
        const paper = state.currentPaper;
        let prefer = "";
        if (paper?.id) {
          try {
            const { slug } = await api.notesResolve(paper.id, paper.title || "");
            const data = await api.notes();
            const fine = data.categories.find((c) => c.category === "精读")?.papers.find((x) => x.slug === slug);
            prefer = fine?.files?.[0]?.path || "";
          } catch {}
        }
        await refreshFiles(prefer);
        if (prefer) openPath(prefer);
      })();

      const root = el("div", { class: "mde" }, toolbar, aiBar, main, aiPanel);
      body.append(root);
      window.dispatchEvent(new Event("resize"));
    },
    unmount() {
      alive = false;
    },
  });
}
