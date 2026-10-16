import { writeFile as managedWrite, readJsonState, writeJsonState, trashPath, registerFile } from "./storage/files.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.PIPAPER_DATA_DIR ? path.resolve(process.env.PIPAPER_DATA_DIR) : path.join(APP_ROOT, "data");
export const LIBRARY_DIR = process.env.PIPAPER_LIBRARY_DIR ? path.resolve(process.env.PIPAPER_LIBRARY_DIR) : path.join(APP_ROOT, "library");
export const PARSED_DIR = path.join(DATA_DIR, "parsed");
export const TMP_DIR = path.join(DATA_DIR, "tmp");
export const PUBLIC_DIR = path.join(APP_ROOT, "public");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const DEFAULTS = {
  port: 4318,
  zotero: {
    enabled: true,
    dataDir: "", // auto-detect if empty
  },
  parse: {
    engineOrder: ["mineru", "unstructured", "fallback"],
    mineru: { mode: "off", token: "", cmd: "mineru", apiBase: "https://mineru.net" },
    unstructured: { mode: "off", apiKey: "", url: "https://api.unstructured.io" },
  },
  translate: { model: { provider: "zai-coding-cn", id: "glm-4.7" } },
  chat: { thinkingLevel: "high" },
  archify: { path: "" }, // Reuse an existing upstream repository / skill directory.
  topicAnalysis: { openalexApiKey: "" },
  rag: {
    vision: [{ provider: "zai-coding-cn", id: "glm-4.6v" }, { provider: "deepseek", id: "deepseek-v4-flash-vision-exp" }],
    expansionModel: { provider: "deepseek", id: "deepseek-v4-flash" },
    embedding: { url: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding", model: "text-embedding-v4", dimension: 1024 },
    milvus: { address: "127.0.0.1:19530", collectionPrefix: "pipaper" },
    chunk: { targetBytes: 4500, maxBytes: 6000, overlapBytes: 300 },
    expansion: true,
    retrieval: { selfRag: true, model: { provider: "deepseek", id: "deepseek-v4-flash" }, maxQueries: 4, candidates: 60, rerankCandidates: 32, maxRounds: 2, similarityThreshold: 0.9, mmrLambda: 0.85 },
    rerank: { enabled: true, model: "qwen3.7-text-rerank", url: "", timeoutMs: 30000 },
  },
  setup: { onboardedAt: null }, // 首次引导面板「不再显示」后写入时间戳
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!extra || typeof extra !== "object") return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

for (const d of [DATA_DIR, LIBRARY_DIR, PARSED_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

let cfg = DEFAULTS;
try {
  const raw = readJsonState(CONFIG_FILE, DEFAULTS);
  cfg = deepMerge(DEFAULTS, raw);
} catch {
  cfg = deepMerge(DEFAULTS, {});
  writeJsonState(CONFIG_FILE, cfg);
}

export function getConfig() {
  return cfg;
}

export function saveConfig(patch) {
  const next=deepMerge(cfg,patch||{});
  if(patch?.translate && (typeof next.translate.model?.provider !== "string" || !next.translate.model.provider.trim() || typeof next.translate.model?.id !== "string" || !next.translate.model.id.trim()))throw Object.assign(new Error("翻译模型配置无效"),{status:422});
  if(patch?.rag){
    const secretKeys=value=>value&&typeof value==="object"&&Object.entries(value).some(([k,v])=>/^(apiKey|token|secret|password|authorization)$/i.test(k)||secretKeys(v));
    if(secretKeys(patch.rag))throw Object.assign(new Error("RAG 密钥只能保存在服务端凭据中"),{status:422});
    const rag=next.rag,c=rag.chunk,e=rag.embedding;
    let url;try{url=new URL(e.url);}catch{}
    if(!url||!["http:","https:"].includes(url.protocol)||url.username||url.password||!Number.isInteger(e.dimension)||e.dimension<1||e.dimension>32768||typeof e.model!=="string"||!e.model.trim())throw Object.assign(new Error("Embedding 配置无效"),{status:422});
    if(!Number.isInteger(c.targetBytes)||!Number.isInteger(c.maxBytes)||!Number.isInteger(c.overlapBytes)||c.targetBytes<256||c.maxBytes>6000||c.targetBytes>c.maxBytes||c.overlapBytes<0||c.overlapBytes>300||c.overlapBytes>=c.targetBytes)throw Object.assign(new Error("分块预算无效：上限 6000 字节，重叠最多 300 字节"),{status:422});
    if(typeof rag.expansion!=="boolean"||!Array.isArray(rag.vision)||!rag.vision.length||rag.vision.some(m=>!m.provider||!m.id)||!rag.expansionModel?.provider||!rag.expansionModel?.id||!rag.milvus?.address||!/^[a-zA-Z][\w]{0,80}$/.test(rag.milvus.collectionPrefix))throw Object.assign(new Error("模型或 Milvus 配置无效"),{status:422});
    const t=rag.retrieval, rr=rag.rerank;
    if(!t||typeof t.selfRag!=="boolean"||!t.model?.provider||!t.model?.id||!Number.isInteger(t.maxQueries)||t.maxQueries<1||t.maxQueries>5||!Number.isInteger(t.candidates)||t.candidates<10||t.candidates>120||!Number.isInteger(t.rerankCandidates)||t.rerankCandidates<5||t.rerankCandidates>60||!Number.isInteger(t.maxRounds)||t.maxRounds<1||t.maxRounds>2||!Number.isFinite(t.similarityThreshold)||t.similarityThreshold<.7||t.similarityThreshold>1||!Number.isFinite(t.mmrLambda)||t.mmrLambda<.5||t.mmrLambda>1)throw Object.assign(new Error("检索预算或模型配置无效"),{status:422});
    let rerankUrl;try{rerankUrl=rr.url?new URL(rr.url):null;}catch{throw Object.assign(new Error("重排地址无效"),{status:422});}
    if(typeof rr.enabled!=="boolean"||!rr.model?.trim()||!Number.isInteger(rr.timeoutMs)||rr.timeoutMs<1000||rr.timeoutMs>60000||rerankUrl&&(!["http:","https:"].includes(rerankUrl.protocol)||rerankUrl.username||rerankUrl.password))throw Object.assign(new Error("重排配置无效"),{status:422});
  }
  cfg = next;
  writeJsonState(CONFIG_FILE, cfg);
  return cfg;
}

export function redactedConfig() {
  const clone = JSON.parse(JSON.stringify(cfg));
  const mask = (s) => (s ? (s.length <= 6 ? "***" : s.slice(0, 3) + "***" + s.slice(-3)) : "");
  if (clone.parse?.mineru?.token) clone.parse.mineru.token = mask(clone.parse.mineru.token);
  if (clone.parse?.unstructured?.apiKey) clone.parse.unstructured.apiKey = mask(clone.parse.unstructured.apiKey);
  if (clone.topicAnalysis?.openalexApiKey) clone.topicAnalysis.openalexApiKey = mask(clone.topicAnalysis.openalexApiKey);
  return clone;
}
