import { randomUUID } from "node:crypto";
import { AgentSessionRuntime, createAgentSession, createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { UserInputBroker } from "./user-input.js";
import { mapEntry, sessionTranscript, sessionTree } from "./session-messages.js";

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const imagesOf = (images = []) => images.filter(im => im?.data).map(im => ({ type: "image", mimeType: im.mimeType || "image/png", data: im.data }));

// A controller follows native runtime replacements. It has exactly one browser
// owner and one SDK subscription; neither is shared by other controllers.
export class SessionController {
  constructor({ build, meta = {}, onReplace = () => {}, onMeta = () => {}, beforeSwitch = async () => {} }) {
    this.build = build; this.meta = { ...meta }; this.onReplace = onReplace; this.onMeta = onMeta; this.beforeSwitch = beforeSwitch;
    this.ui = new UserInputBroker(); this.sequence = 0; this.operations = new Map();
    this.resourceState = { status: "applied", revision: 0 }; this.bound = false; this.closed = false;
    this.resourceEpoch = 0; this.queueMirror = { steer: [], followUp: [] };
    this.factory = async options => {
      const result = await this.build(options, this);
      const loadErrors = (result.diagnostics || []).filter(d => d.type === "error").map(d => d.message);
      if (loadErrors.length && this.runtime) { result.session.dispose(); throw new Error(loadErrors.join("\n")); }
      this.candidates = result.candidates || [];
      this.resourceState = { status: loadErrors.length ? "failed" : "applied", revision: result.revision || 0, ...(loadErrors.length ? { error: loadErrors.join("\n") } : {}) };
      return result;
    };
  }
  static async create(options) {
    const c = new SessionController(options);
    c.runtime = await createAgentSessionRuntime(c.factory, options);
    c.attachRuntime();
    return c;
  }
  get session() { return this.runtime.session; }
  get id() { return this.session.sessionId; }
  get busy() { return this.operations.size > 0 || !this.session.isIdle; }
  get operationId() { return this.runId || [...this.operations.keys()].at(-1) || null; }

  attachRuntime() {
    const runtime = this.runtime;
    runtime.setBeforeSessionInvalidate(() => { this.invalidatedRuntime = runtime; });
    this.runtime.setRebindSession(async () => {
      const oldId = this.attachedId;
      this.ui.disconnect("session_replaced");
      this.ui.resetDisplay(); this.activeTools = undefined; this.retry = null;
      if (this.connection) this.ui.connect(e => this.emit(e));
      this.queueMirror = { steer: [], followUp: [] };
      this.attachSession();
      await this.onReplace(oldId, this.id, this);
      this.emit({ t: "session_replaced", oldSessionId: oldId, newSessionId: this.id });
      this.emitSnapshot();
      if (this.connection) await this.bind();
    });
    this.attachSession();
  }
  attachSession() {
    this.unsubscribe?.(); this.bound = false; this.attachedId = this.id;
    const session = this.session;
    this.unsubscribe = session.subscribe(e => { if (this.session === session) this.handleEvent(e); });
  }
  emit(event) {
    const envelope = { sessionId: this.id, operationId: this.operationId, ...event, seq: ++this.sequence };
    try { this.connection?.send(envelope); } catch { void this.disconnect(); }
  }
  state() {
    const s = this.session;
    return { id: this.id, busy: this.busy, operations: [...this.operations].map(([id, type]) => ({ id, type })),
      model: s.model ? { provider: s.model.provider, id: s.model.id } : null,
      thinkingLevel: s.thinkingLevel, thinkingLevels: s.getAvailableThinkingLevels(), name: s.sessionName,
      stats: s.getSessionStats(), contextUsage: s.getContextUsage() || null,
      compacting: s.isCompacting, retrying: s.isRetrying, retry: this.retry || null,
      autoCompaction: s.autoCompactionEnabled, autoRetry: s.autoRetryEnabled,
      queue: { steering: s.getSteeringMessages(), followUp: s.getFollowUpMessages(), steeringMode: s.steeringMode, followUpMode: s.followUpMode },
      resources: this.resourceState, meta: this.meta, ui: this.ui.displayState,
    };
  }
  emitState() { this.emit({ t: "state", state: this.state() }); }
  history() { return { ...this.state(), messages: sessionTranscript(this.session) }; }
  emitSnapshot() { this.emit({ t: "snapshot", history: this.history() }); }
  assertOwner(controlId) {
    if (!this.connection || this.connection.id !== controlId) throw fail("请先连接此会话；其他页面不能操作当前会话");
  }
  connect(send, close = () => {}) {
    if (this.connection) throw fail("此会话已在另一个页面中打开，请先关闭该页面的会话");
    if (this.busy) throw fail("会话正在停止，请稍后重新连接");
    const id = randomUUID(); this.connection = { id, send, close };
    this.ui.connect(e => this.emit(e));
    this.emit({ t: "connected", controlId: id });
    this.emitSnapshot();
    const ready = this.start("startup", async () => {
      if (this.resourceState.status === "pending") await this.reload(true);
      if (this.connection?.id === id) await this.bind();
    });
    return { controlId: id, ready: ready.completion, close: () => this.disconnect(id) };
  }
  async disconnect(id = this.connection?.id) {
    if (!this.connection || this.connection.id !== id) return;
    const connection = this.connection;
    this.ui.disconnect("disconnected"); this.connection = null;
    connection.close();
    await this.abort();
  }
  async bind() {
    if (this.bound || !this.connection) return;
    this.bound = true;
    try {
      await this.session.bindExtensions({ mode: "rpc", uiContext: this.ui.context(this.session.extensionRunner.getUIContext()),
        commandContextActions: {
          waitForIdle: () => this.session.waitForIdle(),
          newSession: options => this.replace("newSession", options),
          fork: (id, options) => this.replace("fork", id, options),
          navigateTree: (id, options) => this.navigate(id, options),
          switchSession: async (file, options) => { await this.beforeSwitch(file, this); return this.replace("switchSession", file, options); },
          reload: () => this.reload(true),
        },
        abortHandler: () => { void this.abort(); }, shutdownHandler: () => { void this.disconnect(); },
        onError: e => this.emit({ t: "notice", note: e.error, isError: true }),
      });
    } catch (error) { this.bound = false; throw error; }
  }
  async replace(method, ...args) {
    if (this.replacing) throw fail("会话正在切换");
    this.replacing = true;
    const old = this.runtime, session = this.session, candidates = this.candidates, resources = this.resourceState;
    const active = session.getActiveToolNames();
    const customTools = session.getAllTools().filter(t => t.sourceInfo?.source === "sdk").map(t => session.getToolDefinition(t.name));
    try { return await old[method](...args); }
    catch (error) {
      // Native replacement disposes the outgoing session before constructing the
      // next one. If loading fails, restore from public services and the original
      // SessionManager, without touching or rewriting its JSONL.
      if (this.runtime === old && old.session === session && this.invalidatedRuntime === old) {
        const restored = await createAgentSession({ ...old.services, sessionManager: session.sessionManager,
          model: session.model, thinkingLevel: session.thinkingLevel, customTools });
        restored.session.setActiveToolsByName(active);
        this.runtime = new AgentSessionRuntime(restored.session, old.services, this.factory, old.diagnostics, old.modelFallbackMessage);
        this.candidates = candidates; this.resourceState = resources;
        this.attachRuntime();
        if (this.connection) await this.bind();
        this.emitSnapshot();
      }
      throw error;
    } finally { this.replacing = false; }
  }
  start(type, task) {
    const id = randomUUID(); this.operations.set(id, type);
    if (type === "prompt") this.runId = id;
    this.emit({ t: "operation_start", id, kind: type }); this.emitState();
    // Defer execution so the caller receives the operation ID before callbacks.
    const finish = (result, error) => {
      this.operations.delete(id); if (this.runId === id) this.runId = null;
      this.emitState();
      this.emit({ t: "operation_end", id, operationId: id, kind: type, result, ...(error ? { error: String(error.message || error) } : {}) });
      if (!this.busy && this.connection && this.resourceState.status === "pending") {
        this.start("reload", () => this.reload(true));
      }
    };
    const completion = Promise.resolve().then(task).then(result => {
      finish(result); return result;
    }, error => { finish(undefined, error); throw error; });
    completion.catch(() => {}); // errors are sent over the owned event stream
    return { id, completion };
  }
  submit(text, images = []) {
    if (!this.connection) throw fail("会话尚未连接");
    const name = /^\/([^\s]+)/.exec(text)?.[1];
    const command = name && this.session.extensionRunner.getCommand(name);
    if (this.busy && !command) throw fail("会话正在执行，请插队或排队");
    if (this.ui.pending.size) throw fail("请先回答或取消当前提问");
    if (!this.bound) throw fail("会话正在初始化");
    return this.start(command ? "command" : "prompt", async () => {
      await this.session.prompt(text, { images: imagesOf(images) });
      this.emitSnapshot();
    });
  }
  async enqueue({ text, images = [], mode = "steer", draft }) {
    if (!["steer", "followUp"].includes(mode) || !String(text).trim()) throw fail("无效的队列消息", 400);
    if (!this.session.isStreaming || this.ui.pending.size) throw fail("当前不是可排队的模型执行阶段，或正在等待回答");
    if (this.session.extensionRunner.getCommand(/^\/([^\s]+)/.exec(text)?.[1] || "")) return this.submit(text, images);
    const item = { id: randomUUID(), mode, text, images: imagesOf(images), draft };
    this.addingDraft = item;
    try { await this.session[mode](text, item.images); }
    finally { this.addingDraft = null; }
    this.reconcileQueue(); return { ok: true, id: item.id };
  }
  reconcileQueue() {
    // Native events describe append or prefix-consumption, never arbitrary edits.
    // Keep positional records so duplicate/expanded text and extension messages
    // cannot make a consumed attachment appear as an unconsumed draft.
    for (const mode of ["steer", "followUp"]) {
      const native = mode === "steer" ? this.session.getSteeringMessages() : this.session.getFollowUpMessages();
      const previous = this.queueMirror[mode];
      let overlap = Math.min(previous.length, native.length);
      while (overlap && !previous.slice(previous.length - overlap).every((item, i) => item.native === native[i])) overlap--;
      const retained = overlap ? previous.slice(-overlap) : [];
      const appended = native.slice(overlap).map(text => ({ native: text, item: null }));
      if (appended.length && this.addingDraft?.mode === mode) {
        appended.at(-1).item = this.addingDraft; this.addingDraft = null;
      }
      this.queueMirror[mode] = [...retained, ...appended];
    }
  }
  takeQueue() {
    this.reconcileQueue();
    const items = Object.entries(this.queueMirror).flatMap(([mode, entries]) => entries.map(e => e.item || { id: randomUUID(), mode, text: e.native, images: [] }));
    this.queueMirror = { steer: [], followUp: [] }; this.session.clearQueue();
    return { items };
  }
  markResourcesPending() {
    this.resourceEpoch++;
    this.resourceState = { ...this.resourceState, status: "pending", error: undefined }; this.emitState();
    if (!this.busy && this.connection) this.start("reload", () => this.reload(true));
  }
  async reload(internal = false) {
    if (!internal && this.busy) throw fail("执行结束后才能重载");
    if (this.session.isStreaming) await this.session.waitForIdle();
    const old = this.runtime, oldState = this.resourceState, oldCandidates = this.candidates;
    const epoch = this.resourceEpoch;
    const options = { cwd: old.cwd, agentDir: old.services.agentDir, sessionManager: old.session.sessionManager,
      sessionStartEvent: { type: "session_start", reason: "reload" } };
    let next;
    try {
      next = await this.build(options, this);
      const errors = (next.diagnostics || []).filter(d => d.type === "error");
      if (errors.length) throw new Error(errors.map(e => e.message).join("\n"));
      if (this.activeTools) next.session.setActiveToolsByName(this.activeTools);
    } catch (error) {
      next?.session.dispose(); this.candidates = oldCandidates;
      this.resourceState = { ...oldState, status: epoch === this.resourceEpoch ? "failed" : "pending", error: error.message }; this.emitState(); throw error;
    }
    this.ui.disconnect("reload");
    this.ui.resetDisplay(true);
    await old.dispose();
    this.runtime = new AgentSessionRuntime(next.session, next.services, this.factory, next.diagnostics, next.modelFallbackMessage);
    this.candidates = next.candidates || []; this.resourceState = { status: epoch === this.resourceEpoch ? "applied" : "pending", revision: next.revision || 0 };
    this.attachRuntime();
    if (this.connection) { this.ui.connect(e => this.emit(e)); await this.bind(); }
    this.emitSnapshot();
    return { ok: true, resources: this.resourceState };
  }
  async navigate(id, options = {}) {
    const result = await this.session.navigateTree(id, options);
    if (!result.cancelled && !result.aborted) {
      if (result.editorText !== undefined) this.ui.setEditor(result.editorText);
      this.emitSnapshot();
    }
    return result;
  }
  tree() { return sessionTree(this.session); }
  async abort(kind) {
    if (kind === "retry") this.session.abortRetry();
    else if (kind === "compaction") this.session.abortCompaction();
    else if (kind === "branchSummary") this.session.abortBranchSummary();
    else {
      this.ui.disconnect("aborted");
      await this.session.abort(); this.session.abortCompaction(); this.session.abortBranchSummary(); this.session.abortBash();
      if (this.connection) this.ui.connect(e => this.emit(e));
    }
    this.emitState();
  }
  handleEvent(e) {
    if (e.type === "entry_appended") {
      const message = mapEntry(e.entry); if (message) this.emit({ t: "entry", message });
    } else if (e.type === "message_start") {
      if (e.message.role === "assistant") { if (this.retry) this.retry.waiting = false; this.emit({ t: "assistant_start" }); }
      else if (e.message.role === "user") this.emit({ t: "user_start", text: typeof e.message.content === "string" ? e.message.content : e.message.content.filter(x => x.type === "text").map(x => x.text).join("\n"), images: Array.isArray(e.message.content) ? e.message.content.filter(x => x.type === "image") : [] });
    } else if (e.type === "message_update") {
      const a = e.assistantMessageEvent;
      if (a.type === "text_delta") this.emit({ t: "delta", text: a.delta });
      if (a.type === "thinking_delta") this.emit({ t: "thinking", text: a.delta });
    } else if (e.type.startsWith("tool_execution_")) {
      this.emit({ t: e.type.replace("tool_execution_", "tool_"), id: e.toolCallId, name: e.toolName, args: e.args,
        content: (e.result || e.partialResult)?.content || [], details: (e.result || e.partialResult)?.details, isError: e.isError });
    } else if (e.type === "queue_update") {
      this.reconcileQueue(); this.emit({ t: "queue", steering: e.steering, followUp: e.followUp });
    } else if (e.type === "session_info_changed") {
      this.onMeta({ title: e.name }); this.emitState();
    } else if (["auto_retry_start", "summarization_retry_scheduled"].includes(e.type)) {
      this.retry = { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, errorMessage: e.errorMessage, waiting: true };
      this.emit({ t: "notice", note: `重试 ${e.attempt}/${e.maxAttempts}：${e.errorMessage}` }); this.emitState();
    } else if (["auto_retry_end", "summarization_retry_finished"].includes(e.type)) {
      this.retry = null; if (e.finalError) this.emit({ t: "notice", note: e.finalError, isError: true }); this.emitState();
    } else if (e.type === "compaction_end") {
      this.emit({ t: "compaction", result: e.result, aborted: e.aborted, error: e.errorMessage }); this.emitSnapshot();
    } else if (e.type === "summarization_retry_attempt_start") {
      if (this.retry) this.retry.waiting = false; this.emitState();
    } else if (["compaction_start", "thinking_level_changed", "turn_end", "agent_settled"].includes(e.type)) {
      this.emit({ t: "runtime_event", event: e }); this.emitState();
    }
  }
  async dispose() {
    await this.disconnect(); this.ui.disconnect("disposed"); this.unsubscribe?.();
    await this.runtime.dispose(); this.closed = true;
  }
}
