import { randomUUID } from "node:crypto";
import { fault } from "../errors.js";

export const JSON_INSTRUCTION = '本次回答由程序解析。只输出一个完整的 JSON 对象，严格遵循请求中的 format 或 JSON 示例，填写全部必需字段。不要在对象前后输出解释、Markdown 标题或代码围栏。Markdown 只能出现在 JSON 字符串字段内；字符串中的换行、双引号和 LaTeX 反斜杠必须按 JSON 规则转义。';

export function structuredPayload(payload, model, structured) {
  if (structured && model.provider === "deepseek" && model.api === "openai-completions")
    return { ...payload, response_format: { type: "json_object" } };
  return payload;
}

// Business callers own model selection, prompts, validation and retry policy.
// The gateway owns transport, input budgets, cancellation and stream events.
export async function completeText({ runtime, model, system, text, images = [], signal,
  onDelta, onActivity, maxTokens = 10000, reasoning, reasoningBudget = false,
  structured = false, timeoutMs = 240000, imagePolicy = "require", contextReserve = 1200,
  imageLabels = false, contentFormat = "auto", emptyCode = "MODEL_EMPTY", lengthMessage = "模型输出被截断，请缩小当前内容或切换模型后重试" }) {
  signal?.throwIfAborted();
  if (!model) throw fault("请先在 Pi 中配置并登录可用模型", 503);
  const visual = model.input?.includes("image");
  if (images.length && !visual) {
    if (imagePolicy === "require") throw fault("当前模型不支持图片输入", 422);
    text += "\n当前模型不支持看图：只能依据图注和正文讨论图表，不能声称已识别图中未转录的数值或结构。";
  }
  if (reasoningBudget) maxTokens += ({ low: 2048, medium: 8192, high: 16384, max: 32768, xhigh: 32768 })[reasoning] || 0;
  maxTokens = Math.min(maxTokens, model.maxTokens || maxTokens);
  const budget = Math.max(1000, (model.contextWindow || 32000) - maxTokens - contextReserve);
  if (system.length + text.length > budget * 1.5) throw fault("当前模型上下文不足，请换用更长上下文的模型", 422);
  const content = visual && images.length || contentFormat === "parts" ? [{ type: "text", text }, ...(visual ? images : []).flatMap(image => [
    ...(imageLabels ? [{ type: "text", text: `原文图片 ${image.blockId}，第 ${image.page} 页` }] : []),
    { type: "image", data: image.data, mimeType: image.mimeType },
  ])] : text;
  const id = randomUUID(), modelRef = { provider: model.provider, id: model.id };
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  onActivity?.({ type: "model_start", id, model: modelRef });
  try {
    const stream = runtime.streamSimple(model, { systemPrompt: system,
      messages: [{ role: "user", content, timestamp: Date.now() }] }, {
      signal: requestSignal, maxTokens, reasoning,
      onPayload: payload => structuredPayload(payload, model, structured),
    });
    let output = "", final;
    for await (const event of stream) {
      requestSignal.throwIfAborted();
      if (event.type === "text_delta") { output += event.delta; onDelta?.(event.delta); }
      if (event.type === "thinking_delta") onActivity?.({ type: "thinking", id, text: event.delta });
      if (event.type === "done") final = event.message;
      if (event.type === "error") throw fault(event.error?.errorMessage || "模型调用失败", 502);
    }
    requestSignal.throwIfAborted();
    if (!output.trim()) output = final?.content?.filter(part => part.type === "text").map(part => part.text).join("") || "";
    if (final?.stopReason === "length") throw fault(lengthMessage, 422);
    if (!output.trim()) throw Object.assign(fault("模型没有返回内容", 502), { code: emptyCode });
    onActivity?.({ type: "model_end", id, usage: final?.usage });
    return { text: output, model: modelRef, usage: final?.usage };
  } catch (error) { onActivity?.({ type: "model_end", id, error: error.message }); throw error; }
}
