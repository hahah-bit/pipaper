import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

// One broker per session. Only a live browser stream may receive a question.
export class UserInputBroker {
  pending = new Map();
  send = null;

  connect(send) { this.send = send; }

  disconnect(reason = "disconnected") {
    for (const entry of [...this.pending.values()]) entry.finish({ cancelled: true, reason });
    this.send = null;
  }

  request(spec, { signal, timeout } = {}) {
    if (!this.send || signal?.aborted) return Promise.resolve({ cancelled: true, reason: "unavailable" });
    if (!["confirm", "select", "input", "editor"].includes(spec.kind)) throw new Error("不支持的提问类型");
    if (spec.kind === "select" && (!Array.isArray(spec.options) || !spec.options.length || spec.options.some((s) => typeof s !== "string"))) {
      throw new Error("选择问题必须提供选项");
    }
    const request = { ...spec, id: randomUUID() };
    if (Number.isFinite(timeout) && timeout > 0) request.expiresAt = Date.now() + timeout;
    return new Promise((resolve) => {
      let timer;
      const abort = () => finish({ cancelled: true, reason: "aborted" });
      const finish = (result) => {
        if (!this.pending.delete(request.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        try { this.send?.({ t: "ui_resolved", id: request.id, ...result }); } catch {}
        resolve(result);
      };
      this.pending.set(request.id, { request, finish });
      signal?.addEventListener("abort", abort, { once: true });
      if (request.expiresAt) timer = setTimeout(() => finish({ cancelled: true, reason: "timeout" }), timeout);
      try { this.send({ t: "ui_request", request }); }
      catch { finish({ cancelled: true, reason: "disconnected" }); }
    });
  }

  answer(id, answer) {
    const entry = this.pending.get(id);
    if (!entry) throw Object.assign(new Error("这个问题已结束，请勿重复提交"), { status: 409 });
    if (!answer || typeof answer !== "object" || (answer.cancelled !== undefined && typeof answer.cancelled !== "boolean")) {
      throw Object.assign(new Error("答案格式无效"), { status: 400 });
    }
    if (answer.cancelled === true) {
      entry.finish({ cancelled: true, reason: "user" });
      return;
    }
    const { request } = entry;
    const value = answer.value;
    const valid = request.kind === "confirm" ? typeof value === "boolean"
      : typeof value === "string" && value.length <= 20000
        && (request.kind !== "select" || request.options.includes(value) || (request.allowCustom && value.trim().length > 0));
    if (!valid) throw Object.assign(new Error("答案与问题类型或选项不匹配"), { status: 400 });
    entry.finish({ cancelled: false, value });
  }

  // Preserve SDK defaults for terminal-only operations; replace dialog methods.
  context(base) {
    const value = async (spec, opts) => {
      const result = await this.request(spec, opts);
      return result.cancelled ? undefined : result.value;
    };
    return {
      ...base,
      select: (title, options, opts) => value({ kind: "select", title, options }, opts),
      confirm: async (title, message, opts) => (await value({ kind: "confirm", title, message }, opts)) === true,
      input: (title, placeholder, opts) => value({ kind: "input", title, placeholder }, opts),
      editor: (title, prefill) => value({ kind: "editor", title, prefill }),
      notify: (note, type) => this.send?.({ t: "notice", note, isError: type === "error" }),
      custom: async () => { throw new Error("网页不支持终端自定义组件，请使用 ui.select / confirm / input / editor"); },
    };
  }
}

export function userInputTool(broker) {
  return defineTool({
    name: "request_user_input",
    label: "询问用户",
    description: "需要用户选择、确认是否继续或补充信息时调用。网页会显示交互小窗，等待用户提交后返回答案。不要仅在回复文字中提问。取消不代表同意，不要重复询问已回答的问题。",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("confirm"), Type.Literal("select"), Type.Literal("input")]),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      message: Type.Optional(Type.String({ maxLength: 8000 })),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 20 })),
      placeholder: Type.Optional(Type.String()),
    }),
    execute: async (_id, spec, signal) => {
      const result = await broker.request({ ...spec, allowCustom: spec.kind === "select" }, { signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
