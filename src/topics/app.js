import { node, request, button, markdown, dialog, notify, confirmDelete } from "../platform/ui.js";
import { initPersistence } from "../persistence.js";
import { initSharedTheme } from "../themeTokens.js";
import { createAnalysis, manageProfiles, stageNames } from "./profiles.js";
import { directionCards, journalCards, link } from "./report.js";

const root = document.getElementById("topics-root");
const labels = { draft: "等待开始", running: "正在分析", completed: "报告已生成", insufficient: "证据尚待补齐", failed: "分析未完成", interrupted: "已停止", deleting: "正在删除", "delete-failed": "删除失败，可重试" };
let id, task, report, viewingReport, stream, refreshTimer, saveTimer, pendingUI = {}, operations = [], taskRows = [], tab = "directions", disposed = false;
let models = [], activeSearch, activeSearchId, renderedRevision = -1, reportKey = "", mobilePanel = "report";
let plan = null, planId = null, retrieval = null, retrievalId = null;
let casInfo = null;
const title = node("span", { class: "workspace-title" }, "选题分析"), status = node("span", { class: "workspace-status" }, "一次选题"), left = node("div", { class: "report-content pane-scroll" }), center = node("div", { class: "search-content pane-scroll" }), messages = node("div", { class: "topic-messages pane-scroll", "aria-live": "polite" });
const picker = node("select", { "aria-label": "切换选题任务", onchange: () => navigate(picker.value || null) }), modelSelect = node("select", { "aria-label": "选题分析与对话模型" });
const chatInput = node("textarea", { rows: 3, placeholder: "比较这几个方向，或讨论你的研究想法…", "aria-label": "选题方向对话输入" });
const qInput = node("input", { type: "search", placeholder: "具体问题的英文关键词…", "aria-label": "学术检索式" });
const engine = node("select", { "aria-label": "学术检索源" }, node("option", { value: "openalex" }, "OpenAlex"), node("option", { value: "crossref" }, "Crossref"), node("option", { value: "arxiv" }, "arXiv · 研究线索"));
const planningPanel = node("div", { class: "topic-planning" });
const progressPanel = node("div", { class: "topic-progress-panel", "aria-live": "polite" });
const searchResults = node("div", { class: "topic-search-results" }), timeline = node("div", { class: "topic-timeline" });
const STAGES = [["plan", "规划"], ["search", "检索"], ["quality", "核验"], ["policies", "政策"], ["reading", "精读"], ["directions", "方向"], ["journals", "期刊"], ["done", "完成"]];
const STAGE_TITLES = { plan: "规划检索", search: "检索论文", quality: "核验发表来源", policies: "读取政策证据", reading: "精读论文与资源", directions: "生成方向报告", journals: "补充期刊报告", done: "完成" };
function svgEl(tag, attrs = {}) { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }
function walkerFigure() {
  const svg = svgEl("svg", { viewBox: "0 0 22 30", width: "20", height: "27", "aria-hidden": "true" });
  svg.append(svgEl("ellipse", { class: "w-shadow", cx: "11", cy: "28.2", rx: "6.5", ry: "1.2" }), svgEl("circle", { class: "w-head", cx: "11", cy: "4", r: "2.9" }),
    svgEl("line", { class: "w-torso", x1: "11", y1: "7.6", x2: "11", y2: "16.5" }),
    svgEl("line", { class: "w-arm-a", x1: "11", y1: "9.5", x2: "5.8", y2: "14.2" }), svgEl("line", { class: "w-arm-b", x1: "11", y1: "9.5", x2: "16.2", y2: "14.2" }),
    svgEl("line", { class: "w-leg-a", x1: "11", y1: "16.5", x2: "6.8", y2: "26.4" }), svgEl("line", { class: "w-leg-b", x1: "11", y1: "16.5", x2: "15.2", y2: "26.4" }));
  return svg;
}
// 进度时间轴：小人在站间行走，当前阶段驻足原地迈步；检索/核验交替期站台前沿不回退。
const stageRail = (() => {
  const track = node("div", { class: "stage-track" }), fill = node("span", { class: "stage-fill" });
  const walker = node("span", { class: "stage-walker" }, walkerFigure());
  const stations = new Map(STAGES.map(([key, label], i) => {
    const s = node("span", { class: "stage-station", title: STAGE_TITLES[key], style: { left: `${i / (STAGES.length - 1) * 100}%` } }, node("i"), node("em", {}, label));
    s.classList.toggle("alt", i % 2 === 1);
    track.append(s); return [key, s];
  }));
  track.append(node("span", { class: "stage-ground" }), fill, walker);
  const elapsed = node("span", { class: "stage-elapsed" }), updated = node("span", { class: "stage-updated" });
  const root = node("div", { class: "stage-rail", hidden: true }, track, node("p", { class: "stage-meta" }, elapsed, updated));
  return { root, fill, walker, stations, elapsed, updated };
})();
function stageMetaTexts(running) {
  if (!task?.startedAt) return ["等待开始", ""];
  if (running) {
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(task.progress?.at || task.updatedAt)) / 1000));
    return [`已运行 ${Math.max(0, Math.floor((Date.now() - Date.parse(task.startedAt)) / 60000))} 分钟`, `最后更新 ${secs < 60 ? `${secs} 秒前` : `${Math.floor(secs / 60)} 分钟前`}`];
  }
  const mins = Math.max(1, Math.round((Date.parse(task.progress?.at || task.updatedAt) - Date.parse(task.startedAt)) / 60000));
  return [`共用时 ${mins} 分钟`, labels[task.status] || task.status];
}
function updateStageRail() {
  const rail = stageRail; rail.root.hidden = !task;
  if (!task) return;
  const running = task.status === "running";
  const reached = new Set((task.events || []).filter(e => !task.startedAt || e.at >= task.startedAt).map(e => e.stage)); if (task.stage) reached.add(task.stage);
  const idx = key => Math.max(0, STAGES.findIndex(([k]) => k === key));
  const furthest = task.startedAt ? [...reached].reduce((n, s) => Math.max(n, idx(s)), 0) : -1;
  const current = running ? Math.max(0, idx(task.stage)) : Math.max(0, furthest);
  const pct = i => `${i / (STAGES.length - 1) * 100}%`;
  rail.root.dataset.state = running ? "running" : task.status === "failed" || task.lastError ? "failed" : "settled";
  for (const [key, s] of rail.stations) {
    const i = idx(key);
    s.classList.toggle("done", i >= 0 && i <= furthest && !(running && i === current));
    s.classList.toggle("current", running && i === current);
  }
  rail.fill.style.width = pct(Math.max(0, furthest));
  rail.walker.style.left = pct(current);
  const [e, u] = stageMetaTexts(running); rail.elapsed.textContent = e; rail.updated.textContent = u;
}
setInterval(() => {
  if (!stageRail.root.isConnected || task?.status !== "running") return;
  const [e, u] = stageMetaTexts(true); stageRail.elapsed.textContent = e; stageRail.updated.textContent = u;
}, 1000);
function controlledButton(label, action) { return node("button", { type: "button", class: "tool-btn primary", onclick: async e => { e.currentTarget.disabled = true; try { await action(); } catch (error) { notify(error.message, true); } finally { syncControls(); } } }, label); }
const runButton = controlledButton("开始分析 ↗", startAnalysis), stopButton = button("停止", stop), sendButton = controlledButton("发送 ↗", sendChat);
const tabBar = node("nav", { class: "report-tabs", "aria-label": "报告分区" });
const connection = node("span", { class: "muted connection-state" }, "独立选题记忆");
// Reconcile persisted work even after a reconnect or an offline continuation.
setInterval(() => { if (id && task?.status === "running" && !document.hidden) void refresh().catch(() => {}); }, 12000);
const panel = (name, number, heading, content, extra) => node("section", { class: `topic-pane ${name}-pane`, "aria-label": heading }, node("header", { class: "pane-heading" }, node("span", { class: "pane-index" }, number), node("h2", {}, heading), extra), content);
const leftPane = panel("report", "01", "分析报告", [tabBar, progressPanel, left]);
const middlePane = panel("search", "02", "证据检索", center, button("＋ 来源", addEvidence, "icon-button"));
const rightPane = panel("chat", "03", "选题对话", [node("div", { class: "topic-model-bar" }, modelSelect, connection), messages, node("div", { class: "topic-composer" }, chatInput, node("div", { class: "topic-actions" }, button("清空对话", clearChat), node("span", { class: "muted" }, "Ctrl + Enter"), sendButton))]);
const workspace = node("main", { class: "topic-workspace" }, leftPane, divider(0), middlePane, divider(1), rightPane);
const header = node("header", { class: "topic-header" }, node("a", { href: "/", class: "topic-brand", title: "返回论文工作台" }, node("span", { class: "topic-logo" }, "π"), node("span", {}, "PiPaper")), node("span", { class: "header-divider" }), node("div", { class: "title-wrap" }, title, status),
  node("div", { class: "header-actions" }, picker, button("调查卡", () => manageProfiles()), button("＋ 新分析", () => createAnalysis(navigate)), runButton, stopButton,
    button("•••", taskMenu, "tool-btn task-more")));
