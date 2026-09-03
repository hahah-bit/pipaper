import fs from "node:fs";

// unstructured.io engine: same payload shape for the hosted API and a local
// unstructured-api container (POST /general/v0/general).
// Returns block[] directly (element-level mapping).

const GROUPS = {
  Title: "heading",
  NarrativeText: "para",
  Text: "para",
  Paragraph: "para",
  List: "para",
  BulletedListItem: "para",
  Table: "table",
  Image: "image",
  Formula: "formula",
  Equation: "formula",
  Address: "para",
  Abstract: "para",
  UncategorizedText: "para",
  PageNumber: null,
  Header: null,
  Footer: null,
  Caption: "caption",
};

export async function parseUnstructured(pdfPath, cfg, log = () => {}) {
  const apiKey = cfg.apiKey;
  const base = (cfg.url || "https://api.unstructured.io").replace(/\/$/, "");
  if (cfg.mode === "api" && !apiKey) throw new Error("unstructured API key 未配置（设置 → 解析 → unstructured）");

  log(`上传到 ${base}（hi_res 策略，含图片/表格/公式坐标）…`);
  const fd = new FormData();
  fd.append("files", new Blob([new Uint8Array(fs.readFileSync(pdfPath))], { type: "application/pdf" }), path.basename(pdfPath));
  fd.append("strategy", "hi_res");
  fd.append("coordinates", "true");
  fd.append("include_page_breaks", "true");
  fd.append("output_formats", JSON.stringify(["json"]));
  fd.append("parameters", JSON.stringify({ include_image_base64: true }));
  if (apiKey) fd.append("unstructured_api_key", apiKey);

  const res = await fetch(`${base}/general/v0/general`, { method: "POST", body: fd });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`unstructured 失败 HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  log("解析完成，整理元素…");
  const json = await res.json();
  return mapElements(json);
}

export function mapElements(elements) {
  const blocks = [];
  let imgN = 0;
  for (const el of elements || []) {
    const cat = el.type;
    const kind = GROUPS[cat] ?? "para";
    if (kind === null) continue;
    const meta = el.metadata || {};
    const page = meta.page_number;
    const pageField = page != null ? { page } : {};
    if (kind === "heading") {
      const lvl = Math.min(4, (el.metadata?.category_depth || 0) + 1) || 1;
      if (el.text) blocks.push({ type: "heading", level: lvl, text: el.text, ...pageField });
      continue;
    }
    if (kind === "table") {
      const html = el.metadata?.text_as_html || "";
      blocks.push({ type: "table", md: el.text || "", html, ...pageField });
      continue;
    }
    if (kind === "image") {
      const b64 = meta.image_base64;
      if (b64) {
        imgN++;
        blocks.push({ type: "image", src: `__IMG__${imgN}__`, b64, caption: el.text || "", ...pageField });
      } else if (el.text) {
        blocks.push({ type: "para", md: el.text, ...pageField });
      }
      continue;
    }
    if (kind === "formula") {
      if (el.text) blocks.push({ type: "formula", latex: el.text.replace(/^\$\$?|\$\$?$/g, "").trim(), ...pageField });
      continue;
    }
    if (kind === "caption") {
      if (blocks.length && blocks[blocks.length - 1].type === "image" && !blocks[blocks.length - 1].caption) {
        blocks[blocks.length - 1].caption = el.text;
      } else if (el.text) {
        blocks.push({ type: "para", md: "*" + el.text + "*", ...pageField });
      }
      continue;
    }
    if (el.text) blocks.push({ type: "para", md: el.text, ...pageField });
  }
  return blocks;
}
