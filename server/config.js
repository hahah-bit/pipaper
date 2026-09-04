import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.PIPAPER_DATA_DIR ? path.resolve(process.env.PIPAPER_DATA_DIR) : path.join(APP_ROOT, "data");
export const LIBRARY_DIR = path.join(APP_ROOT, "library");
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
  translate: { url: "http://localhost:5001" },
  chat: { thinkingLevel: "high" },
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
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  cfg = deepMerge(DEFAULTS, raw);
} catch {
  cfg = deepMerge(DEFAULTS, {});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export function getConfig() {
  return cfg;
}

export function saveConfig(patch) {
  cfg = deepMerge(cfg, patch || {});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

export function redactedConfig() {
  const clone = JSON.parse(JSON.stringify(cfg));
  const mask = (s) => (s ? (s.length <= 6 ? "***" : s.slice(0, 3) + "***" + s.slice(-3)) : "");
  if (clone.parse?.mineru?.token) clone.parse.mineru.token = mask(clone.parse.mineru.token);
  if (clone.parse?.unstructured?.apiKey) clone.parse.unstructured.apiKey = mask(clone.parse.unstructured.apiKey);
  return clone;
}
