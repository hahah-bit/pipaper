// One browser-owned event channel. Requests are acknowledged separately from
// execution, so idle extension dialogs and non-prompt operations can emit UI.
import { state } from "./app.js";

let channel = null;
const finished = new Map(), waiting = new Map();
export function waitOperation(id) {
  if (finished.has(id)) return resolveResult(finished.get(id));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}
function resolveResult(event) { return event.error ? Promise.reject(new Error(event.error)) : Promise.resolve(event.result); }
export function closeSessionEvents() {
  const previous = channel; channel = null;
  previous?.abort.abort(); state.controlId = null;
  for (const wait of waiting.values()) wait.reject(new Error("会话连接已关闭"));
  waiting.clear(); finished.clear();
}
export async function connectSessionEvents(id, handler) {
  if (channel?.id === id) return channel.ready;
  closeSessionEvents();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const current = channel = { id, abort: new AbortController(), ready, sequence: 0 };
  const run = async () => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`, { signal: current.abort.signal });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("会话连接已断开，当前操作已停止。可重新打开会话查看已保存内容。");
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n"); buffer = parts.pop();
      for (const part of parts) {
        const line = part.split("\n").find(l => l.startsWith("data: "));
        if (!line || channel !== current) continue;
        const event = JSON.parse(line.slice(6));
        if (event.seq <= current.sequence) continue;
        current.sequence = event.seq;
        if (event.t === "connected") state.controlId = event.controlId;
        if (event.t === "session_replaced") current.id = event.newSessionId;
        // Only an explicit replacement can transfer this channel to a new ID.
        if (event.sessionId !== current.id) continue;
        handler(event);
        if (event.t === "operation_end") {
          finished.set(event.id, event);
          if (finished.size > 100) finished.delete(finished.keys().next().value);
          const wait = waiting.get(event.id);
          if (wait) { waiting.delete(event.id); event.error ? wait.reject(new Error(event.error)) : wait.resolve(event.result); }
          if (event.kind === "startup") event.error ? rejectReady(new Error(event.error)) : resolveReady();
        }
      }
    }
  };
  run().catch(error => {
    rejectReady(error);
    if (channel !== current) return;
    channel = null; state.controlId = null;
    for (const wait of waiting.values()) wait.reject(error);
    waiting.clear();
    handler({ t: "disconnected", message: error.message });
  });
  return ready;
}
