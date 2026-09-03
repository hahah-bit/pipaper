import fs from "node:fs";
import { getConfig } from "../server/config.js";
const cfg = getConfig().parse.mineru;
const base = cfg.apiBase;
const pdf = "library/Attention Is All You Need (Vaswani et al., 2017).pdf";
const name = "probe";

const applyRes = await fetch(`${base}/api/v4/file-urls/batch`, {
  method: "POST",
  headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ enable_formula: true, enable_table: true, language: "en", files: [{ name: name + ".pdf", is_ocr: true, data_id: name }] }),
});
const applyText = await applyRes.text();
console.log("apply status", applyRes.status);
const apply = JSON.parse(applyText);
console.log("apply.code", apply.code, "batch:", apply.data?.batch_id);
const batchId = apply.data.batch_id;
const uploadUrl = apply.data.file_urls[0];

const up = await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(fs.readFileSync(pdf)) });
console.log("upload status", up.status);

await new Promise((r) => setTimeout(r, 6000));
const st = await fetch(`${base}/api/v4/extract-results/batch`, {
  method: "POST",
  headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ batch_id: batchId }),
});
console.log("poll status", st.status, "content-type:", st.headers.get("content-type"));
const raw = await st.text();
console.log("poll body head:", JSON.stringify(raw.slice(0, 300)));
