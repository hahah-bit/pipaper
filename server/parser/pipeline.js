import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { parseMineru } from "./mineru.js";
import { parseUnstructured, mapElements } from "./unstructured.js";
import { parseFallbackText } from "./fallback.js";
import { mdToBlocks } from "./mdblocks.js";
import { extractAlgorithmBlocks, replaceAlgorithmBlocks } from "./algorithms.js";
import { readNative, reconcileNative, buildDocument, validBox } from "./document.js";
import { jsonWrite, versionDir } from "./versions.js";

const caption = (v) => Array.isArray(v) ? v.join("\n") : String(v || "");
const chrome = new Set(["header", "footer", "page_number", "aside_text"]);
export function mineruBlocks(raw, native, asset) {
  let entries = raw.contentList;
  if (!Array.isArray(entries) || entries.some((e) => Array.isArray(e) || !Number.isInteger(e.page_idx) && typeof e.content === "object")) {
    entries = raw.middleJson?.pdf_info?.flatMap((p, page_idx) => (p.para_blocks || p.preproc_blocks || []).map((b) => {
      const spans = (b.lines || []).flatMap((l) => l.spans || []);
      return { type: b.type === "title" ? "text" : b.type, text_level: b.type === "title" ? 1 : 0, text: spans.map((s) => s.type === "inline_equation" ? `$${s.content}$` : s.content || "").join(" "), page_idx, bbox: b.bbox?.map((x, i) => x * 1000 / (p.page_size?.[i % 2] || (i % 2 ? native.pages[page_idx].height : native.pages[page_idx].width))), table_body: spans.find((s) => s.html)?.html, img_path: spans.find((s) => s.image_path)?.image_path };
    }));
  }
  if (!entries?.length) return mdToBlocks(raw.md || "").map((b, i) => ({ ...b, provenance: { engine: "mineru", sourceIndex: i }, issues: ["missing-structured-source"] }));
  return entries.flatMap((e, sourceIndex) => {
    if (chrome.has(e.type)) return [];
    const page = Number.isInteger(e.page_idx) ? e.page_idx + 1 : null;
    const p = native.pages[page - 1];
    const bbox = p && e.bbox?.length === 4 ? e.bbox.map((v, i) => v / 1000 * (i % 2 ? p.height : p.width)) : null;
    const base = { page, bbox, provenance: { engine: "mineru", sourceIndex, rawRef: `contentList/${sourceIndex}`, coordinateSystem: "pdf-points" } };
    const text = String(e.text || "");
    if (e.type === "text" || e.type === "para" || e.type === "page_footnote") return [{ ...base, ...(e.text_level ? { type: "heading", text, level: e.text_level } : { type: "para", md: text }) }];
    if (e.type === "list") return [{ ...base, type: "para", md: (e.list_items || []).join("\n\n") || text }];
    if (e.type === "equation" || e.type === "interline_equation") return [{ ...base, type: "formula", latex: text.replace(/^\s*\$\$?|\$\$?\s*$/g, "") }];
    if (e.type === "table") return [{ ...base, type: "table", html: e.table_body || "", md: text, caption: caption(e.table_caption), sourceImage: asset(e.img_path || e.img) }];
    if (["image", "chart"].includes(e.type)) return [{ ...base, type: "image", src: asset(e.img_path || e.img || e.image_path), caption: caption(e.image_caption || e.chart_caption), content: e.content || null }];
    if (e.type === "code") return [{ ...base, type: "code", text: e.code_body || text, lang: "text", caption: caption(e.code_caption), algorithm: e.sub_type === "algorithm" }];
    return [{ ...base, type: "para", md: text, issues: ["unsupported-source-type"] }];
  });
}

function positionedUnstructured(blocks, native, saveImage) {
  return blocks.map((original) => {
    const b = structuredClone(original);
    const p = native.pages[b.page - 1];
    const [w, h] = b.coordinateSize || [];
    if (p && validBox(b) && w > 0 && h > 0) b.bbox = b.bbox.map((v, i) => v * (i % 2 ? p.height / h : p.width / w));
    else if (validBox(b)) { b.bbox = null; b.issues = ["unknown-coordinate-system"]; }
    if (b.b64) { b.src = saveImage(Buffer.from(b.b64, "base64")); delete b.b64; }
    return b;
  });
}