const mobileTabs = node("nav", { class: "mobile-panel-tabs", "aria-label": "工作区栏目" }, [["report", "报告"], ["search", "检索"], ["chat", "对话"]].map(([key, label]) => button(label, () => { mobilePanel = key; workspace.dataset.panel = key; }, "tool-btn")));
root.replaceChildren(header, mobileTabs, workspace); workspace.dataset.panel = mobilePanel;

for (const [key, label] of [["directions", "方向结论"], ["journals", "期刊报告"], ["files", "资料与历史"]]) {
  const b = button(label, () => { tab = key; scheduleSave({ tab }); renderReport(true); }, "report-tab"); b.dataset.tab = key; tabBar.append(b);
}
function scheduleSave(patch) {
  if (!id || !task || ["deleting", "delete-failed"].includes(task.status)) return;
  Object.assign(pendingUI, patch); clearTimeout(saveTimer); saveTimer = setTimeout(() => flushUI().catch(e => notify(e.message, true)), 450);
}
async function flushUI() {
  clearTimeout(saveTimer); const body = pendingUI; pendingUI = {};
  if (id && Object.keys(body).length) await request(`/api/topics/${id}`, { method: "PATCH", body: { ui: body, chatEpoch: task?.chatEpoch || 0 }, keepalive: true });
}
chatInput.addEventListener("input", () => scheduleSave({ chatDraft: chatInput.value }));
qInput.addEventListener("input", () => scheduleSave({ searchQuery: qInput.value }));
chatInput.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); sendChat().catch(e => notify(e.message, true)); } });
modelSelect.addEventListener("change", async () => {
  if (!id) return; const [provider, modelId] = modelSelect.value.split("|");
  try { await request(`/api/topics/${id}`, { method: "PATCH", body: { model: modelId ? { provider, id: modelId } : null } }); }
  catch (e) { notify(e.message, true); modelSelect.value = task.model ? `${task.model.provider}|${task.model.id}` : ""; }
});
async function taskList() {
  const r = await request("/api/topics"); taskRows = r.tasks;
  picker.replaceChildren(node("option", { value: "" }, "全部分析 / 开始"), ...taskRows.map(t => node("option", { value: t.id }, `${t.title} · ${labels[t.status] || t.status}`))); picker.value = id || "";
}
async function navigate(next, push = true) {
  plan = null; planId = null; retrieval = null; retrievalId = null;
  await flushUI().catch(() => {}); stream?.close(); clearTimeout(refreshTimer); id = next; disposed = false; task = null; report = null; viewingReport = null; activeSearch = null; renderedRevision = -1; reportKey = ""; pendingUI = {};
  if (push) history.pushState({}, "", next ? `/topics/${next}` : "/topics");
  await taskList();
  if (!id) { title.textContent = "选题分析"; status.textContent = "一次选题"; tab = "directions"; renderProgress(); renderReport(true); renderSearch(); renderChat(); syncControls(); return; }
  left.replaceChildren(node("p", { class: "muted" }, "正在恢复报告和研究资料…"));
  try {
    await refresh(true); chatInput.value = task.ui.chatDraft || ""; qInput.value = task.ui.searchQuery || "";
    stream = new EventSource(`/api/topics/${id}/events`);
    stream.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === "deleted") { stream.close(); disposed = true; notify("该分析已删除"); void navigate(null); return; }
      if (data.type === "chat_delta") { const m = task.chat.find(m => m.id === data.id); if (m) { m.text = data.text; renderChat(); } }
      else { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(e => { connection.textContent = e.message; }), 160); }
    };
    stream.onopen = () => { connection.textContent = "已同步"; };
    stream.onerror = () => { connection.textContent = "连接中断，正在重连…"; };
  } catch (e) { left.replaceChildren(node("p", { class: "evidence-callout amber" }, e.message), button("返回分析列表", () => navigate(null))); syncControls(); }
}
window.addEventListener("popstate", () => { void navigate(location.pathname.split("/")[2] || null, false); });
window.addEventListener("pagehide", () => { void flushUI(); stream?.close(); });
async function refresh(initial = false) {
  if (!id || disposed) return; const current = id, r = await request(`/api/topics/${current}`); if (id !== current) return;
  if (task && (task.chatEpoch || 0) !== (r.task.chatEpoch || 0)) { chatInput.value = ""; delete pendingUI.chatDraft; }
  task = r.task; operations = r.operations;
  const planArtifact = task.artifacts.filter(a => a.kind === "plan").at(-1);
  const newestPlan = planArtifact?.id;
  if (newestPlan !== planId) { planId = newestPlan; plan = newestPlan ? (await request(`/api/topics/${current}/files/${newestPlan}`)).data : null; }
  const retrievalArtifact = task.artifacts.filter(a => a.kind === "retrieval").at(-1);
  const newestRetrieval = retrievalArtifact?.createdAt >= planArtifact?.createdAt ? retrievalArtifact?.id : null;
  if (newestRetrieval !== retrievalId) { retrievalId = newestRetrieval; retrieval = newestRetrieval ? (await request(`/api/topics/${current}/files/${newestRetrieval}`)).data : null; }
  if (id !== current) return;
  if (viewingReport && !task.artifacts.some(a => a.id === viewingReport)) viewingReport = null;
  if (activeSearchId && !task.artifacts.some(a => a.id === activeSearchId)) { activeSearch = null; activeSearchId = null; }
  const option = [...picker.options].find(o => o.value === current); if (option) option.textContent = `${task.title} · ${labels[task.status] || task.status}`;
  title.textContent = task.title; title.title = task.title; status.textContent = labels[task.status] || task.status; status.dataset.status = task.status; document.title = `${task.title} · 选题分析`;
  if (initial) { tab = ["directions", "journals", "files"].includes(task.ui.tab) ? task.ui.tab : "directions"; applyWidths(task.ui.widths); }
  const key = viewingReport || task.reportId;
  if (key !== reportKey) { const nextReport = key ? (await request(`/api/topics/${current}/files/${key}`)).data : null; if (id !== current) return; report = nextReport; reportKey = key || ""; renderReport(true); }
  else renderReport();
  if (report && (viewingReport || task.status !== "running")) { plan = report.plan || plan; retrieval = report.retrieval || retrieval; }
  renderProgress(); renderSearch(); renderChat(); syncControls();
}
function renderProgress() {
  progressPanel.replaceChildren();
  if (!task || viewingReport) return;
  const running = task.status === "running";
  if (!running && !task.lastError && report?.status !== "partial") return;
  const stages = { plan: "规划检索", search: "检索论文", quality: "核验发表来源", policies: "读取政策证据", reading: "精读论文与资源", directions: "生成方向报告", journals: "补充期刊报告" };
  const events = (task.events || []).filter(e => !task.startedAt || e.at >= task.startedAt);
  const latest = task.progress || events.at(-1);
  const elapsed = task.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(task.startedAt)) / 60000)) : null;
  const text = running ? `${stages[task.stage] || "正在分析"}${elapsed == null ? "" : ` · 已运行 ${elapsed} 分钟`}` : "本轮已结束，已保存的阶段报告可继续查看";
  const box = node("div", { class: "evidence-callout" }, node("strong", {}, text));
  if (running && latest) box.append(node("p", {}, latest.text));
  if (task.lastError) box.append(node("p", { class: "inline-error" }, task.lastError));
  if (report?.status === "partial") box.append(node("p", {}, running ? report.phase === "directions" ? "候选方向已生成，可先查看；正在补充资源证据与复核。" : "方向结论已生成，可先查看；期刊统计将逐项补充。" : "当前为阶段报告，后续分析尚未全部完成。"));
  const failures = [...new Map(events.filter(e => /暂不可用|连续.*失败|超时|证书|certificate/i.test(e.text)).map(e => [e.text, e])).values()].slice(-2);
  for (const e of failures) box.append(node("p", { class: "inline-error" }, `来源提示：${e.text}`));
  progressPanel.append(box);
}
function syncControls() {
  const has = !!task, busy = operations.length > 0, invalid = !has || !!task.cleanupError || ["deleting", "delete-failed"].includes(task.status);
  runButton.disabled = invalid || task?.status === "running" || operations.some(o => o.kind === "analysis"); runButton.textContent = task?.status === "running" ? "分析进行中…" : task?.reportId ? "重新分析 ↗" : "开始分析 ↗";
  stopButton.hidden = !busy; stopButton.disabled = !has; sendButton.disabled = invalid || task.chatBusy; chatInput.disabled = invalid; modelSelect.disabled = !has || busy;
  modelSelect.value = task?.model ? `${task.model.provider}|${task.model.id}` : "";
}
function welcome() {
  return node("div", { class: "topic-welcome" }, node("p", { class: "eyebrow" }, "A GOOD PAPER STARTS WITH A GOOD QUESTION"), node("h1", {}, "从宽泛的兴趣，", node("br"), "走向一个好问题。"),
    node("p", { class: "welcome-intro" }, "把研究条件、真实文献与待解决的问题放在一起。为第一篇论文，找到值得投入的方向。"),
    node("div", { class: "welcome-orbit", "aria-hidden": "true" }, node("span", { class: "orbit-ring one" }), node("span", { class: "orbit-ring two" }), node("span", { class: "orbit-center" }, "?"), node("span", { class: "orbit-label label-one" }, "真实证据"), node("span", { class: "orbit-label label-two" }, "研究条件"), node("span", { class: "orbit-label label-three" }, "有价值的问题")),
    button("建立第一次选题分析 →", () => createAnalysis(navigate), "tool-btn primary welcome-cta"),
    node("div", { class: "welcome-steps" }, [["01", "一张调查卡", "记录资源、研究范围和时间"], ["02", "有来源的结论", "问题、Baseline 与验证路线"], ["03", "找到投稿落点", "期刊趋势、偏好和证据"]].map(([n, title, detail]) => node("div", {}, node("span", {}, n), node("strong", {}, title), node("small", {}, detail)))),
    taskRows.length ? node("section", { class: "recent-analysis" }, node("h3", {}, "继续之前的探索"), taskRows.slice(0, 5).map(t => button(`${t.title}  ·  ${labels[t.status]}`, () => navigate(t.id), "history-row"))) : null);
}
function renderReport(force = false) {
  [...tabBar.children].forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  if (!task) { left.replaceChildren(welcome()); return; }
  if (!force && renderedRevision === task.revision) return;
  renderedRevision = task.revision;
  // Preserve reading position while chat and analysis status updates arrive.
  if (!force && report && tab !== "files" && left.dataset.report === `${reportKey}:${tab}`) return;
  const scroll = left.scrollTop; left.replaceChildren(); left.dataset.report = `${reportKey}:${tab}`;
  if (tab === "files") { renderFiles(); left.scrollTop = scroll; return; }
  if (!report) {
    left.append(node("div", { class: "report-empty" }, node("p", { class: "eyebrow" }, task.mode === "topic" ? "FIRST PAPER · PERSONALIZED" : "FIELD EXPLORATION"), node("h1", {}, task.status === "running" ? "正在从真实论文中收敛选题" : "从研究范围，走向可验证的问题"), node("details", { class: "snapshot-card" }, node("summary", {}, "本次研究范围"), node("p", {}, task.researchArea)),
      node("p", {}, task.mode === "topic" ? `本次固定使用「${task.profile.name}」。${task.profile.months}个月内${stageNames[task.profile.deadlineStage]}。` : "先探索领域的问题结构，本次不使用用户画像。"),
      node("div", { class: "evidence-box" }, node("h3", {}, "这份分析会回答"), node("ol", {}, ["哪些问题仍然值得研究，证据在哪里？", "从哪篇近期 Baseline 开始复现？", "数据、硬件和时间条件是否允许？", "大课题如何拆成小论文，适合投向哪里？"].map(t => node("li", {}, t)))),
      task.lastError && node("p", { class: "evidence-callout amber" }, task.lastError),
      task.status === "running" ? node("p", { class: "progress-label" }, "正在建立证据链，可在中栏查看进度，也可以先在右侧讨论。") : controlledButton("检索真实数据并分析 ↗", startAnalysis)));
    return;
  }
  if (viewingReport) left.append(node("div", { class: "evidence-callout" }, "正在查看历史报告。", button("回到最新报告", async () => { viewingReport = null; await refresh(); })));
  else if (task.status === "running" && report.status !== "partial") left.append(node("div", { class: "evidence-callout" }, "正在生成新一轮报告。下方暂时展示上一版，完成后自动更新。"));
  left.append(tab === "journals" ? journalCards(report) : directionCards(report));
  if (report.warnings.length) left.append(node("details", { class: "report-warnings", open: report.status !== "completed" }, node("summary", {}, `数据缺口与核验说明 · ${report.warnings.length}`), report.warnings.map(w => node("p", {}, w))));
  left.append(node("details", { class: "report-method" }, node("summary", {}, "统计方法与时间范围"), node("p", {}, report.methodology), node("p", {}, `Baseline 窗口：${report.period.baselineFrom} – ${report.period.to}`), node("p", {}, report.query)));
  left.scrollTop = force ? 0 : scroll;
}
function renderSearch() {
  if (!center.children.length) {
    const form = node("form", { class: "topic-search-form" }, node("label", {}, "可追溯的学术检索", qInput), node("div", { class: "topic-actions" }, engine, node("button", { type: "submit", class: "tool-btn primary" }, "检索 ↗")));
    form.addEventListener("submit", e => { e.preventDefault(); void runSearch().catch(e => notify(e.message, true)); });
    center.append(form, stageRail.root, timeline, planningPanel, node("div", { class: "search-section-title" }, node("h3", {}, "检索记录"), button("全部资料", () => { tab = "files"; renderReport(true); })), searchResults);
  }
  timeline.replaceChildren(); searchResults.replaceChildren();
  updateStageRail();
  if (task?.status === "running") timeline.dataset.running = "1"; else delete timeline.dataset.running;
  renderPlan();
  if (!task) { searchResults.append(node("p", { class: "empty-note" }, "建立分析后，OpenAlex、arXiv 的检索结果和来源原文会持续保存在这里。")); return; }
  if (task.events.length) {
    timeline.append(node("h3", {}, task.status === "running" ? "正在形成报告" : "分析过程"));
    for (const e of task.events.slice(-8)) timeline.append(node("div", { class: "timeline-step" }, node("span", { class: "timeline-dot" }), node("div", {}, node("small", {}, new Date(e.at).toLocaleTimeString()), node("p", {}, e.text))));
  }
  if (task.lastError) timeline.append(node("p", { class: "inline-error" }, task.lastError));
  const searches = task.artifacts.filter(a => a.kind === "search").reverse();
  for (const a of searches.slice(0, 20)) searchResults.append(button(a.title, () => showSearch(a), "search-history"));
  if (!searches.length) searchResults.append(node("p", { class: "empty-note" }, "还没有检索记录。先开始分析，或自行输入一个具体问题。"));
  if (activeSearch) searchResults.append(activeSearch);
}
async function showSearch(a) {
  const { data } = await request(`/api/topics/${id}/files/${a.id}`);
  activeSearchId = a.id;
  activeSearch = node("div", { class: "search-detail" }, node("h3", {}, a.title), node("code", { class: "query-expression" }, data.query || ""), node("p", { class: data.status === "error" ? "inline-error" : "muted" }, data.status === "error" ? `来源请求失败：${data.error}（不是零篇）` : `已取回 ${data.papers?.length || 0} 篇${data.total != null ? ` · 总匹配 ${data.total} 篇` : ""}`), data.sourceUrl && link("原始查询 ↗", data.sourceUrl),
    (data.papers || []).slice(0, 100).map(p => node("article", { class: "search-paper" }, node("small", {}, `${p.date || "日期未知"} · ${p.source}`), link(p.title, p.url), node("p", {}, p.abstract?.slice(0, 300) || "暂无摘要"), node("div", { class: "topic-actions" }, p.pdf && link("PDF", p.pdf), button("问助手", () => { chatInput.value = `请结合当前选题分析这篇论文：${p.title}\n${p.url}`; scheduleSave({ chatDraft: chatInput.value }); chatInput.focus(); })))));
  renderSearch(); activeSearch.scrollIntoView({ block: "start", behavior: "smooth" });
}
function renderPlan() {
  planningPanel.replaceChildren();
  if (!task) return;
  planningPanel.append(node("p", { class: "baseline-policy" }, `Baseline：中科院大类 1 区 / CCF A 类正式长文 · 近三年${casInfo?.imported ? ` · 分区表 ${casInfo.edition} 年版已导入` : ""}`));
  if (!plan) { planningPanel.append(node("p", { class: "muted" }, "开始后，先由模型提取中英文关键词与细分研究问题。")); return; }
  const keywords = node("details", { class: "plan-keywords" }, node("summary", {}, `提取的关键词 · ${plan.concepts?.length || 0}`), (plan.concepts || []).map(c => node("div", { class: "plan-keyword" }, node("strong", {}, c.zh), node("span", {}, c.en), node("small", {}, ({ task: "任务", method: "方法", context: "背景", tool: "工具" })[c.role] || "关键词"))));
  planningPanel.append(node("h3", {}, "关键词 → 关键方向 → 细分问题"), keywords);
  const groups = [...new Set(plan.queries.map(q => q.parent || "研究问题"))];
  for (const parent of groups) {
    const branches = plan.queries.filter(q => (q.parent || "研究问题") === parent);
    planningPanel.append(node("details", { class: "plan-branch", open: groups.length <= 4 }, node("summary", {}, `${parent} · ${branches.length} 个问题`), branches.map(q => {
      const coverage = retrieval?.coverage?.find(c => c.id === q.id && c.name === (q.name || q.focus));
      return node("section", { class: "plan-question" }, node("h4", {}, q.name || q.focus), node("p", {}, q.focus),
        node("code", { class: "query-expression" }, q.query), node("small", {}, `核心词：${q.terms?.map(t => `${t.zh} / ${t.en}`).join("；") || q.query}`),
        (q.variants || []).length > 1 && node("details", {}, node("summary", {}, `同义词与放宽检索 · ${q.variants.length - 1} 式`), q.variants.slice(1).map(s => node("code", { class: "query-expression" }, s))),
        coverage && node("p", { class: "plan-coverage" }, `${coverage.count} 篇文献 · ${coverage.verifiedCount} 篇通过 Baseline 核验`),
        button("用这组词检索 ↗", () => { qInput.value = q.query; scheduleSave({ searchQuery: q.query }); qInput.focus(); }, "icon-button"));
    })));
  }
  if (retrieval) planningPanel.append(node("div", { class: "evidence-callout" }, `共 ${retrieval.total} 篇去重文献 / ${retrieval.eligible} 篇符合 Baseline 标准。`, node("small", {}, "未核实分区的期刊、预印本和非正式长文保留为线索，不进入 Baseline。")));
}
function renderChat() {
  const bottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90, scroll = messages.scrollTop; messages.replaceChildren();
  if (!task?.chat.length) messages.append(node("div", { class: "chat-welcome" }, node("span", { class: "chat-spark" }, "✳"), node("h3", {}, "一起把问题想清楚"), node("p", {}, "这里记得当前分析的研究范围、画像快照与报告。对话独立保存，随时回来继续。"),
    ["这些方向中，哪个适合我先做？", "模拟审稿人，挑出最薄弱的假设", "把这个大课题拆成可验证的小问题"].map(text => button(text + " ↗", () => { chatInput.value = text; scheduleSave({ chatDraft: text }); }, "chat-suggestion"))));
  for (const m of task?.chat || []) messages.append(node("article", { class: `topic-message ${m.role}` }, node("div", { class: "message-author" }, node("span", {}, m.role === "user" ? "你" : "选题助手"), node("small", {}, m.status === "streaming" ? "正在思考与回复…" : m.status === "interrupted" ? "已中断" : new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))), markdown(m.text || (m.status === "streaming" ? "正在整理回答…" : ""))));
  messages.scrollTop = bottom ? messages.scrollHeight : scroll;
}
function renderFiles() {
  left.append(node("p", { class: "eyebrow" }, "YOUR RESEARCH TRAIL"), node("h2", {}, "资料、快照与历史"), node("p", { class: "muted" }, "所有资料归属当前任务，服务重启后仍可恢复。删除证据会同时清理依赖它的报告及对话，避免删除后仍从记忆中引用。"));
  left.append(casCard());
  if (task.profile) left.append(node("details", { class: "snapshot-card" }, node("summary", {}, `本次画像快照 · ${task.profile.name}`), node("p", {}, `${task.profile.hardware}；${task.profile.gpuCount ?? "未填"}张GPU / 单卡${task.profile.vramGB ?? "未填"}GB`), node("p", {}, task.profile.researchArea), node("p", {}, `${task.profile.months}个月内${stageNames[task.profile.deadlineStage]} · 每周${task.profile.weeklyHours}小时 · ${task.profile.openData ? "必须公开数据" : "允许非公开数据"}`)));
  const filter = node("select", { "aria-label": "资料类型筛选" }, [["all", "全部资料"], ["report", "分析报告"], ["search", "检索结果"], ["document", "原文证据"], ["journal", "期刊报告"], ["evidence", "补充来源"], ["statistics", "统计数据"]].map(([value, text]) => node("option", { value }, text)));
  const rows = node("div", { class: "file-list" });
  const draw = () => {
    rows.replaceChildren();
    for (const a of task.artifacts.slice().reverse().filter(a => filter.value === "all" || a.kind === filter.value)) rows.append(node("article", { class: "file-row" }, node("div", {}, node("strong", {}, a.title), node("small", {}, `${new Date(a.createdAt).toLocaleString()} · ${(a.bytes / 1024).toFixed(1)} KB`)),
      node("div", { class: "topic-actions" }, button(a.kind === "report" ? "查看报告" : "查看", async () => {
        if (a.kind === "report") { viewingReport = a.id; tab = "directions"; await refresh(); renderReport(true); } else await filePreview(a);
      }), node("a", { class: "tool-btn", href: `/api/topics/${id}/files/${a.id}/download`, download: "" }, "下载"), button("删除", async () => {
        if (!await confirmDelete("彻底删除资料", `删除「${a.title}」、依赖它的报告和当前对话。此操作不可恢复。`)) return;
        await request(`/api/topics/${id}/files/${a.id}`, { method: "DELETE" }); viewingReport = null; reportKey = ""; activeSearch = null; await refresh(); renderReport(true);
      }, "tool-btn danger"))));
    if (!rows.children.length) rows.append(node("p", { class: "empty-note" }, "这个分类还没有保存的资料。"));
  };
  filter.addEventListener("change", draw); left.append(filter, rows); draw();
}
function casCard() {
  const imported = casInfo?.imported;
  return node("details", { class: "snapshot-card" }, node("summary", {}, imported ? `中科院分区表 · ${casInfo.edition} 年版 · ${casInfo.count} 刊（已导入）` : "中科院分区表 · 未导入"),
    node("p", { class: "muted" }, imported ? `导入于 ${new Date(casInfo.importedAt).toLocaleString()} · 文件：${casInfo.fileName}。期刊分区与中科院 1 区 Baseline 核验改为直接查表，不再逐刊抓取 fenqubiao。` : "导入官方分区表 CSV 后，期刊分区与中科院 1 区 Baseline 核验直接查表，无需逐刊抓取 fenqubiao。正式研究请使用机构订阅下载的官方整表。"),
    node("div", { class: "topic-actions" }, button(imported ? "重新导入 CSV" : "导入分区表 CSV", casImportDialog), imported && button("移除分区表", casRemove, "tool-btn danger")));
}
function casImportDialog() {
  const file = node("input", { type: "file", accept: ".csv,text/csv" }), edition = node("input", { type: "number", min: "2004", max: String(new Date().getUTCFullYear()), value: String(new Date().getUTCFullYear() - 1) });
  const form = node("form", { class: "topic-form" }, node("p", { class: "muted" }, "选择分区表 CSV 文件。Excel 打开官方 xlsx 后“另存为 CSV”即可（UTF-8 与 GBK 编码都会自动识别）。系统自动识别列：英文刊名/期刊名称、ISSN、大类学科、大类分区、Top、年份；导入会替换当前表。"),
    node("label", { class: "topic-field" }, "CSV 文件", file), node("label", { class: "topic-field" }, "版本年份", edition),
    node("button", { class: "tool-btn primary", type: "submit" }, "解析并导入"));
  const dlg = dialog("导入中科院分区表", form);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const f = file.files?.[0]; if (!f) return notify("请先选择 CSV 文件", true);
    if (f.size > 24 * 1024 * 1024) return notify("文件超过 24MB 上限", true);
    const buffer = await f.arrayBuffer(); let csv = new TextDecoder("utf-8").decode(buffer);
    if ((csv.match(/\uFFFD/g) || []).length > 5) { try { csv = new TextDecoder("gbk").decode(buffer); } catch { /* 保留 UTF-8 解码结果 */ } }
    const submit = form.querySelector("button[type=submit]"); submit.disabled = true; submit.textContent = "解析中…";
    try {
      const r = await request("/api/topics/cas-table", { method: "POST", body: { csv, edition: Number(edition.value) || null, fileName: f.name } });
      casInfo = r.cas; dlg.close(); notify(`已导入 ${r.cas.count} 本期刊（${r.cas.edition} 年版）。重新分析后 Baseline 核验即用查表结果。`); renderReport(true);
    } catch (err) { notify(err.message, true); submit.disabled = false; submit.textContent = "解析并导入"; }
  });
}
async function casRemove() {
  if (!await confirmDelete("移除中科院分区表", "移除后，分区核验恢复为仅采信 fenqubiao.com 原文证据。历史报告不受影响。")) return;
  try { await request("/api/topics/cas-table", { method: "DELETE" }); casInfo = { imported: false }; renderReport(true); }
  catch (e) { notify(e.message, true); }
}
async function loadCasInfo() { try { casInfo = (await request("/api/topics/cas-table")).cas; } catch { casInfo = { imported: false }; } }
async function filePreview(a) {
  const { data } = await request(`/api/topics/${id}/files/${a.id}`);
  const content = node("div", { class: "file-preview" }, data.url && link("原始来源 ↗", data.url), node("p", { class: "muted" }, "预览最多显示40,000字；下载可获得完整保存文件。"), node("pre", {}, (data.text || JSON.stringify(data, null, 2)).slice(0, 40000)));
  dialog(a.title, content).classList.add("report-dialog");
}
async function startAnalysis() {
  if (!task) return createAnalysis(navigate);
  if (!models.length) throw new Error("尚未发现可用 Pi 模型，请先完成模型配置并刷新页面。");
  await flushUI(); await request(`/api/topics/${id}/analyze`, { method: "POST", body: {} }); viewingReport = null; await refresh();
}
async function stop() { if (id) { await request(`/api/topics/${id}/stop`, { method: "POST", body: {} }); await refresh(); } }
async function runSearch() {
  if (!id) throw new Error("请先建立选题分析任务");
  await flushUI(); await request(`/api/topics/${id}/search`, { method: "POST", body: { query: qInput.value, engine: engine.value } }); await refresh();
}
async function sendChat() {
  if (!id || !chatInput.value.trim()) return;
  if (task.chatBusy) throw new Error("助手正在回复，可先停止当前操作");
  const text = chatInput.value; await flushUI(); await request(`/api/topics/${id}/chat`, { method: "POST", body: { text } }); chatInput.value = ""; scheduleSave({ chatDraft: "" }); await refresh();
}
async function clearChat() {
  if (!task?.chat.length) return;
  if (!await confirmDelete("清空选题对话", "彻底删除当前分析的所有对话消息和草稿，分析报告与原始证据保留。")) return;
  clearTimeout(saveTimer); pendingUI = {}; await request(`/api/topics/${id}/chat`, { method: "DELETE" }); chatInput.value = ""; await refresh();
}
function addEvidence() {
  if (!id) return notify("请先建立分析任务", true);
  const title = node("input", { name: "title", placeholder: "资料名称", required: true }), url = node("input", { name: "url", type: "url", placeholder: "https://… 官方指南、分区表、期刊指标或数据集", required: true });
  const venue = node("select", { name: "venueId" }, node("option", { value: "" }, "通用证据 / 政策 / 数据集"), (report?.journals || []).map(j => node("option", { value: j.id }, j.name)));
  const form = node("form", { class: "topic-form" }, node("p", { class: "muted" }, "系统会读取来源原文，保存抓取时间。补充期刊分区或审稿信息时选择对应期刊，再重新分析。中科院分区只采信官方分区表，会议等级只采信 CCF 官方来源。"), node("label", { class: "topic-field" }, "名称", title), node("label", { class: "topic-field" }, "公开来源链接", url), node("label", { class: "topic-field" }, "归属", venue), node("button", { class: "tool-btn primary", type: "submit" }, "读取并保存来源"));
  const dlg = dialog("补充可核实的证据", form);
  form.addEventListener("submit", async e => { e.preventDefault(); try { await request(`/api/topics/${id}/evidence`, { method: "POST", body: { title: title.value, url: url.value, venueId: venue.value } }); dlg.close(); notify("正在读取来源，完成后出现在资料与历史中。"); } catch (e) { notify(e.message, true); } });
}
function taskMenu() {
  if (!task) return;
  const content = node("div", { class: "topic-form" }, node("p", {}, task.title), button("重命名", () => {
    const name = node("input", { value: task.title, "aria-label": "分析名称" }); let dlg;
    dlg = dialog("重命名分析", name, [button("保存", async () => { await request(`/api/topics/${id}`, { method: "PATCH", body: { title: name.value } }); dlg.close(); await refresh(); await taskList(); })]);
  }), button("彻底删除分析", async () => {
    if (!await confirmDelete("彻底删除分析", `删除「${task.title}」及它的全部报告、证据、中间文件、记忆和对话。运行中的任务会先停止。调查卡仍在画像管理中保留。`)) return;
    clearTimeout(saveTimer); pendingUI = {}; stream?.close();
    try { await request(`/api/topics/${id}`, { method: "DELETE" }); document.querySelectorAll("dialog").forEach(d => d.close()); disposed = true; await navigate(null); }
    catch (e) { notify(e.message, true); await refresh(); }
  }, "tool-btn danger")); dialog("分析管理", content);
}
function applyWidths(widths) {
  if (!Array.isArray(widths) || widths.length !== 3 || widths.some(x => !Number.isFinite(x) || x < 15 || x > 65)) return;
  workspace.style.setProperty("--col-a", `${widths[0]}fr`); workspace.style.setProperty("--col-b", `${widths[1]}fr`); workspace.style.setProperty("--col-c", `${widths[2]}fr`);
}
function divider(index) {
  const bar = node("div", { class: "topic-divider", role: "separator", tabindex: 0, "aria-label": index ? "调整检索与对话宽度" : "调整报告与检索宽度", "aria-orientation": "vertical", "aria-valuemin": 15, "aria-valuemax": 65, "aria-valuenow": index ? 26 : 48 });
  let values, start;
  const current = () => { const panes = [leftPane, middlePane, rightPane], total = panes.reduce((n, p) => n + p.offsetWidth, 0); return panes.map(p => p.offsetWidth / total * 100); };
  const update = diff => { const next = [...values], delta = Math.max(15 - next[index], Math.min(next[index + 1] - 15, diff)); next[index] += delta; next[index + 1] -= delta; applyWidths(next); bar.setAttribute("aria-valuenow", Math.round(next[index])); return next; };
  bar.addEventListener("pointerdown", e => { values = current(); start = e.clientX; bar.setPointerCapture(e.pointerId); });
  bar.addEventListener("pointermove", e => { if (bar.hasPointerCapture(e.pointerId)) update((e.clientX - start) / workspace.clientWidth * 100); });
  bar.addEventListener("pointerup", e => { if (bar.hasPointerCapture(e.pointerId)) { bar.releasePointerCapture(e.pointerId); scheduleSave({ widths: current() }); } });
  bar.addEventListener("keydown", e => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); values = current(); scheduleSave({ widths: update(e.key === "ArrowLeft" ? -2 : 2) }); } });
  return bar;
}
async function boot() {
  await initPersistence();
  initSharedTheme();
  try { const r = await request("/api/topics/models"); models = r.models; } catch (e) { notify("模型列表加载失败：" + e.message, true); }
  await loadCasInfo().catch(() => {});
  modelSelect.replaceChildren(node("option", { value: "" }, "使用 Pi 默认模型"), ...models.map(m => node("option", { value: `${m.provider}|${m.id}` }, m.name)));
  await navigate(location.pathname.split("/")[2] || null, false);
}
boot().catch(e => { left.replaceChildren(node("p", { class: "evidence-callout amber" }, e.message)); });
