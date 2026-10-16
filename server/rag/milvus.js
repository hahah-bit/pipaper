import { MilvusClient, DataType, FunctionType } from "@zilliz/milvus2-sdk-node";
import { getConfig } from "../config.js";
import {
  digest,
  readState,
  writeState,
  generations,
} from "../storage/catalog.js";
import { waiting } from "./providers.js";

const checked = (response) => {
  const status = response?.status || response;
  if (
    (status?.error_code && !["Success", 0, "0"].includes(status.error_code)) ||
    (status?.code && Number(status.code) !== 0)
  )
    throw new Error(status.reason || status.error_code || "Milvus 操作失败");
  return response;
};
const names = (cfg) => {
  const prefix = String(cfg.milvus.collectionPrefix).replace(
    /[^a-zA-Z0-9_]/g,
    "_",
  );
  const suffix = digest(cfg.embedding).slice(0, 12);
  return [`${prefix}_chunks_${suffix}`, `${prefix}_elements_${suffix}`];
};
export class VectorIndex {
  constructor({ client, config = getConfig().rag } = {}) {
    this.config = config;
    this.client =
      client ||
      new MilvusClient({
        address: config.milvus.address,
        token: process.env.MILVUS_TOKEN,
        timeout: 12000,
      });
    this.collections = names(config);
    this.initialized = false;
  }
  async ready() {
    if (this.initialized) return;
    try {
      const health = await this.client.checkHealth();
      if (!health.isHealthy) throw new Error("服务尚未就绪");
      for (const collection_name of this.collections) {
        const exists = await this.client.hasCollection({ collection_name });
        if (!exists.value) {
          const string = (name, length = 256, extra = {}) => ({
            name,
            data_type: DataType.VarChar,
            max_length: length,
            ...extra,
          });
          checked(
            await this.client.createCollection({
              collection_name,
              consistency_level: "Strong",
              fields: [
                string("id", 128, { is_primary_key: true }),
                string("resource_id"),
                string("generation_id", 128),
                string("canonical_id", 128),
                string("variant", 32),
                string("source_type", 32),
                string("kind", 32),
                string("text", 65535, {
                  enable_analyzer: true,
                  analyzer_params: {
                    tokenizer: "jieba",
                    filter: ["lowercase"],
                  },
                }),
                {
                  name: "dense_vector",
                  data_type: DataType.FloatVector,
                  dim: this.config.embedding.dimension,
                },
                {
                  name: "sparse_vector",
                  data_type: DataType.SparseFloatVector,
                },
              ],
              functions: [
                {
                  name: "text_bm25",
                  type: FunctionType.BM25,
                  input_field_names: ["text"],
                  output_field_names: ["sparse_vector"],
                },
              ],
            }),
          );
        }
        checked(
          await this.client.createIndex({
            collection_name,
            field_name: "dense_vector",
            index_type: "AUTOINDEX",
            metric_type: "COSINE",
          }),
        );
        checked(
          await this.client.createIndex({
            collection_name,
            field_name: "sparse_vector",
            index_type: "SPARSE_INVERTED_INDEX",
            metric_type: "BM25",
          }),
        );
        checked(await this.client.loadCollectionSync({ collection_name }));
      }
      // This actual server check validates both languages rather than assuming tokenization.
      for (const text of ["图像分割研究", "semantic image segmentation"]) {
        const result = await this.client.runAnalyzer({
          text: [text],
          analyzer_params: { tokenizer: "jieba", filter: ["lowercase"] },
        });
        if (!result.results?.[0]?.tokens?.length)
          throw new Error("中英文分词验证失败");
      }
      this.initialized = true;
    } catch (e) {
      throw waiting("Milvus 未就绪：" + e.message);
    }
  }
  async write(generation, rows, { signal, onBatch } = {}) {
    await this.ready();
    for (const [
      collectionIndex,
      collection_name,
    ] of this.collections.entries()) {
      const data = rows.filter(
        (r) => (r.kind === "chunk" ? 0 : 1) === collectionIndex,
      );
      for (let offset = 0; offset < data.length; offset += 50) {
        signal?.throwIfAborted();
        const batch = data.slice(offset, offset + 50),
          key =
            "index-batch:" +
            digest([collection_name, generation.id, batch.map((r) => r.id)]);
        if (readState(key, null)?.status === "succeeded") {
          const found = checked(
            await this.client.query({
              collection_name,
              expr: `id in ${JSON.stringify(batch.map((r) => r.id))}`,
              output_fields: ["count(*)"],
              consistency_level: "Strong",
            }),
          );
          if (Number(found.data?.[0]?.["count(*)"]) === batch.length) continue;
        }
        writeState(key, { status: "pending", count: batch.length });
        try {
          checked(await this.client.upsert({ collection_name, data: batch }));
        } catch (e) {
          throw waiting("Milvus 批次写入失败：" + e.message);
        }
        signal?.throwIfAborted();
        writeState(key, { status: "succeeded", count: batch.length });
        onBatch?.(offset + batch.length, data.length);
      }
      checked(
        await this.client.flushSync({ collection_names: [collection_name] }),
      );
      const count = checked(
        await this.client.query({
          collection_name,
          expr: `generation_id == ${JSON.stringify(generation.id)}`,
          output_fields: ["count(*)"],
          consistency_level: "Strong",
        }),
      );
      const actual = Number(count.data?.[0]?.["count(*)"]);
      if (actual !== data.length)
        throw new Error(
          `Milvus 索引校验失败：期望 ${data.length}，实际 ${actual}`,
        );
    }
  }
  async search(query, vector, options = {}) {
    const routes = await this.searchRoutes(query, vector, options);
    if (routes.some((r) => r.error))
      throw waiting(routes.find((r) => r.error).error);
    return routes.map((r) => r.hits);
  }
  async searchRoutes(
    query,
    vector,
    { generationIds, sourceType, elementType, limit = 50 } = {},
  ) {
    if (!generationIds?.length) return [];
    await this.ready();
    let expr = `generation_id in ${JSON.stringify(generationIds)}`;
    if (sourceType) expr += ` and source_type == ${JSON.stringify(sourceType)}`;
    if (elementType) expr += ` and kind == ${JSON.stringify(elementType)}`;
    const output_fields = [
      "id",
      "resource_id",
      "generation_id",
      "canonical_id",
      "variant",
      "source_type",
      "kind",
      "text",
    ];
    const requests = [];
    for (const collection_name of elementType
      ? [this.collections[1]]
      : this.collections) {
      for (const [anns_field, data, metric_type] of [
        ["dense_vector", [vector], "COSINE"],
        ["sparse_vector", [query], "BM25"],
      ]) {
        requests.push(
          (async () => {
            try {
              const response = checked(
                await this.client.search({
                  collection_name,
                  anns_field,
                  data,
                  metric_type,
                  expr,
                  limit,
                  output_fields,
                  consistency_level: "Strong",
                }),
              );
              return {
                name: `${collection_name === this.collections[0] ? "body" : "elements"}-${metric_type === "COSINE" ? "dense" : "bm25"}`,
                hits: response.results || [],
              };
            } catch (e) {
              return {
                name: `${collection_name === this.collections[0] ? "body" : "elements"}-${metric_type === "COSINE" ? "dense" : "bm25"}`,
                hits: [],
                error: "Milvus 检索失败：" + e.message,
              };
            }
          })(),
        );
      }
    }
    return Promise.all(requests);
  }
  async removeResource(id) {
    await this.ready();
    for (const collection_name of this.collections)
      checked(
        await this.client.delete({
          collection_name,
          filter: `resource_id == ${JSON.stringify(id)}`,
        }),
      );
  }
  async contains(generation) {
    await this.ready();
    for (const [i, collection_name] of this.collections.entries()) {
      const response = checked(
        await this.client.query({
          collection_name,
          expr: `generation_id == ${JSON.stringify(generation.id)}`,
          output_fields: ["count(*)"],
          consistency_level: "Strong",
        }),
      );
      const count = Number(response.data?.[0]?.["count(*)"]),
        expected = generation.indexCounts?.[i];
      if (expected != null ? count !== expected : i === 0 && count < 1)
        return false;
    }
    return true;
  }
  async close() {
    await this.client.closeConnection();
  }
}
const indexes = new Map();
export const vectorIndex = (config = getConfig().rag) => {
  const fingerprint = digest([config.embedding, config.milvus]);
  if (!indexes.has(fingerprint))
    indexes.set(fingerprint, new VectorIndex({ config }));
  return indexes.get(fingerprint);
};
export async function removeResourceIndexes(id) {
  const configs = new Map(
    generations(id).map((g) => [
      digest([g.config.embedding, g.config.milvus]),
      g.config,
    ]),
  );
  for (const cfg of configs.values()) await vectorIndex(cfg).removeResource(id);
}
export function rrf(lists, { limit = 10, valid = () => true, k = 60 } = {}) {
  const fused = new Map();
  for (const list of lists) {
    const seen = new Set();
    let rank = 0;
    for (const hit of list) {
      if (!valid(hit)) continue;
      const key = hit.canonical_id;
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      const row = fused.get(key) || { ...hit, score: 0 };
      row.score += 1 / (k + rank);
      fused.set(key, row);
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
