import { node, request, button, dialog, notify } from "../platform/ui.js";

export async function openStudyCreate({ paperId, projectId } = {}) {
  const [library, tasks] = await Promise.all([request("/api/papers"), request("/api/studies")]);
  const source = node("select", { "aria-label": "论文来源" }, node("option", { value: "library" }, "从文献库选择"), node("option", { value: "upload" }, "上传外部 PDF"));
  const paper = node("select", { "aria-label": "选择论文", required: true }, node("option", { value: "" }, "请选择一篇论文"), library.papers.filter(p => p.pdfPath).map(p => node("option", { value: p.id }, p.title)));
  if (paperId) paper.value = paperId;
  if (!library.papers.length) source.value = "upload";
  const file = node("input", { type: "file", accept: ".pdf,application/pdf", "aria-label": "上传一个 PDF" });
  const goal = node("textarea", { rows: 3, maxlength: 4000, placeholder: "例如：弄清模型如何解决分布偏移，并设计一个可验证的改进", "aria-label": "本次阅读目标" });
  const goalType = node("select", { "aria-label": "目标类型" }, node("option", { value: "understand" }, "理解论文"), node("option", { value: "reproduce" }, "复现方法"), node("option", { value: "innovate" }, "寻找创新"));
  const status = node("p", { class: "study-muted", role: "status" });
  const recent = node("div", { class: "study-recent" }, tasks.studies.slice(0, 6).map(t => node("a", { href: `/study/${t.id}` }, node("strong", {}, t.title), node("small", {}, t.goal))));
  const content = node("div", { class: "study-form" }, node("label", {}, "论文 · 必选", source, paper, file), node("label", {}, "本次目标", goalType, goal), status,
    tasks.studies.length ? node("details", {}, node("summary", {}, "继续已有研读"), recent) : null);
  const update = () => { paper.hidden = source.value !== "library"; file.hidden = source.value !== "upload"; };
  source.addEventListener("change", update); update();
  let saving = false;
  const start = button("开始研读 →", async () => {
    if (saving) return;
    if (source.value === "library" && !paper.value) throw new Error("请选择论文");
    if (source.value === "upload" && !file.files[0]) throw new Error("请选择一个 PDF 文件");
    saving = true; status.textContent = "正在保存论文并创建两侧会话…";
    try {
      const options = { goal: goal.value, goalType: goalType.value, projectId: projectId || null };
      let task;
      if (source.value === "upload") {
        if (file.files[0].size > 100 * 1024 * 1024) throw new Error("PDF 最大 100 MB");
        const response = await fetch("/api/studies/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.files[0].name), "X-Study-Options": encodeURIComponent(JSON.stringify(options)) }, body: file.files[0] });
        task = await response.json(); if (!response.ok) throw new Error(task.error);
      } else task = await request("/api/studies", { method: "POST", body: { ...options, paperId: paper.value } });
      location.assign(`/study/${task.id}`);
    } finally { saving = false; status.textContent = ""; }
  }, "tool-btn primary");
  const dlg = dialog("开始一次论文研读", content, [start]);
  dlg.addEventListener("cancel", event => { if (saving) { event.preventDefault(); notify("正在创建，请稍候"); } });
}