export async function executePipeline(paper, engine, run, log, replayFrom) {
  const cfg = getConfig().parse;
  const native = await readNative(paper.pdfPath);
  jsonWrite(path.join(run.dir, "raw", "native.json"), native);
  log(`本地坐标基准：${native.pages.length} 页`);
  const engines = ["pdfjs"];
  let imageId = 0;
  const saveImage = (buf, suffix = "png") => {
    const name = `asset-${++imageId}.${suffix}`;
    fs.writeFileSync(path.join(run.dir, "assets", name), buf);
    return `file/versions/${run.id}/assets/${name}`;
  };
  const replayDir = replayFrom ? versionDir(paper.id, replayFrom) : null;
  const source = async (name) => {
    const rawFile = replayDir && path.join(replayDir, "raw", name + ".json");
    if (name === "mineru") {
      let raw;
      let assets;
      if (rawFile && fs.existsSync(rawFile)) {
        raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
        assets = new Map(Object.entries(raw.assetFiles || {}).map(([key, file]) => [key, fs.readFileSync(path.join(replayDir, "assets", path.basename(file)))]));
        log("重放已保存的 MinerU 原始输出");
      } else {
        if (replayDir) throw new Error("此版本没有 MinerU 原始输出");
        const result = await parseMineru(paper.pdfPath, cfg.mineru, log);
        raw = { md: result.md, contentList: result.contentList, middleJson: result.middleJson, adapterVersion: 1, parameters: { enable_formula: true, enable_table: true, language: "en", is_ocr: true } };
        assets = result.assets;
      }
      const assetFiles = {};
      const assetUrls = {};
      for (const [key, buf] of assets) {
        const url = saveImage(buf, path.extname(key).slice(1) || "png");
        assetFiles[key] = path.basename(url);
        assetUrls[key] = url;
      }
      raw.assetFiles = assetFiles;
      jsonWrite(path.join(run.dir, "raw", "mineru.json"), raw);
      engines.push("mineru");
      return mineruBlocks(raw, native, (src) => src ? assetUrls[String(src).split(/[\\/]/).pop()] || "" : "");
    }
    if (name === "unstructured") {
      let blocks;
      if (rawFile && fs.existsSync(rawFile)) {
        const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
        jsonWrite(path.join(run.dir, "raw", name + ".json"), raw);
        blocks = mapElements(raw);
      } else {
        if (replayDir) throw new Error("此版本没有 unstructured 原始输出");
        blocks = await parseUnstructured(paper.pdfPath, cfg.unstructured, log, (raw) => jsonWrite(path.join(run.dir, "raw", "unstructured.json"), raw));
      }
      engines.push(name);
      return positionedUnstructured(blocks, native, saveImage);
    }
    const { blocks } = await parseFallbackText(paper.pdfPath, {}, log);
    jsonWrite(path.join(run.dir, "raw", "fallback.json"), blocks);
    engines.push("fallback");
    return blocks.map((b, i) => ({ ...b, provenance: { engine: "pdfjs", sourceIndex: i } }));
  };
  const configured = (name) => cfg[name]?.mode === "local" || cfg[name]?.mode === "api" && Boolean(cfg[name].token || cfg[name].apiKey);
  let blocks;
  const events = [];
  if (engine === "hybrid") {
    const primary = replayDir
      ? ["mineru", "unstructured", "fallback"].find((name) => fs.existsSync(path.join(replayDir, "raw", name + ".json"))) || "fallback"
      : configured("mineru") ? "mineru" : configured("unstructured") ? "unstructured" : "fallback";
    try { blocks = await source(primary); }
    catch (e) {
      if (replayDir) throw e;
      events.push({ code: "engine-failed", engine: primary, message: String(e.message).slice(0, 180) });
      log(`${primary} 失败，尝试替代来源`);
      blocks = await source(primary === "mineru" && configured("unstructured") ? "unstructured" : "fallback");
    }
    blocks = reconcileNative(blocks, native);
    const missingPages = native.pages.filter((p) => p.items.length > 10 && !blocks.some((b) => b.page === p.page));
    if (missingPages.length && !engines.includes("unstructured") && (replayDir ? fs.existsSync(path.join(replayDir, "raw", "unstructured.json")) : configured("unstructured"))) {
      try {
        const secondary = await source("unstructured");
        jsonWrite(path.join(run.dir, "raw", "secondary-blocks.json"), secondary);
        const numbers = new Set(missingPages.map((p) => p.page));
        blocks.push(...reconcileNative(secondary.filter((b) => numbers.has(b.page)), native));
        blocks.sort((a, b) => (a.page || Infinity) - (b.page || Infinity));
        events.push({ code: "secondary-pages", pages: [...numbers] });
      } catch (e) { events.push({ code: "secondary-failed", message: String(e.message).slice(0, 180) }); }
    }
    const algorithms = await extractAlgorithmBlocks(paper.pdfPath, log, native);
    jsonWrite(path.join(run.dir, "raw", "algorithms.json"), algorithms);
    blocks = replaceAlgorithmBlocks(blocks, algorithms);
    log(`结构融合完成：${blocks.length} 块，${algorithms.length} 个算法区域`);
  } else blocks = await source(engine);
  if (engines.includes("fallback")) events.push({ code: "degraded-text-only", message: "本次使用本地文字提取，公式和复杂结构需要核对原文" });
  const doc = buildDocument(blocks, native, { engine, engines, pipelineVersion: 4, replayFrom: replayFrom || null, sourceHash: paper.contentHash, finishedAt: new Date().toISOString(), events });
  doc.quality.warnings.push(...events);
  return doc;
}
