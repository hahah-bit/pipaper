// 待读清单（to-read）：检索结果的元数据暂存，不下载 PDF。
// 用户在清单里显式点“加入项目”时才走 /api/search/import 下载入库。
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const FILE = path.join(DATA_DIR, "to-read.json");
const MAX = 200;
let entries = [];

function load() {
  try {
    entries = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    entries = [];
  }
}
load();

function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(entries, null, 1));
  } catch {}
}

function keyOf(e) {
  const doi = String(e.doi || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
  return doi ? "doi:" + doi : "title:" + String(e.title || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// 只保留展示/导入所需字段，避免把整份响应塞进清单
function pick(e) {
  return {
    title: String(e.title || "").trim().slice(0, 400),
    authors: (e.authors || []).slice(0, 12),
    year: e.year || null,
    doi: e.doi || "",
    venue: e.venue || "",
    citations: e.citations ?? null,
    quartile: e.quartile || null,
    oa: !!e.oa,
    pdfUrl: e.pdfUrl || "",
    url: e.url || "",
    abstract: String(e.abstract || "").slice(0, 2000),
    keywords: (e.keywords || []).slice(0, 8),
    sources: (e.sources || []).slice(0, 5),
  };
}

export function toreadAdd(entry) {
  const e = pick(entry);
  if (!e.title) return { ok: false, reason: "无标题" };
  const key = keyOf(e);
  const dup = entries.find((x) => keyOf(x) === key);
  if (dup) {
    // 只补充新拿到的字段，不清空已有值（如先加了带 pdfUrl 的，再遇到同文无 pdf 的）
    for (const [k, v] of Object.entries(pick(e))) {
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      dup[k] = v;
    }
    dup.addedAt = Date.now();
    persist();
    return { ok: true, entry: dup, dup: true };
  }
  e.id = "tr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  e.addedAt = Date.now();
  entries.unshift(e);
  if (entries.length > MAX) entries.length = MAX;
  persist();
  return { ok: true, entry: e, dup: false };
}

export function toreadList() {
  return entries;
}

export function toreadDelete(id) {
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  persist();
  return entries.length < before;
}
