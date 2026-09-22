import { node, request, markdown, button, dialog, notify, confirmDelete } from "./ui.js";
import { openStudyCreate } from "./create.js";
import { createStudyChat } from "./chat.js";
import { createStudyReader } from "./reader.js";
import { createActivityView } from "./activity.js";

const id = location.pathname.split("/").filter(Boolean)[1];
// The reader restores a page and an offset after PDF geometry is ready.
// Native pixel restoration can otherwise overwrite it after a width change.
history.scrollRestoration = "manual";
let task, guide, chat, reader, busy = false, savingUI, uiPatch = {}, currentVersion, reviewId;
const root = document.getElementById("study-root");
const theme = localStorage.getItem("pipaper.theme"); if (theme) document.documentElement.dataset.theme = theme;
document.documentElement.dataset.fs = localStorage.getItem("pipaper.fontSize") || "cozy";
const guideBody = node("div", { class: "study-guide-body" }), progress = node("span", { class: "study-run-status", role: "status" });
const guideDraft = node("textarea", { rows: 3, placeholder: "告诉引导你哪里没理解，或提出实验想法…", "aria-label": "研读引导输入", oninput: () => saveUI({ guideDraft: guideDraft.value }) });
const stageNav = node("nav", { class: "study-stage-nav", "aria-label": "研读阶段" });
const editPlan = button("修改实验计划", () => run("plan", { checkpointId: cpNow()?.id, text: guideDraft.value }));
const menu = node("details", { class: "study-task-picker" }), title = node("span", { class: "study-task-title" });
const menuItems = node("div", { class: "study-task-items" });
const search = node("input", { type: "search", placeholder: "搜索论文、目标…", "aria-label": "搜索研读任务" });
let taskRows = [];
const activityViews = new Map();

