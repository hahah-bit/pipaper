import test from "node:test";
import assert from "node:assert/strict";
import { completeText, structuredPayload } from "../server/platform/ai/gateway.js";
import { ExecutionRegistry } from "../server/platform/jobs/executions.js";
import { registerSessionScope, beforeSessionPrompt, sessionReplaced } from "../server/platform/ai/session-scopes.js";
import { parseArxivFeed, openalexAbstract } from "../server/platform/academic/metadata.js";

const model = { provider: "deepseek", id: "fixture", api: "openai-completions", input: ["text", "image"], contextWindow: 32000, maxTokens: 8000 };

test("模型网关保留最终文本、用量与图片来源，结构化开关不影响自由问答", async () => {
  let captured;
  const events = [], runtime = { streamSimple: async function* (selected, context, options) {
    captured = { selected, context, options };
    yield { type: "thinking_delta", delta: "依据原文" };
    yield { type: "done", message: { content: [{ type: "text", text: "最终结果" }], usage: { input: 20, output: 10 } } };
  } };
  const result = await completeText({ runtime, model, system: "原文规则", text: "问题", images: [{ blockId: "b1", page: 3, data: "YWJj", mimeType: "image/png" }], imageLabels: true,
    structured: true, maxTokens: 10000, onActivity: event => events.push(event) });
  assert.equal(result.text, "最终结果"); assert.equal(result.usage.input, 20);
  assert.equal(captured.options.maxTokens, 8000);
  assert.equal(captured.context.messages[0].content[1].text, "原文图片 b1，第 3 页");
  assert.deepEqual(events.map(e => e.type), ["model_start", "thinking", "model_end"]);
  assert.equal(captured.options.onPayload({}).response_format.type, "json_object");
  assert.deepEqual(structuredPayload({}, model, false), {});
  assert.deepEqual(structuredPayload({}, { ...model, provider: "other" }, true), {});
});

test("模型取消拒绝迟到响应，截断与服务错误保留实际原因", async () => {
  const controller = new AbortController(), events = [];
  const runtime = { streamSimple: async function* () {
    controller.abort(new Error("任务已删除"));
    yield { type: "done", message: { content: [{ type: "text", text: "迟到结果" }] } };
  } };
  await assert.rejects(completeText({ runtime, model, system: "", text: "问题", signal: controller.signal, onActivity: e => events.push(e) }), /任务已删除/);
  assert.equal(events.at(-1).type, "model_end"); assert.equal(events.at(-1).error, "任务已删除");
  for (const [event, expected] of [
    [{ type: "done", message: { stopReason: "length", content: [{ type: "text", text: "一半" }] } }, /截断/],
    [{ type: "error", error: { errorMessage: "配额用尽" } }, /配额用尽/],
  ]) await assert.rejects(completeText({ runtime: { streamSimple: async function* () { yield event; } }, model, system: "", text: "问题" }), expected);
});

test("任务执行权在取消后仍保持到退出，旧运行器无法释放后继任务", () => {
  const registry = new ExecutionRegistry("test");
  try {
    const first = registry.claim("document");
    registry.abort("document"); assert.equal(first.controller.signal.aborted, true);
    assert.throws(() => registry.claim("document"), error => error.status === 409);
    assert.equal(registry.release("document", first), true);
    const next = registry.claim("document");
    assert.equal(registry.release("document", first), false);
    assert.equal(registry.get("document"), next);
    registry.abortAll(); assert.equal(next.controller.signal.aborted, true);
  } finally { registry.dispose(); }
});

test("会话业务适配器按归属注入上下文，重复注册的旧 disposer 不误撤新处理器", async () => {
  const calls = [], controller = { meta: { topicId: "t1" } };
  const old = registerSessionScope("fixture", { matches: () => true });
  const dispose = registerSessionScope("fixture", { matches: meta => !!meta.topicId,
    beforePrompt: (_c, body) => calls.push(body.text), onReplace: (_c, from, to) => calls.push([from, to]) });
  old();
  try {
    await beforeSessionPrompt({ meta: {} }, { text: "忽略" });
    await beforeSessionPrompt(controller, { text: "问题" });
    await sessionReplaced(controller, "old", "new");
    assert.deepEqual(calls, ["问题", ["old", "new"]]);
  } finally { dispose(); }
});

test("学术元数据解析保留转义标题、日期与 PDF 链接，错误页不能变成零篇", () => {
  const papers = parseArxivFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.12345</id><title>A &amp; B</title><published>2026-01-20T00:00:00Z</published><author><name>张三</name></author><summary>证据</summary><link href="https://arxiv.org/pdf/2601.12345" title="pdf"/></entry></feed>`);
  assert.equal(papers[0].title, "A & B"); assert.equal(papers[0].date, "2026-01-20");
  assert.equal(papers[0].pdf, "https://arxiv.org/pdf/2601.12345"); assert.deepEqual(papers[0].authors, ["张三"]);
  assert.throws(() => parseArxivFeed("<html>服务不可用</html>"), error => error.status === 502);
  assert.equal(openalexAbstract({ beta: [1], alpha: [0], invalid: [-1, 2000000] }), "alpha beta");
});
