import { api, state } from "./app.js";
import { createSessionEventChannel } from "./sessionEventChannel.js";

// 临时会话执行器：后台跑一条 prompt（不进当前聊天），完成后由调用方决定删除时机。
// 图表分析生成（figureGen）与 LaTeX·MD 编辑器的 AI 辅助改稿（mdEditor）共用。
// 失败时临时会话保留，便于回查 AI 到底做了什么。

async function tmpFetch(holder, url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(holder.controlId ? { "X-Pi-Control": holder.controlId } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
}

/**
 * 在临时会话里执行一条 prompt 并等待完成。
 * 返回 { sessionId, controlId, assistantText }；会话保留，删除由调用方调 removeTempSession。
 */
export async function runTempPrompt({ title, prompt, paperId = null, projectId = null, onStatus, onEvent } = {}) {
  const holder = { controlId: null };
  const channel = createSessionEventChannel({ state: holder });
  const created = await api.createSession(paperId, projectId, title);
  const sessionId = created.id;
  let assistantText = "";
  try {
    await channel.connectSessionEvents(sessionId, (ev) => {
      if (ev.t === "connected") holder.controlId = ev.controlId;
      else if (ev.t === "delta") assistantText += ev.text || "";
      else if (ev.t === "tool_start" && ev.name === "write") onStatus?.("正在写入 " + (ev.args?.path || "文件") + " …");
      else if (ev.t === "tool_start" && ["read", "read_paper"].includes(ev.name)) onStatus?.("正在阅读资料…");
      onEvent?.(ev);
    });
    const res = await tmpFetch(holder, `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { text: prompt, paperId, projectId },
    });
    const op = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(op.error || `HTTP ${res.status}`);
    await channel.waitOperation(op.operationId);
  } finally {
    channel.closeSessionEvents();
  }
  return { sessionId, controlId: holder.controlId, assistantText };
}

export async function removeTempSession(sessionId, controlId) {
  try {
    await tmpFetch({ controlId }, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch {}
}
