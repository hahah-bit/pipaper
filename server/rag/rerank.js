import { getConfig } from "../config.js";
import { embeddingKey, waiting, cleanError } from "./providers.js";
import { boundedText } from "./retrieval.js";

export function rerankUrl(config, embedding = getConfig().rag.embedding) {
  if (config.url) return config.url;
  const url = new URL(embedding.url);
  const modern = config.model === "qwen3-rerank";
  url.pathname = modern
    ? "/compatible-api/v1/reranks"
    : "/api/v1/services/rerank/text-rerank/text-rerank";
  url.search = "";
  url.hash = "";
  return url.toString();
}
export async function rerank(
  query,
  documents,
  {
    config = getConfig().rag.rerank,
    key = process.env.PIPAPER_RERANK_API_KEY || embeddingKey(),
    fetchImpl = fetch,
    signal,
  } = {},
) {
  if (!key) throw waiting("请配置百炼重排凭据，可复用服务端 Embedding 凭据");
  if (!documents.length) return [];
  const texts = documents.map((t) => boundedText(t, 7500));
  const instruct =
    "Given a research question, retrieve passages that provide direct evidence answering the question. Do not prefer unsupported summaries over primary evidence.";
  const body =
    config.model === "qwen3-rerank"
      ? {
          model: config.model,
          query,
          documents: texts,
          top_n: texts.length,
          instruct,
        }
      : {
          model: config.model,
          input: { query, documents: texts },
          parameters: { top_n: texts.length, instruct },
        };
  let response;
  try {
    response = await fetchImpl(rerankUrl(config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(config.timeoutMs),
      ]),
    });
  } catch (e) {
    signal?.throwIfAborted();
    throw waiting("百炼重排连接失败：" + cleanError(e.message));
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && /free quota|free tier/i.test(payload.message || ""))
    throw waiting(
      `百炼 ${config.model} 的免费额度已用完且开启了“用完即停”，请在额度管理中关闭该模型的开关后重试`,
    );
  if (!response.ok)
    throw waiting(
      `百炼重排 HTTP ${response.status}：${cleanError(payload.message || payload.code || "请求失败")}`,
    );
  const rows = payload.results || payload.output?.results;
  if (
    !Array.isArray(rows) ||
    rows.length !== texts.length ||
    new Set(rows.map((r) => r.index)).size !== texts.length ||
    rows.some(
      (r) =>
        !Number.isInteger(r.index) ||
        r.index < 0 ||
        r.index >= texts.length ||
        !Number.isFinite(r.relevance_score) ||
        r.relevance_score < 0 ||
        r.relevance_score > 1,
    )
  )
    throw waiting("百炼重排返回的索引或分数无效");
  return rows.map((r) => ({
    index: r.index,
    score: r.relevance_score,
    model: config.model,
  }));
}