function saveUI(patch) {
  if (!task || ["deleting", "delete-failed"].includes(task.status)) return;
  task.ui = { ...task.ui, ...patch }; Object.assign(uiPatch, patch);
  clearTimeout(savingUI); savingUI = setTimeout(flushUI, 300);
}
async function flushUI() {
  clearTimeout(savingUI);
  const body = uiPatch; uiPatch = {};
  if (!Object.keys(body).length) return;
  try { await request(`/api/studies/${id}/ui`, { method: "PATCH", body, keepalive: true }); }
  catch (e) { notify("草稿保存失败：" + e.message, true); }
}
async function refresh() {
  const result = await request(`/api/studies/${id}`); task = result.task; task.ui = { ...task.ui, ...uiPatch };
  title.textContent = task.title; document.title = `${task.title} · 论文研读`;
  if (task.versionId !== currentVersion && reader) { currentVersion = task.versionId; await reader.load(); }
  renderGuide();
}
async function run(action, body = {}) {
  if (busy) throw new Error("请等待当前引导操作结束，或点击停止");
  if (!guide?.state.controlId) throw new Error("引导会话尚未连接，请点击重连");
  busy = true; progress.textContent = "处理中…"; renderGuide();
  try {
    await flushUI();
    await reader?.flushNotes();
    const operation = await request(`/api/studies/${id}/${action}`, { method: "POST", headers: { "X-Pi-Control": guide.state.controlId }, body });
    await guide.wait(operation.operationId);
    await refresh();
  } finally { busy = false; progress.textContent = ""; await refresh().catch(() => {}); }
}
async function removeTask(target) {
  if (!await confirmDelete("删除研读任务", `彻底删除「${target.title}」的对话、进度和独占暂存资料。已经注入知识库的成果会保留。`)) return;
  if (target.id === id) { await flushUI(); guide?.close(); chat?.close(); }
  try {
    await request(`/api/studies/${target.id}`, { method: "DELETE" });
    if (target.id === id) location.assign("/"); else await loadMenu();
  } catch (e) {
    if (target.id === id) { await refresh(); progress.textContent = "删除未完成，请重试"; }
    throw e;
  }
}
function renderMenu() {
  const query = search.value.toLowerCase(); menuItems.replaceChildren();
  for (const t of taskRows.filter(t => (t.title + t.goal).toLowerCase().includes(query))) {
    const link = node("a", { href: `/study/${t.id}`, class: "study-task-link" }, node("strong", {}, t.title), node("small", {}, t.goal), node("span", { class: "study-task-meta" }, `${({ rough: "粗读", deep: "精读", summary: "总结" })[t.stage]} · ${t.status === "completed" ? "已完成" : `${t.progress}/${t.total || "待解析"}`} · ${new Date(t.updatedAt).toLocaleDateString()}${t.exported ? " · 已入库" : ""}`));
    const exportButton = button("入库", async () => { if (t.id !== id) { location.assign(`/study/${t.id}?export=1`); return; } await run("export"); notify("论文及已完成成果已保存到知识库"); await loadMenu(); });
    menuItems.append(node("div", { class: "study-task-row" + (t.id === id ? " current" : "") }, link, node("div", { class: "study-task-row-actions" }, exportButton, button("删除", () => removeTask(t), "tool-btn danger"))));
  }
  if (!menuItems.children.length) menuItems.append(node("p", { class: "study-muted" }, "没有匹配的研读任务"));
}
async function loadMenu() { taskRows = (await request("/api/studies")).studies; renderMenu(); }
search.addEventListener("input", renderMenu);
function cpNow() { return task.checkpoints[task.cursor]; }
function renderGuide() {
  if (!task) return;
  editPlan.hidden = cpNow()?.kind !== "summary" || !cpNow()?.lesson || task.status !== "active";
  editPlan.disabled = busy;
  stageNav.replaceChildren(...[["rough", "01 粗读"], ["deep", "02 精读"], ["summary", "03 总结"]].map(([stage, label]) => {
    const indexes = task.checkpoints.map((cp, i) => cp.stage === stage ? i : -1).filter(i => i >= 0);
    const enabled = indexes.some(i => i <= task.cursor);
    const tab = button(label, () => { reviewId = task.checkpoints[indexes.find(i => i <= task.cursor)]?.id; renderGuide(); });
    tab.disabled = !enabled; tab.classList.toggle("active", (task.checkpoints.find(c => c.id === reviewId) || cpNow())?.stage === stage); return tab;
  }));
  const previousScroll = guideBody.scrollTop;
  guideBody.replaceChildren(node("div", { class: "study-goal" }, node("small", {}, ({ understand: "理解论文", reproduce: "复现方法", innovate: "寻找创新" })[task.goalType]), node("p", {}, task.goal)));
  if (["deleting", "delete-failed"].includes(task.status)) {
    guideBody.append(node("p", { class: "study-error" }, "删除未完成：" + (task.errors || []).join("；")), button("重试彻底删除", () => removeTask(task))); return;
  }
  if (!task.versionId) {
    guideBody.append(node("div", { class: "study-welcome" }, node("span", {}, "01"), node("h2", {}, "从论文主线开始"), node("p", {}, "先准备原文，再一起厘清问题、方法与证据。每一步都可以追问，理解后再继续。"), button(busy ? "正在解析…" : "解析论文并开始", () => run("prepare"), "tool-btn primary")));
    if (task.lastError) guideBody.append(node("p", { class: "study-error" }, task.lastError)); return;
  }
  const activeCheckpoint = cpNow();
  const cp = task.checkpoints.find(c => c.id === reviewId) || activeCheckpoint;
  for (const activity of task.activities || []) {
    if (activity.checkpointId && activity.checkpointId !== cp?.id) continue;
    if (activity.versionId && activity.versionId !== task.versionId) continue;
    if (!activity.steps?.length && activity.status === "completed") continue;
    let view = activityViews.get(activity.id);
    if (!view) { view = createActivityView(activity); activityViews.set(activity.id, view); }
    else view.update(activity);
    guideBody.append(view.root);
  }
  if (task.cursor > 0 || reviewId) {
    const picker = node("select", { "aria-label": "查看已解锁章节" }, task.checkpoints.slice(0, task.cursor + 1).map(c => node("option", { value: c.id }, `${c.status === "passed" ? "✓ " : ""}${c.label}`)));
    picker.value = cp.id; picker.addEventListener("change", () => { reviewId = picker.value; renderGuide(); }); guideBody.append(picker);
  }
  guideBody.append(node("div", { class: "study-checkpoint-title" }, node("h2", {}, cp.label), node("span", { class: "study-badge" }, cp.status === "passed" ? "理解考查通过" : cp.lesson ? "等待作答" : "待讲解")));
  if (!cp.lesson) {
    guideBody.append(node("p", { class: "study-muted" }, `本节阅读 ${cp.blockIds.length} 个原文块。先讲解，再通过问题确认理解。`), button("开始本节讲解", () => run("lesson", { checkpointId: cp.id }), "tool-btn primary"));
  } else {
    for (const m of task.messages.filter(m => m.checkpointId === cp.id && !m.historical)) guideBody.append(node("article", { class: "study-guide-message " + m.role }, node("small", {}, m.role === "user" ? "你的回答与想法" : "研读引导"), markdown(m.text)));
    if (cp.kind === "rough") {
      const matches = cp.lesson.matches || [];
      guideBody.append(node("details", {}, node("summary", {}, "本地知识库匹配依据"), matches.length ? matches.map(match => {
        const evidence = cp.localEvidence.find(e => e.id === match.id);
        return node("article", {}, node("strong", {}, evidence?.title || match.id), node("p", {}, `${match.relevant ? "相关" : "不匹配"}：${match.reason}`), evidence ? node("small", {}, evidence.source) : null);
      }) : node("p", {}, "没有找到本地匹配证据，本次建议依据论文与阅读目标形成。")));
    }
    if (cp.research) guideBody.append(node("section", { class: "study-research" }, node("h3", {}, "针对缺口找到的相关论文"), cp.research.results.map(p => node("article", {}, node("strong", {}, p.title), node("span", {}, ` ${p.year || ""} `), p.doi ? node("small", {}, `DOI: ${p.doi} `) : null, p.url ? node("a", { href: p.url, target: "_blank", rel: "noopener" }, "论文页面 ↗") : null, p.pdfUrl ? node("a", { href: p.pdfUrl, target: "_blank", rel: "noopener" }, "下载全文 ↗") : node("small", {}, " 暂无开放全文"))), !cp.research.results.length ? node("p", {}, "没有检索到可验证的相关论文") : null,
      cp.research.errors.length ? node("p", { class: "study-error" }, cp.research.errors.join("；")) : null, button("重新检索", () => run("research", { checkpointId: cp.id }))));
    if (cp.kind === "method") {
      guideBody.append(node("h3", {}, "用图串起方法"), node("div", { class: "study-actions" }, button("生成架构图", () => run("image/generate", { checkpointId: cp.id, kind: "architecture" })), button("生成训练／验证／测试图", () => run("image/generate", { checkpointId: cp.id, kind: "pipeline" })), button("配置生图", openImageSettings)));
      for (const artifact of task.artifacts.filter(a => a.checkpointId === cp.id && !a.historical)) guideBody.append(node("figure", { class: "study-generated" }, node("img", { src: `/api/studies/${id}/${artifact.file}`, alt: artifact.label }), node("figcaption", {}, artifact.label, node("a", { href: `/api/studies/${id}/${artifact.file}`, download: true }, " 下载图片")), node("details", {}, node("summary", {}, "图示说明与来源"), markdown(artifact.prompt))));
    }
    if (cp.lesson.experiments) guideBody.append(node("section", { class: "study-plans" }, node("h3", {}, "待确认的实验计划"), cp.lesson.experiments.map(e => node("article", {}, node("h4", {}, ({ reproduction: "复现", ablation: "消融", destruction: "破坏性实验", innovation: "baseline 改进" })[e.kind] || e.kind), Object.entries({ hypothesis: "假设", variables: "变量", control: "对照", metrics: "指标", expected: "预期", failure: "失败判据" }).map(([key, label]) => node("p", {}, node("strong", {}, label + "："), e[key]))))));
    if (cp.id === activeCheckpoint.id && task.status === "active") renderQuestions(cp);
    if (cp.lesson.recommendation && cp.status === "passed") guideBody.append(node("div", { class: "study-recommendation" }, node("h3", {}, cp.lesson.recommendation.worthDeep ? "建议继续精读" : "建议先停留在粗读"), markdown(cp.lesson.recommendation.reason), node("small", {}, "你可以根据自己的目标决定是否继续精读。")));
  }
  if (cp.status === "passed" && cp.id === activeCheckpoint.id && task.status === "active") {
    guideBody.append(node("div", { class: "study-next" }, button(cp.kind === "summary" ? "确认实验计划，完成研读" : "继续下一步 →", async () => { reviewId = null; await run("advance", { checkpointId: cp.id, confirmPlan: cp.kind === "summary" }); }, "tool-btn primary"), cp.kind === "rough" ? button("粗读到此结束", () => run("advance", { checkpointId: cp.id, stopAfterRough: true })) : null));
  }
  if (task.status === "completed" || task.status === "rough-completed") guideBody.append(node("div", { class: "study-completed" }, node("h3", {}, task.status === "completed" ? "本次研读已完成" : "本次粗读已完成"), button("将完整成果注入知识库", async () => { await run("export"); notify("已保存完整成果快照"); }, "tool-btn primary")));
  if (task.lastError && !busy) guideBody.append(node("p", { class: "study-error", role: "alert" }, task.lastError));
  if (busy) guideBody.querySelectorAll("button").forEach(b => b.disabled = true);
  guideBody.scrollTop = previousScroll;
}
function renderQuestions(cp) {
  const section = node("section", { class: "study-quiz" }, node("h3", {}, "检验你的理解"));
  const last = cp.attempts.at(-1);
  for (const q of cp.lesson.questions) {
    const answer = node("textarea", { rows: 3, "aria-label": q.question, value: task.ui.answers?.[q.id] || last?.answers?.[q.id] || "", disabled: cp.status === "passed", placeholder: "用自己的话解释…" });
    answer.addEventListener("input", () => saveUI({ answers: { ...task.ui.answers, [q.id]: answer.value } }));
    section.append(node("label", {}, q.question, answer));
    const feedback = last?.evaluations.find(e => e.questionId === q.id);
    if (feedback) section.append(node("p", { class: feedback.criteria.every(Boolean) ? "study-success" : "study-warning" }, feedback.feedback));
  }
  if (cp.status !== "passed") section.append(button("提交理解检查", () => run("answers", { checkpointId: cp.id, answers: task.ui.answers || {} }), "tool-btn primary"));
  guideBody.append(section);
}
async function openImageSettings() {
  const status = await request(`/api/studies/${id}/image/status`);
  const provider = node("input", { value: status.provider, placeholder: "如 gemini-api / dashscope-api / codex-subscription", "aria-label": "生图路由" });
  const model = node("input", { value: status.model, placeholder: "生图模型或扩展别名", "aria-label": "生图模型" });
  const content = node("div", { class: "study-form" }, node("p", {}, `扩展：${status.loaded ? "已安装并加载" : status.installed ? "已安装，尚未加载" : "尚未安装"}；模型：${status.configured ? status.model : "尚未配置"}`), node("p", {}, status.credential), node("label", {}, "服务路由", provider), node("label", {}, "模型", model), node("p", { class: "study-muted" }, "凭证复用 Pi 生图扩展配置或对应环境变量；安装后不会自动发起付费生成。"), node("a", { href: status.docs, target: "_blank", rel: "noopener" }, "查看 Pi 扩展安装、模型与凭证说明 ↗"));
  if (cpNow()?.kind === "method" && cpNow().lesson) content.append(button("生成架构图，验证配置", async () => { await run("image/generate", { checkpointId: cpNow().id, kind: "architecture" }); dlg.close(); }));
  const dlg = dialog("Pi 生图扩展", content, [button("安装扩展", async () => { await run("image/install"); notify("安装完成，请配置生图模型与凭证"); dlg.close(); }), button("重新加载", async () => { await run("image/reload"); dlg.close(); }), button("保存配置", async () => { await run("image/config", { provider: provider.value.trim(), model: model.value.trim() }); dlg.close(); }, "tool-btn primary")]);
}
function panel(key, label, subtitle) {
  return node("section", { class: "study-panel", "data-panel": key }, node("header", { class: "study-panel-head" }, node("div", {}, node("strong", {}, label), node("small", {}, subtitle)), button("收起", () => {
    const collapsed = new Set(task.ui.collapsed || []); collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    if (collapsed.size === 3) collapsed.delete(key); saveUI({ collapsed: [...collapsed] }); applyLayout();
  })));
}
function applyLayout() {
  for (const pane of root.querySelectorAll(".study-panel")) {
    const collapsed = (task.ui.collapsed || []).includes(pane.dataset.panel);
    pane.classList.toggle("collapsed", collapsed);
    pane.querySelector(".study-panel-head button").textContent = collapsed ? "展开" : "收起";
  }
  root.dataset.mobilePanel = task.ui.mobilePanel || "guide";
  const widths = task.ui.widths || [40, 32, 28];
  root.querySelectorAll(".study-panel").forEach((pane, i) => pane.style.flexGrow = widths[i]);
}
function gutter(index) {
  const el = node("div", { class: "study-gutter", role: "separator", tabindex: 0, "aria-label": "调整分栏宽度", "aria-orientation": "vertical" });
  const adjust = delta => { const widths = [...(task.ui.widths || [40, 32, 28])]; const pair = widths[index] + widths[index + 1]; widths[index] = Math.max(15, Math.min(pair - 15, widths[index] + delta)); widths[index + 1] = pair - widths[index]; saveUI({ widths }); applyLayout(); };
  el.addEventListener("pointerdown", event => { const start = event.clientX; let previous = start; el.setPointerCapture(event.pointerId); const move = e => { adjust((e.clientX - previous) / root.clientWidth * 100); previous = e.clientX; }; const up = () => { el.removeEventListener("pointermove", move); }; el.addEventListener("pointermove", move); el.addEventListener("pointerup", up, { once: true }); });
  el.addEventListener("keydown", e => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); adjust(e.key === "ArrowLeft" ? -2 : 2); } }); return el;
}
async function boot() {
  const result = await request(`/api/studies/${id}`); task = result.task; currentVersion = task.versionId;
  menu.append(node("summary", {}, node("small", {}, "论文研读"), title, node("span", {}, "⌄")), node("div", { class: "study-task-menu" }, search, menuItems, button("＋ 新建研读", () => openStudyCreate({ projectId: task.projectId }))));
  title.textContent = task.title;
  const heading = node("header", { class: "study-header" }, node("a", { href: "/", class: "study-home" }, "π", node("span", {}, "工作台")), menu,
    node("div", { class: "study-header-actions" }, button("＋ 读论文", () => openStudyCreate({ projectId: task.projectId })), button("注入知识库", async () => { await run("export"); notify("论文与完整成果快照已入库"); await loadMenu(); }), button("生图设置", openImageSettings), button("解析版本", async () => {
      const versions = await request(`/api/papers/${task.paperId}/versions`);
      const picker = node("select", {}, versions.versions.map(v => node("option", { value: v.id }, `${v.id} · ${v.engine}`))); picker.value = task.versionId;
      const dlg = dialog("切换研读解析版本", node("div", { class: "study-form" }, node("p", {}, "切换后重新核对阅读内容，阶段检查点与译文会重置；已有对话与图示保留为历史记录。"), picker), [button("切换并重新研读", async () => { reviewId = null; await run("version", { versionId: picker.value, confirmReset: true }); dlg.close(); })]);
    })));
  const mobile = node("nav", { class: "study-mobile-tabs" }, [["paper", "论文"], ["guide", "引导"], ["chat", "问答"]].map(([key, label]) => button(label, () => { saveUI({ mobilePanel: key, collapsed: (task.ui.collapsed || []).filter(k => k !== key) }); applyLayout(); })));
  const left = panel("paper", "论文原文", "保留出处 · 对照阅读"), middle = panel("guide", "研读引导", "理解主线，再深入方法"), right = panel("chat", "自由提问", "与你的阅读进度同步");
  const guideToolbar = node("div");
  guideDraft.value = task.ui.guideDraft || "";
  middle.append(stageNav, guideToolbar, progress, guideBody, node("div", { class: "study-composer" }, guideDraft, node("div", { class: "study-actions" }, button("停止", () => guide.call("abort")), editPlan, button("向引导提问 ↗", async () => { const text = guideDraft.value; await run("messages", { checkpointId: cpNow()?.id, text }); guideDraft.value = ""; saveUI({ guideDraft: "" }); }, "tool-btn primary"))));
  root.replaceChildren(heading, mobile, node("main", { class: "study-columns" }, left, gutter(0), middle, gutter(1), right));
  const onEvent = event => {
    if (event.t === "study_activity") {
      task.activities = [...(task.activities || []).filter(a => a.id !== event.activity.id), event.activity];
      const view = activityViews.get(event.activity.id);
      if (view) view.update(event.activity); else renderGuide();
    }
    if (event.t === "study_progress") progress.textContent = event.text;
    if (event.t === "study_delta") progress.textContent = "引导正在回答… " + event.delta.slice(-55);
    if (event.t === "study_updated") { task = event.task; task.ui = { ...task.ui, ...uiPatch }; renderGuide(); }
    if (event.t === "study_translation") { task.translations[event.blockId] = event.translation; reader?.updateTranslation(event.blockId, event.translation); }
    if (event.t === "session_replaced") refresh().catch(e => notify(e.message, true));
  };
  guide = createStudyChat({ root: guideToolbar, sessionId: task.guideSessionId, guide: true, onEvent });
  chat = createStudyChat({ root: right, sessionId: task.chatSessionId, paperId: task.paperId, draft: task.ui.chatDraft || "", onDraft: chatDraft => saveUI({ chatDraft }) });
  reader = createStudyReader({ root: left, getTask: () => task, onUI: saveUI, run, stop: () => guide.call("abort"), onQuote: (destination, text) => {
    if (destination === "guide") { guideDraft.value = [guideDraft.value, text].filter(Boolean).join("\n\n"); saveUI({ guideDraft: guideDraft.value }); guideDraft.focus(); }
    else chat.setDraft([chat.getDraft(), text].filter(Boolean).join("\n\n"));
    saveUI({ mobilePanel: destination }); applyLayout();
    notify(destination === "guide" ? "原文已加入引导输入框" : "原文已加入自由提问");
  } });
  root.addEventListener("click", event => { const link = event.target.closest('a[href^="#block:"]'); if (link) { event.preventDefault(); saveUI({ mobilePanel: "paper", collapsed: (task.ui.collapsed || []).filter(k => k !== "paper") }); applyLayout(); reader.focusBlock(decodeURIComponent(link.getAttribute("href").slice(7))); } });
  applyLayout(); renderGuide(); await loadMenu();
  if (["deleting", "delete-failed"].includes(task.status)) return;
  const connections = await Promise.allSettled([guide.connect(), chat.connect(), reader.load()]);
  for (const connection of connections) if (connection.status === "rejected") notify(connection.reason.message, true);
  if (new URLSearchParams(location.search).has("export") && guide.state.controlId) { await run("export"); notify("完整成果快照已入库"); history.replaceState(null, "", location.pathname); }
}
window.addEventListener("pagehide", () => { reader?.close(); flushUI(); guide?.close(); chat?.close(); });
boot().catch(e => { root.replaceChildren(node("div", { class: "study-empty" }, node("h2", {}, "暂时无法打开研读"), node("p", {}, e.message), node("a", { href: "/" }, "返回工作台"), button("重试", () => location.reload()))); });
