// Browser-owned SSE lifecycle, independent of the DOM so cancellation and
// startup dialogs can be tested without loading the application entry point.
export function createSessionEventChannel({ state, fetch: request = globalThis.fetch, connectTimeoutMs = 30000 }) {
  let channel = null;
  const finished = new Map(), waiting = new Map();
  function waitOperation(id) {
    if (finished.has(id)) {
      const event = finished.get(id);
      return event.error ? Promise.reject(new Error(event.error)) : Promise.resolve(event.result);
    }
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  }
  function closeSessionEvents() {
    const previous = channel; channel = null;
    const error = new Error("会话连接已关闭");
    previous?.rejectReady(error);
    previous?.abort.abort(); state.controlId = null;
    for (const wait of waiting.values()) wait.reject(error);
    waiting.clear(); finished.clear();
  }
  async function connectSessionEvents(id, handler) {
    if (channel?.id === id) return channel.ready;
    closeSessionEvents();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const current = channel = { id, abort: new AbortController(), ready, rejectReady, sequence: 0 };
    const status = phase => handler({ t: "connection_status", sessionId: current.id, phase });
    const timer = setTimeout(() => current.abort.abort(new Error("连接超时：会话资源尚未就绪或服务没有响应，请重试。")), connectTimeoutMs);
    current.abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    const run = async () => {
      status("connecting");
      const res = await request(`/api/sessions/${encodeURIComponent(id)}/events`, { signal: current.abort.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `连接失败（HTTP ${res.status}）`);
      }
      const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("会话连接已断开，当前操作已停止。重新连接可恢复已保存的历史。");
          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split(/\r?\n\r?\n/); buffer = parts.pop();
          for (const part of parts) {
            const line = part.split(/\r?\n/).find(l => l.startsWith("data: "));
            if (!line || channel !== current) continue;
            const event = JSON.parse(line.slice(6));
            if (event.seq <= current.sequence) continue;
            // Only an explicit replacement can transfer this channel to a new ID.
            if (event.t !== "session_replaced" && event.sessionId !== current.id) continue;
            if (event.t === "session_replaced" && event.oldSessionId !== current.id) continue;
            current.sequence = event.seq;
            if (event.t === "session_replaced") current.id = event.newSessionId;
            if (event.t === "connected") {
              // Startup extensions may wait for user input indefinitely. Limit
              // only the initial connection, never a connected startup dialog.
              clearTimeout(timer); state.controlId = event.controlId; status("restoring");
            }
            handler(event);
            if (event.t === "snapshot" && !current.started) status("starting");
            if (event.t === "operation_end") {
              finished.set(event.id, event);
              if (finished.size > 100) finished.delete(finished.keys().next().value);
              const wait = waiting.get(event.id);
              if (wait) { waiting.delete(event.id); event.error ? wait.reject(new Error(event.error)) : wait.resolve(event.result); }
              if (event.kind === "startup") {
                if (event.error) throw new Error(event.error);
                current.started = true; status("ready"); resolveReady();
              }
            }
          }
        }
      } finally { reader.releaseLock(); }
    };
    run().catch(error => {
      // A renderer/parser error must also close the HTTP stream, otherwise the
      // server keeps a ghost owner and refuses the next connection with 409.
      if (current.abort.signal.aborted) error = current.abort.signal.reason || error;
      clearTimeout(timer); current.abort.abort(); rejectReady(error);
      if (channel !== current) return;
      channel = null; state.controlId = null;
      for (const wait of waiting.values()) wait.reject(error);
      waiting.clear(); finished.clear();
      handler({ t: "disconnected", sessionId: current.id, message: error.message });
    });
    return ready;
  }
  return { connectSessionEvents, closeSessionEvents, waitOperation };
}
