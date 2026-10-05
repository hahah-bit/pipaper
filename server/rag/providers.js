import fs from "node:fs";
import path from "node:path";
import {
  ModelRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { getConfig, DATA_DIR } from "../config.js";
import { digest, readState, writeState, fault } from "../storage/catalog.js";
import { parseModelJson } from "../study-flow.js";

export const waiting = (message) =>
  Object.assign(fault(message, 503), { waitingConfiguration: true });
export const expansionPromptVersion = "expansion-v2";
const cleanError = (message) =>
  String(message)
    .replace(/sk-[\w.-]+/g, "[已隐藏密钥]")
    .slice(0, 500);
export function embeddingKey() {
  const env =
    process.env.PIPAPER_EMBEDDING_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (env) return env;
  try {
    const local = JSON.parse(
      fs.readFileSync(
        path.join(DATA_DIR, "credentials", "embedding.json"),
        "utf8",
      ),
    );
    if (local.apiKey) return local.apiKey;
  } catch {}
  const credential = readStoredCredential("bailian");
  return credential?.type === "api_key" ? credential.key : null;
}
export async function embed(
  texts,
  {
    type = "document",
    signal,
    fetchImpl = fetch,
    config = getConfig().rag.embedding,
    key = embeddingKey(),
    cache = true,
  } = {},
) {
  if (!key)
    throw waiting("请设置百炼 Embedding 凭据（服务端环境变量或 Pi 百炼认证）");
  if (
    !["document", "query"].includes(type) ||
    !Array.isArray(texts) ||
    texts.some(
      (t) => typeof t !== "string" || !t.trim() || Buffer.byteLength(t) > 8192,
    )
  )
    throw fault("Embedding 输入无效或超过 8192 字节", 422);
  const result = [];
  for (let i = 0; i < texts.length; i += 10) {
    signal?.throwIfAborted();
    const batch = texts.slice(i, i + 10),
      keys = batch.map((text) => "embedding:" + digest([config, type, text]));
    const vectors = keys.map((k) => (cache ? readState(k, null) : null));
    const missing = vectors.map((v, n) => (v ? -1 : n)).filter((n) => n >= 0);
    if (missing.length) {
      let response;
      try {
        response = await fetchImpl(config.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            input: { texts: missing.map((n) => batch[n]) },
            parameters: { dimension: config.dimension, text_type: type },
          }),
          signal: AbortSignal.any([
            signal || new AbortController().signal,
            AbortSignal.timeout(60000),
          ]),
        });
      } catch (e) {
        signal?.throwIfAborted();
        throw waiting("百炼 Embedding 无法连接：" + cleanError(e.message));
      }
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        const message = `百炼 Embedding HTTP ${response.status} ${cleanError(details.code || "")}: ${cleanError(details.message || "")}`;
        if ([401, 403, 404, 429, 500, 502, 503, 504].includes(response.status))
          throw waiting(message);
        throw fault(message, 502);
      }
      const body = await response.json();
      const rows = body.output?.embeddings;
      if (!Array.isArray(rows) || rows.length !== missing.length)
        throw fault("百炼返回的向量数量不一致", 502);
      for (const [j, n] of missing.entries()) {
        const vector = rows.find((r) => r.text_index === j)?.embedding;
        if (
          !Array.isArray(vector) ||
          vector.length !== config.dimension ||
          vector.some((v) => !Number.isFinite(v))
        )
          throw fault("Embedding 维数或数值无效", 502);
        vectors[n] = vector;
        signal?.throwIfAborted();
        if (cache) writeState(keys[n], vector);
      }
    }
    result.push(...vectors);
  }
  return result;
}
export async function modelJson({
  text,
  images = [],
  system,
  signal,
  models,
  runtime: injected,
}) {
  const runtime = injected || (await ModelRuntime.create());
  const available = await runtime.getAvailable();
  const candidates =
    models ||
    (images.length ? getConfig().rag.vision : [getConfig().rag.expansionModel]);
  const errors = [];
  let diagnostics;
  for (const selected of candidates) {
    const model = available.find(
      (m) => m.provider === selected.provider && m.id === selected.id,
    );
    if (!model || (images.length && !model.input?.includes("image"))) {
      errors.push(`${selected.provider}/${selected.id} 未配置或无图片输入能力`);
      continue;
    }
    const content = [
      { type: "text", text },
      ...images.map((i) => ({
        type: "image",
        data: i.data,
        mimeType: i.mimeType,
      })),
    ];
    const messages = [{ role: "user", content, timestamp: Date.now() }];
    try {
      let output = "",
        final;
      const stream = runtime.streamSimple(
        model,
        {
          systemPrompt:
            system +
            "\n只返回一个完整 JSON 对象，LaTeX 反斜杠必须按 JSON 转义。不确定的文字或数值禁止猜测，标记 uncertain=true。",
          messages,
        },
        {
          signal: AbortSignal.any([
            signal || new AbortController().signal,
            AbortSignal.timeout(240000),
          ]),
          maxTokens: Math.min(10000, model.maxTokens || 10000),
          onPayload: (payload) =>
            model.provider === "deepseek"
              ? { ...payload, response_format: { type: "json_object" } }
              : payload,
        },
      );
      for await (const event of stream) {
        if (event.type === "text_delta") output += event.delta;
        if (event.type === "done") final = event.message;
        if (event.type === "error")
          throw new Error(event.error?.errorMessage || "模型调用失败");
      }
      signal?.throwIfAborted();
      output ||=
        final?.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") || "";
      if (final?.stopReason === "length") throw new Error("模型 JSON 被截断");
      const value = parseModelJson(output);
      if (images.length)
        writeState(
          "vision-verified:" +
            digest([model.provider, model.id, model.baseUrl]),
          { model: selected, verifiedAt: new Date().toISOString() },
        );
      return { value, model: selected, usage: final?.usage };
    } catch (e) {
      signal?.throwIfAborted();
      if (e.modelDiagnostics) diagnostics = e.modelDiagnostics;
      errors.push(
        `${selected.provider}/${selected.id}: ${cleanError(e.message)}`,
      );
    }
  }
  if (diagnostics)
    throw Object.assign(fault(errors.join("；"), 422), {
      modelDiagnostics: diagnostics,
    });
  throw waiting(errors.join("；") || "请配置 Pi 模型");
}
export async function expand(chunk, context, options = {}) {
  const fingerprint = digest([
    expansionPromptVersion,
    getConfig().rag.expansionModel,
    chunk.text.replace(/\[\[(\w+):[^\]]+\]\]/g, "[[$1]]"),
    chunk.sectionPath,
    context,
  ]);
  const cached = readState("expansion:" + fingerprint, null);
  if (cached) return cached;
  let result, rejection;
  const sourceNumbers = new Set(
    (chunk.text + context).match(/\d+(?:\.\d+)?/g) || [],
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    try {
      result = await modelJson({
        ...options,
        system:
          "根据给定论文正文生成一段检索背景和四个语义不同的问题，其中两条中文、两条英文。仅使用正文和已核验背景中明确支持的事实，不补充数值或外部知识。输出的 JSON 顶层必须是 background（背景字符串）、questions（含 language 和 text 的四个问题对象）以及 unsupported（布尔值）；不要复述输入或将结果放入 format。若无法依据原文生成，设置 unsupported=true。",
        text: JSON.stringify({
          titlePath: chunk.sectionPath,
          text: chunk.text,
          verifiedContext: context,
          ...(rejection ? { validationFeedback: rejection } : {}),
          format: {
            background: "一段背景说明",
            questions: [
              { language: "zh", text: "中文问题一" },
              { language: "zh", text: "中文问题二" },
              { language: "en", text: "English question one" },
              { language: "en", text: "English question two" },
            ],
            unsupported: false,
          },
        }),
      });
      const v = result.value;
      if (
        v.unsupported !== false ||
        typeof v.background !== "string" ||
        !v.background.trim() ||
        !Array.isArray(v.questions) ||
        v.questions.length !== 4 ||
        v.questions.filter((q) => q?.language === "zh").length !== 2 ||
        v.questions.filter((q) => q?.language === "en").length !== 2 ||
        v.questions.some(
          (q) => typeof q?.text !== "string" || !q.text.trim(),
        ) ||
        new Set(v.questions.map((q) => q.text)).size !== 4
      )
        throw fault("扩写结构不合格", 422);
      if (
        (JSON.stringify(v).match(/\d+(?:\.\d+)?/g) || []).some(
          (n) => !sourceNumbers.has(n),
        )
      )
        throw fault("扩写包含来源未支持的数值", 422);
      break;
    } catch (e) {
      options.signal?.throwIfAborted();
      if (e.status !== 422) throw e;
      const diagnostics = {
        error: e.message,
        candidate: result?.value,
        ...e.modelDiagnostics,
      };
      writeState(`expansion-rejected:${fingerprint}:${attempt}`, diagnostics);
      if (attempt === 2)
        throw Object.assign(e, { modelDiagnostics: diagnostics });
      rejection = {
        reason: e.message,
        instruction:
          "重新根据原文生成完整结构；必须两条 zh、两条 en，不得新增数值或事实。",
      };
      result = null;
    }
  }
  const v = result.value;
  const saved = {
    ...v,
    fingerprint,
    model: result.model,
    promptVersion: expansionPromptVersion,
  };
  options.signal?.throwIfAborted();
  writeState("expansion:" + fingerprint, saved);
  return saved;
}
