import { createSessionEventChannel } from "../sessionEventChannel.js";
import { createUserInputUI } from "../userInput.js";
import { node, request, markdown, button, notify } from "../platform/ui.js";
import { createActivityView } from "./activity.js";

export function createStudyChat({ root, sessionId, paperId, draft = "", onDraft, onEvent, guide = false }) {
  const state = { controlId: null }, channel = createSessionEventChannel({ state });
  let currentId = sessionId, streaming = null, busy = false;
  const messages = node("div", { class: "study-messages", "aria-live": "polite" });
  const connection = node("span", { class: "study-muted", role: "status" }, "连接中…");
  const model = node("select", { "aria-label": guide ? "引导模型" : "自由对话模型" });
  const thinking = node("select", { "aria-label": guide ? "引导思考深度" : "自由对话思考深度" });
  const toolOwners = new Map();
  const call = (path, body) => request(`/api/sessions/${currentId}/${path}`, { method: "POST", headers: { "X-Pi-Control": state.controlId || "" }, body });
  const userInput = createUserInputUI((id, requestId, answer) => request(`/api/sessions/${id}/ui/${requestId}`, { method: "POST", headers: { "X-Pi-Control": state.controlId || "" }, body: answer }), () => call("abort"));
  const input = node("textarea", { rows: 3, "aria-label": "自由提问", placeholder: "结合论文自由提问…（Ctrl+Enter 发送）", value: draft, oninput: () => onDraft?.(input.value) });
  const addMessage = (role, text) => {
    const activity = { kind: "prompt", status: "running", steps: [] }, view = createActivityView(activity);
    view.root.hidden = true;
    const target = markdown(text), el = node("article", { class: "study-message " + role }, node("small", {}, role === "user" ? "你" : "论文助手"), ...(role === "assistant" ? [view.root] : []), target);
    messages.append(el); return { root: el, target, text, activity, view };
  };
  const syncModel = value => {
    if (value?.model) model.value = value.model.provider + "|" + value.model.id;
    busy = !!value?.busy;
    thinking.replaceChildren(...(value?.thinkingLevels || ["off"]).map(level => node("option", { value: level }, "思考: " + level)));
    thinking.value = value?.thinkingLevel || "off"; model.disabled = thinking.disabled = busy;
  };
  const displayActivity = message => { message.view.root.hidden = !message.activity.steps.length; message.view.update(message.activity); };
  const streamNode = () => streaming ||= addMessage("assistant", "");
  const modelStep = message => {
    let step = message.activity.steps.find(s => s.type === "model");
    if (!step) { const [provider, id] = model.value.split("|"); step = { id: "model", type: "model", model: { provider, id }, thinking: "", status: "running" }; message.activity.steps.push(step); }
    return step;
  };
  function toolEvent(event, message) {
    message = toolOwners.get(event.id) || message || streamNode();
    let step = message.activity.steps.find(s => s.id === event.id);
    if (!step) { step = { id: event.id, type: "tool", name: event.name, args: event.args, status: "running" }; message.activity.steps.push(step); toolOwners.set(step.id, message); }
    if (event.content) step.content = event.content;
    if (event.t === "tool_end") { step.status = event.isError ? "error" : "completed"; step.error = event.isError ? "工具执行失败，详见返回内容" : undefined; }
    displayActivity(message);
  }
  function renderHistory(history) {
    messages.replaceChildren(); streaming = null; toolOwners.clear();
    for (const m of history.messages || []) {
      if (m.role === "user" || m.role === "assistant") {
        const text = (m.parts || []).filter(p => p.type === "text").map(p => p.text).join("\n");
        const message = addMessage(m.role, text);
        if (m.role === "assistant") {
          const thought = (m.parts || []).filter(p => p.type === "thinking").map(p => p.text || p.thinking || "").join("");
          if (thought || m.usage) Object.assign(modelStep(message), { thinking: thought, usage: m.usage, status: m.error ? "error" : "completed", error: m.error, model: { id: m.model } });
          for (const part of m.parts || []) if (part.type === "toolCall") toolEvent({ t: "tool_start", id: part.id, name: part.name, args: part.args }, message);
          message.activity.status = m.error ? "error" : "completed"; displayActivity(message);
        }
        for (const p of m.parts || []) if (p.type === "image") messages.append(node("img", { src: `data:${p.mimeType};base64,${p.data}`, class: "study-chat-image", alt: "会话图片" }));
      } else if (m.role === "toolResult") {
        const owner = toolOwners.get(m.toolCallId);
        if (owner) toolEvent({ t: "tool_end", id: m.toolCallId, name: m.toolName, content: m.parts, isError: m.isError }, owner);
        else messages.append(node("details", { class: "study-tool" }, node("summary", {}, m.toolName || "工具结果"), node("pre", {}, m.text || "")));
      } else if (m.text) messages.append(node("details", { class: "study-tool" }, node("summary", {}, m.customType || "会话记录"), markdown(m.text)));
    }
    if (!history.busy) for (const message of new Set(toolOwners.values())) {
      for (const step of message.activity.steps) if (step.status === "running") step.status = "cancelled";
      displayActivity(message);
    }
    if (!messages.childNodes.length) messages.append(node("div", { class: "study-chat-empty" }, node("span", {}, "✦"), node("h3", {}, "随时提问，保持好奇"), node("p", {}, "这里知道你的论文、阅读目标和已确认的阶段成果。自由提问不影响中间的研读进度。")));
    syncModel(history);
  }
  const handler = event => {
    if (event.t === "snapshot") { if (!guide) renderHistory(event.history); syncModel(event.history); }
    if (event.t === "state") syncModel(event.state);
    if (event.t === "session_replaced") currentId = event.newSessionId;
    if (event.t === "connection_status") connection.textContent = ({ ready: "已连接", connecting: "连接中…", restoring: "恢复会话…", starting: "启动中…" })[event.phase] || event.phase;
    if (event.t === "disconnected" || event.t === "taken_over") connection.textContent = event.message || "连接已断开，可重新连接";
    if (event.t === "ui_request") userInput.show(currentId, event.request);
    if (event.t === "ui_resolved") userInput.resolve(event.id);
    if (!guide) {
      if (event.t === "user_start") { messages.querySelector(".study-chat-empty")?.remove(); addMessage("user", event.text); }
      if (event.t === "assistant_start") { if (streaming) { streaming.activity.status = "completed"; displayActivity(streaming); } streaming = null; streamNode(); }
      if (event.t === "delta") {
        streamNode();
        streaming.text += event.text || ""; markdown(streaming.text, streaming.target);
        messages.scrollTop = messages.scrollHeight;
      }
      if (event.t === "thinking") { const message = streamNode(); modelStep(message).thinking += event.text || ""; displayActivity(message); }
      if (["tool_start", "tool_update", "tool_end"].includes(event.t)) toolEvent(event);
      if (event.t === "entry" && event.message?.role === "assistant" && streaming) {
        Object.assign(modelStep(streaming), { status: "completed", usage: event.message.usage }); displayActivity(streaming);
      }
      if (event.t === "operation_end") {
        if (streaming) {
          streaming.activity.status = event.error ? "error" : "completed"; streaming.activity.error = event.error;
          for (const step of streaming.activity.steps) if (step.status === "running") step.status = event.error ? "cancelled" : "completed";
          displayActivity(streaming);
        }
        streaming = null; connection.textContent = event.error || "已连接";
      }
    }
    onEvent?.(event);
  };
  async function connect() {
    const catalog = await request(`/api/models?sessionId=${currentId}`);
    model.replaceChildren(...catalog.models.map(m => node("option", { value: m.provider + "|" + m.id }, m.name || m.id)));
    await channel.connectSessionEvents(currentId, handler);
  }
  model.addEventListener("change", async () => {
    const [provider, id] = model.value.split("|");
    try { await call("model", { provider, id }); } catch (e) { notify(e.message, true); }
  });
  thinking.addEventListener("change", () => call("model", { thinkingLevel: thinking.value }).catch(e => notify(e.message, true)));
  const send = async () => {
    if (!input.value.trim()) return;
    if (busy) throw new Error("请等待当前回复，或先停止生成");
    const text = input.value;
    const result = await call("prompt", { text, paperId });
    input.value = ""; onDraft?.(""); await channel.waitOperation(result.operationId);
  };
  input.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send().catch(e => notify(e.message, true)); } });
  root.append(node("div", { class: "study-chat-toolbar" }, model, thinking, button("重连", async () => { channel.closeSessionEvents(); await connect(); }), connection));
  if (!guide) root.append(messages, node("div", { class: "study-composer" }, input, node("div", { class: "study-actions" }, button("停止", () => call("abort")), button("发送 ↗", send, "tool-btn primary"))));
  return { state, connect, call, wait: channel.waitOperation, close() { userInput.clear(); channel.closeSessionEvents(); },
    setDraft(text) { input.value = text; onDraft?.(text); input.focus(); }, getDraft: () => input.value };
}
