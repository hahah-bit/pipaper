import { createFile, writeFile as managedWrite, trashPath } from "../storage/files.js";
import { resourceAt } from "../storage/catalog.js";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const file = () => path.join(DATA_DIR, "topic-analysis", "cas-table.json");
const norm = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
const ISSNS = /\b\d{4}-\d{3}[\dXx]\b/g;

// RFC4180 风格解析：支持引号内的逗号、换行与转义引号，容忍 CRLF 与 BOM。
export function parseCsv(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(v => v.trim() !== "")) rows.push(row); }
  return rows;
}

function mapColumns(headers) {
  const find = (positive, negative = []) => headers.findIndex(h => positive.some(p => p.test(h)) && !negative.some(p => p.test(h)));
  const cols = {
    nameEn: find([/英文刊名|英文标题|journal name|journal title|^title$/i]),
    name: find([/期刊名|刊物名|刊名|journal/i], [/英文/]),
    issn: find([/issn/i], [/e-?issn/i]),
    eissn: find([/e-?issn|电子.*issn/i]),
    category: find([/大类学科|^大类$|学科分类|major category|category/i], [/分区|小类/]),
    zone: find([/大类分区|分区|zone|quartile/i], [/小类/]),
    top: find([/^是否\s*top|top\s*期刊|顶尖|^top$/i]),
    year: find([/年份|出版年|^year$|^edition$/i]),
  };
  if (cols.nameEn < 0 && cols.name >= 0) { cols.nameEn = cols.name; cols.name = -1; }
  return cols;
}

function parseZone(raw) {
  const m = String(raw || "").trim().match(/([1-4])\s*区?|([一二三四])\s*区/);
  return m ? (m[1] ? Number(m[1]) : "一二三四".indexOf(m[2]) + 1) : null;
}

export function importCsv(csv, { edition, fileName } = {}) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw fault("CSV 内容为空或只有表头");
  const headers = rows[0].map(h => String(h).trim());
  const cols = mapColumns(headers);
  const nameCol = cols.nameEn >= 0 ? cols.nameEn : cols.name;
  if (nameCol < 0) throw fault("未识别出期刊名列：表头需包含“英文刊名”或“期刊名称”");
  if (cols.zone < 0) throw fault("未识别出分区列：表头需包含“大类分区”或“分区”");
  const columnYear = cols.year >= 0 ? Number(rows.slice(1).find(r => Number(r[cols.year]))?.[cols.year]) : NaN;
  const year = Number(edition) || (Number.isFinite(columnYear) ? columnYear : new Date().getUTCFullYear() - 1);
  if (!(year >= 2004 && year <= new Date().getUTCFullYear())) throw fault("版本年份无效，应为 2004 至今年份");
  const seen = new Set(), parsed = [];
  for (const r of rows.slice(1)) {
    const name = String(r[nameCol] || "").trim();
    const zone = parseZone(r[cols.zone]);
    if (!name || !zone || seen.has(`${norm(name)}|${zone}`)) continue;
    const issns = [...new Set([cols.issn >= 0 ? String(r[cols.issn] || "").match(ISSNS) || [] : [],
      cols.eissn >= 0 ? String(r[cols.eissn] || "").match(ISSNS) || [] : []].flat().map(s => s.toUpperCase()))];
    seen.add(`${norm(name)}|${zone}`);
    parsed.push({ name, issns, category: cols.category >= 0 ? String(r[cols.category] || "").trim() : "", zone, top: cols.top >= 0 && /top|yes|true|^是$/i.test(String(r[cols.top] || "")) });
  }
  if (parsed.length < 50) throw fault(`仅解析出 ${parsed.length} 条有效期刊记录（需 ≥50 条）。请确认文件为分区表整表导出，且包含刊名与分区列。`);
  const table = { edition: year, importedAt: new Date().toISOString(), fileName: String(fileName || "导入 CSV").slice(0, 120), count: parsed.length, rows: parsed };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const previous=resourceAt(file());
  (previous&&previous.lifecycle!=="active"?createFile:managedWrite)(file(), JSON.stringify(table),{kind:"reference-data"});
  cache = null; checkedAt = 0;
  return status();
}

export function clear() {
  if(fs.existsSync(file()))trashPath(file(),{kind:"reference-data"});
  cache = null; checkedAt = 0;
  return status();
}

export function status() {
  try {
    const t = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { imported: true, edition: t.edition, count: t.count, importedAt: t.importedAt, fileName: t.fileName };
  } catch { return { imported: false }; }
}

let cache = null, checkedAt = 0;
function load() {
  if (Date.now() - checkedAt < 5000) return cache;
  checkedAt = Date.now();
  try {
    const t = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (cache?.importedAt !== t.importedAt) {
      const byIssn = new Map(), byName = new Map();
      for (const row of t.rows) {
        for (const i of row.issns) if (!byIssn.has(i)) byIssn.set(i, row);
        const n = norm(row.name); if (n && !byName.has(n)) byName.set(n, row);
      }
      cache = { edition: t.edition, importedAt: t.importedAt, byIssn, byName };
    }
  } catch { cache = null; }
  return cache;
}

// ISSN 精确匹配优先，规范化刊名兜底；未导入或未命中返回 null。
export function lookup(issns, name) {
  const t = load(); if (!t) return null;
  const row = (issns || []).map(s => String(s).toUpperCase()).map(i => t.byIssn.get(i)).find(Boolean)
    || (name ? t.byName.get(norm(name)) : null);
  return row ? { ...row, edition: t.edition } : null;
}
