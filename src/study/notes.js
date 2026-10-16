import { persistence } from "../persistence.js";
import { node, markdown, button, request, dialog, notify } from "../platform/ui.js";

export function createStudyNotes({ getTask }) {
  const key = `pipaper.study.notes.${getTask().id}`;
  let saved = getTask().notes || { markdown: "", revision: 0 }, timer, chain = Promise.resolve(), previewing = false;
  let draft; try { draft = JSON.parse(persistence.getItem(key)); } catch {}
  const editor = node("textarea", { class: "study-note-editor", "aria-label": "Markdown 阅读笔记", placeholder: "# 阅读笔记\n\n记录你的理解、疑问和实验想法。\n在结构化视图选择文字、图片或表格，可直接添加到这里。", value: draft?.markdown ?? saved.markdown });
  const preview = node("div", { class: "study-note-preview", hidden: true });
  const status = node("span", { class: "study-muted", role: "status" }, draft ? "已恢复本地草稿" : "已保存");
  if (draft) saved = { ...saved, revision: draft.revision };
  const remember = () => persistence.setItem(key, JSON.stringify({ markdown: editor.value, revision: saved.revision }));
  const adopt = value => { saved = value; getTask().notes = value; };
  function enqueue(fn) { const next = chain.catch(() => {}).then(fn); chain = next; return next; }
  async function saveNow(keepalive = false) {
    clearTimeout(timer);
    if (editor.value === saved.markdown) return;
    const value = editor.value; status.textContent = "保存中…"; remember();
    try {
      const result = await request(`/api/studies/${getTask().id}/notes`, { method: "PATCH", body: { markdown: value, revision: saved.revision }, keepalive });
      adopt(result);
      if (editor.value === value) { persistence.removeItem(key); status.textContent = "已自动保存"; }
      else { remember(); status.textContent = "有未保存修改"; }
    } catch (error) { status.textContent = error.message; throw error; }
  }
  const flush = () => enqueue(() => saveNow());
  editor.addEventListener("input", () => { remember(); status.textContent = "有未保存修改"; clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 500); });
  const toggle = button("预览", () => {
    previewing = !previewing; editor.hidden = previewing; preview.hidden = !previewing;
    toggle.textContent = previewing ? "继续编辑" : "预览";
    if (previewing) markdown(editor.value, preview);
  });
  const download = button("下载 .md", () => {
    const url = URL.createObjectURL(new Blob([editor.value], { type: "text/markdown;charset=utf-8" }));
    const link = node("a", { href: url, download: "阅读笔记.md" }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const resolve = button("核对已保存版本", async () => {
    const latest = await request(`/api/studies/${getTask().id}/notes`);
    const remote = node("textarea", { rows: 8, readonly: true, "aria-label": "服务端笔记", value: latest.markdown });
    const merged = node("textarea", { rows: 10, "aria-label": "合并后的笔记", value: editor.value });
    const dlg = dialog("核对并合并笔记", node("div", { class: "study-form" }, node("label", {}, "服务端已保存内容", remote), node("label", {}, "合并结果（保留你需要的内容）", merged)), [button("保存合并结果", async () => {
      const result = await request(`/api/studies/${getTask().id}/notes`, { method: "PATCH", body: { markdown: merged.value, revision: latest.revision } });
      adopt(result); editor.value = result.markdown; persistence.removeItem(key); status.textContent = "合并已保存"; dlg.close();
    })]);
  });
  const root = node("section", { class: "study-notes", hidden: true }, node("div", { class: "study-note-toolbar" }, toggle, download, button("保存", flush), resolve), status, editor, preview);
  return { root, flush,
    async append(input) {
      await enqueue(async () => {
        await saveNow();
        const before = editor.value;
        const result = await request(`/api/studies/${getTask().id}/notes/append`, { method: "POST", body: { ...input, revision: saved.revision } });
        // If the user types while the request is in flight, keep those keystrokes.
        const suffix = result.markdown.slice(before.length);
        const changed = editor.value !== before;
        adopt(result); editor.value = changed ? editor.value + suffix : result.markdown;
        if (changed) { remember(); await saveNow(); } else persistence.removeItem(key);
        if (previewing) markdown(editor.value, preview);
        status.textContent = "已添加并保存"; notify("已添加到阅读笔记");
      });
    },
    close() { clearTimeout(timer); if (editor.value !== saved.markdown) { remember(); void enqueue(() => saveNow(editor.value.length < 15000)).catch(() => {}); } },
  };
}
