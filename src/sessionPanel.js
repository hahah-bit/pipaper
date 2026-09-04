import { api, state, $, el, toast, renderChips, askText } from "./app.js";
import { waitOperation } from "./sessionTransport.js";

let metrics, extensions, toolbar, queueControls, draftsBox;
const drafts = [];
const guard = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message, true); } };
async function action(name, body = {}) {
  if (!state.sessionId || !state.controlId) throw new Error("请先打开会话");
  const result = await api.sessionAction(state.sessionId, name, body);
  return result.operationId ? waitOperation(result.operationId) : result;
}
function button(text, fn) { return el("button", { class: "tool-btn", type: "button", onclick: guard(fn) }, text); }
function dialog(title) {
  const node = el("dialog", { class: "native-dialog" });
  const content = el("div", { class: "native-dialog-body" });
  node.append(el("header", {}, el("strong", {}, title), button("关闭", () => node.close())), content);
  node.addEventListener("close", () => node.remove()); document.body.append(node); node.showModal();
  return { node, content };
}

export function initSessionPanel() {
  metrics = el("div", { id: "native-metrics", role: "status", class: "native-metrics" }, "会话尚未连接");
  extensions = el("div", { class: "native-extension-ui" });
  toolbar = el("div", { class: "native-toolbar" },
    button("改名", async () => { const name = await askText({ title: "会话名称", initial: state.nativeSession?.name || "", okText: "保存" }); if (name !== null) await action("name", { name }); }),
    button("会话树", showTree), button("工具", showTools),
    button("压缩", async () => { const instructions = await askText({ title: "压缩会话", message: "压缩时需要保留的信息（可留空）", okText: "开始压缩" }); if (instructions !== null) await action("compact", { instructions }); }),
    button("重载资源", () => action("reload")),
    button("导出 HTML", () => download("html")), button("导出 JSONL", () => download("jsonl")));
  const top = $("#messages"); top.before(toolbar, metrics, extensions);
  draftsBox = el("div", { class: "native-drafts" });
  queueControls = el("div", { class: "native-queue-controls" }, button("取回待发送消息", async () => {
    const result = await action("queue/take"); drafts.push(...result.items); renderDrafts();
    toast(result.items.length ? `已取回 ${result.items.length} 条` : "没有待发送消息");
  }));
  for (const [key, label] of [["steering", "插队"], ["followUp", "排队"]]) {
    const select = el("select", { id: `native-mode-${key}`, "aria-label": `${label}处理模式` }, el("option", { value: "one-at-a-time" }, label + "逐条处理"), el("option", { value: "all" }, label + "合并处理"));
    select.onchange = guard(() => action("queue/mode", { [key]: select.value })); queueControls.append(select);
  }
  queueControls.append(button("取消重试", () => action("abort", { kind: "retry" })), button("取消压缩/摘要", () => action("abort", { kind: state.nativeSession?.operations?.some(o => o.type === "tree") ? "branchSummary" : "compaction" })));
  $("#chat-queue").after(queueControls, draftsBox);
}
function renderDrafts() {
  draftsBox.replaceChildren();
  drafts.forEach((d, index) => draftsBox.append(button(`${d.mode === "steer" ? "插队" : "排队"}草稿：${(d.draft?.text || d.text).slice(0,70)}`, () => {
    const input = $("#composer-input");
    if (input.value.trim() || state.chips.length) {
      drafts.push({ mode: "followUp", text: input.value, draft: { text: input.value, chips: structuredClone(state.chips) } });
    }
    input.value = d.draft?.text ?? d.text;
    state.chips = d.draft?.chips || (d.images || []).map(im => ({ kind: "image", tag: "恢复的附件", dataUrl: `data:${im.mimeType};base64,${im.data}` }));
    drafts.splice(index, 1); renderChips(); renderDrafts(); input.dispatchEvent(new Event("input")); input.focus();
  })));
}
export function renderSessionState(value) {
  if (!metrics) return;
  const context = value.contextUsage, stats = value.stats;
  const used = context?.percent != null ? `${Number(context.percent).toFixed(1)}%` : context?.tokens != null && context.contextWindow ? `${(100 * context.tokens / context.contextWindow).toFixed(1)}%` : "未知";
  const resource = ({ applied: "资源已生效", pending: "资源待更新", failed: "资源加载失败" })[value.resources?.status] || "";
  const phase = value.retry ? `重试 ${value.retry.attempt}/${value.retry.maxAttempts}${value.retry.waiting ? ` · 等待 ${Math.ceil(value.retry.delayMs / 1000)} 秒` : ""}` : value.compacting ? "压缩/摘要中" : value.busy ? "执行中" : "空闲";
  metrics.textContent = [phase, `上下文 ${used}`, `累计 ${stats?.tokens?.total ?? "未知"} tokens`, `缓存读/写 ${stats?.tokens?.cacheRead ?? "?"}/${stats?.tokens?.cacheWrite ?? "?"}`, stats?.cost != null ? `$${Number(stats.cost).toFixed(4)}` : "费用未知", resource].join(" · ");
  metrics.title = value.resources?.error || value.retry?.errorMessage || "上下文占用与累计用量分别统计";
  for (const b of toolbar.querySelectorAll("button")) b.disabled = !!value.busy || !state.controlId;
  for (const key of ["steering", "followUp"]) { const s = $(`#native-mode-${key}`); if (s) s.value = value.queue?.[key + "Mode"] || "one-at-a-time"; }
  const ui = value.ui || {};
  extensions.replaceChildren();
  if (ui.title) extensions.append(el("span", {}, ui.title));
  if (ui.working && ui.workingVisible !== false && value.busy) extensions.append(el("span", {}, ui.working));
  for (const [key, text] of Object.entries(ui.statuses || {})) extensions.append(el("span", { title: key }, text));
  for (const [key, lines] of Object.entries(ui.widgets || {})) extensions.append(el("details", {}, el("summary", {}, key), el("pre", {}, lines.join("\n"))));
}
async function showTools() {
  const { content } = dialog("当前会话工具与诊断");
  const info = await api.resources();
  const selected = new Set(info.tools.filter(t => t.enabled).map(t => t.name));
  const list = el("div", {}); const checkboxes = new Map();
  for (const tool of info.tools) {
    const cb = el("input", { type: "checkbox" }); cb.checked = selected.has(tool.name); checkboxes.set(tool.name, cb);
    cb.onchange = () => cb.checked ? selected.add(tool.name) : selected.delete(tool.name);
    list.append(el("label", { class: "native-tool-row" }, cb, el("strong", {}, tool.name), el("span", {}, tool.description + " · " + (tool.source?.source || "未知来源"))));
  }
  const saveDefault = el("input", { type: "checkbox" }); saveDefault.disabled = !info.projectId;
  content.append(el("p", {}, "启停在下一轮模型调用中生效。仅内置读取工具会关闭所有扩展工具；这不构成文件系统沙箱。"),
    button("仅内置读取工具", () => { selected.clear(); for (const name of ["read", "grep", "find", "ls"]) if (checkboxes.has(name)) selected.add(name); for (const [name, cb] of checkboxes) cb.checked = selected.has(name); }), list,
    el("label", {}, saveDefault, "同时保存为当前项目默认"), button("应用工具选择", async () => { await action("tools", { names: [...selected], saveProjectDefault: saveDefault.checked }); toast("工具选择已应用"); }),
    el("h3", {}, "加载诊断"));
  for (const d of info.diagnostics || []) content.append(el("pre", {}, `${d.type}: ${d.message}`));
  if (info.resources?.error) content.append(el("pre", {}, info.resources.error));
  if (!info.diagnostics?.length && !info.resources?.error) content.append(el("p", {}, "未发现加载问题"));
}
async function showTree() {
  const { content, node } = dialog("当前会话内的节点树");
  const summarize = el("input", { type: "checkbox" });
  const instructions = el("input", { type: "text", placeholder: "分支摘要需要保留的信息（可选）" });
  const treeBox = el("div", {});
  content.append(el("p", {}, "这里切换同一会话文件内的路径；编辑历史问题的 ✎ 按钮会另建分支会话。"), el("label", {}, summarize, "切换前总结离开的分支"), instructions, treeBox);
  async function refresh() {
    const tree = await api.sessionTree(state.sessionId); treeBox.replaceChildren();
    const visit = (item, depth) => {
      const label = el("input", { type: "text", value: item.label || "", placeholder: "节点标签", "aria-label": "节点标签" });
      const row = el("div", { class: "native-tree-row", style: { marginLeft: Math.min(depth, 15) * 12 + "px" } },
        el("span", {}, `${item.id === tree.leafId ? "● " : ""}${item.role || item.type}: ${item.text}`), label,
        button("保存标签", async () => { await action("tree/label", { entryId: item.id, label: label.value }); await refresh(); }),
        button("定位", () => { const target = document.querySelector(`[data-entry-id="${item.id}"]`); if (target) { node.close(); target.scrollIntoView({ block: "center" }); } else toast("该节点不在当前显示路径，请切换至此节点"); }),
        button("切换至此", async () => { const r = await action("tree/navigate", { entryId: item.id, summarize: summarize.checked, instructions: instructions.value }); if (!r?.cancelled && !r?.aborted) node.close(); else toast("已取消，保留原路径"); }));
      treeBox.append(row); item.children.forEach(child => visit(child, depth + 1));
    };
    tree.nodes.forEach(item => visit(item, 0));
  }
  await refresh();
}
async function download(format) {
  const res = await fetch(`/api/sessions/${state.sessionId}/export`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Control": state.controlId }, body: JSON.stringify({ format }) });
  if (!res.ok) throw new Error((await res.json()).error);
  const url = URL.createObjectURL(await res.blob()), a = el("a", { href: url, download: `PiPaper-${state.sessionId}.${format}` });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
