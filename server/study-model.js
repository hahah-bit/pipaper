import { controllerFor } from "./native-harness.js";
import { fault } from "./study-store.js";
import { parseModelJson } from "./study-flow.js";
import { randomUUID } from "node:crypto";

const JSON_INSTRUCTION = '本次回答由程序解析。只输出一个完整的 JSON 对象，严格遵循请求中的 format 或 JSON 示例，填写全部必需字段。不要在对象前后输出解释、Markdown 标题或代码围栏。Markdown 只能出现在 JSON 字符串字段内；字符串中的换行、双引号和 LaTeX 反斜杠必须按 JSON 规则转义。';

export function studyModelPayload(payload, model, structured) {
  // Pi forwards onPayload to its provider adapter. Do not assume every compatible
  // endpoint supports response_format; enable it for the verified DeepSeek API.
  if (structured && model.provider === "deepseek" && model.api === "openai-completions") {
    return { ...payload, response_format: { type: "json_object" } };
  }
  return payload;
}

export async function completeStudyModel({ sessionId, system, text, images = [], signal, onDelta, onActivity, maxTokens = 6500, model: selected, structured = false }) {
  const c = await controllerFor(sessionId);
  const runtime = c.session.modelRuntime;
  const model = selected ? runtime.getModel(selected.provider, selected.id) : c.session.model;
  if (!model) throw fault("请先在 Pi 中配置并登录可用模型", 503);
  if (structured) system += "\n" + JSON_INSTRUCTION;
  const reasoning = model.reasoning ? c.session.thinkingLevel : undefined;
  maxTokens += ({ low: 2048, medium: 8192, high: 16384, max: 32768, xhigh: 32768 })[reasoning] || 0;
  maxTokens = Math.min(maxTokens, model.maxTokens || maxTokens);
  const visual = model.input?.includes("image");
  if (images.length && !visual) text += "\n当前模型不支持看图：只能依据图注和正文讨论图表，不能声称已识别图中未转录的数值或结构。";
  // Reject oversized inputs instead of silently losing the tail of a paper.
  const budget = Math.max(1000, (model.contextWindow || 32000) - maxTokens - 1200);
  if (system.length + text.length > budget * 1.5) throw fault("当前模型上下文不足，请换用更长上下文的模型", 422);
  const content = visual && images.length ? [{ type: "text", text }, ...images.flatMap(i => [{ type: "text", text: `原文图片 ${i.blockId}，第 ${i.page} 页` }, { type: "image", data: i.data, mimeType: i.mimeType }])] : text;
  const report = onActivity || c.studyReport, id = randomUUID();
  report?.({ type: "model_start", id, model: { provider: model.provider, id: model.id } });
  try {
  const stream = runtime.streamSimple(model, { systemPrompt: system, messages: [{ role: "user", content, timestamp: Date.now() }] },
    { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(240000)]), maxTokens,
      reasoning,
      onPayload: payload => studyModelPayload(payload, model, structured) });
  let output = "", final;
  for await (const event of stream) {
    if (event.type === "text_delta") { output += event.delta; onDelta?.(event.delta); }
    if (event.type === "thinking_delta") report?.({ type: "thinking", id, text: event.delta });
    if (event.type === "done") final = event.message;
    if (event.type === "error") throw fault(event.error?.errorMessage || "模型调用失败", 502);
  }
  signal?.throwIfAborted();
  // Some adapters only publish the assembled text in the terminal message.
  if (!output.trim()) output = final?.content?.filter(part => part.type === "text").map(part => part.text).join("") || "";
  if (final?.stopReason === "length") throw fault("模型输出被截断，请缩小当前内容或切换模型后重试", 422);
  if (!output.trim()) throw Object.assign(fault("模型没有返回内容", 502), { code: "STUDY_MODEL_EMPTY" });
  report?.({ type: "model_end", id, usage: final?.usage });
  return { text: output, model: { provider: model.provider, id: model.id }, usage: final?.usage };
  } catch (error) { report?.({ type: "model_end", id, error: error.message }); throw error; }
}

export async function completeStudyJson({ validate = value => value, onRetry, ...options }) {
  let feedback = "", selected = options.model;
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal?.throwIfAborted();
    let result;
    try {
      result = await completeStudyModel({ ...options, model: selected, structured: true, system: options.system + feedback });
      selected = result.model;
    } catch (error) {
      options.signal?.throwIfAborted();
      // Network/auth/length errors must keep their actual cause, not become JSON errors.
      if (error.code !== "STUDY_MODEL_EMPTY") throw error;
      error.modelDiagnostics = { reason: "empty response", output: "", attempt: attempt + 1 };
      if (attempt) throw error;
      feedback = "\n上一次返回了空内容。请根据原始资料和格式要求输出完整 JSON 对象。";
      onRetry?.("模型未返回内容，正在重试一次…");
      continue;
    }
    try {
      const value = validate(parseModelJson(result.text));
      options.signal?.throwIfAborted();
      return { ...result, value };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error.status !== 422) throw error;
      error.modelDiagnostics = { ...error.modelDiagnostics, reason: error.modelDiagnostics?.reason || error.message,
        output: result.text, model: result.model, attempt: attempt + 1 };
      if (attempt) throw error;
      // Regenerate from the original evidence. Never coerce missing fields, invent
      // citations or turn a malformed assessment into a passing grade.
      feedback = `\n上一次回答未通过格式与内容校验：${error.message}。请根据原始资料重新输出完整 JSON，核对必需字段和真实块 ID，不得省略或以自然语言代替。若在评估答案，不得因此推定通过，仍须依据原文和评分要点判断。`;
      onRetry?.("模型返回格式或必需内容不完整，正在重新校验一次…");
    }
  }
}
