import { controllerFor } from "./native-harness.js";
import { parseModelJson } from "./platform/ai/json.js";
import { completeText, JSON_INSTRUCTION } from "./platform/ai/gateway.js";
export { structuredPayload as studyModelPayload } from "./platform/ai/gateway.js";

export async function completeStudyModel({ sessionId, system, model: selected, structured = false, onActivity, ...options }) {
  const c = await controllerFor(sessionId), runtime = c.session.modelRuntime;
  const model = selected ? runtime.getModel(selected.provider, selected.id) : c.session.model;
  return completeText({ ...options, runtime, model, system: system + (structured ? "\n" + JSON_INSTRUCTION : ""),
    structured, reasoning: model?.reasoning ? c.session.thinkingLevel : undefined, reasoningBudget: true,
    maxTokens: options.maxTokens ?? 6500, imagePolicy: "context-only", imageLabels: true,
    onActivity: onActivity || c.studyReport, emptyCode: "STUDY_MODEL_EMPTY" });
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
