import { fault } from "../errors.js";

export function parseModelJson(text) {
  const input = String(text).trim();
  const fence = input.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const cleaned = fence ? fence[1].trim() : input;
  let reason = "期望 JSON 对象";
  try { const result = JSON.parse(cleaned); if (result && typeof result === "object" && !Array.isArray(result)) return result; }
  catch (error) { reason = error.message; }
  throw Object.assign(fault("模型未返回有效结构化结果，请重试；进度未推进", 422), {
    modelDiagnostics: { reason, output: String(text) },
  });
}
