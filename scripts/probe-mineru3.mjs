import AdmZip from "adm-zip";
import { getConfig } from "../server/config.js";
const cfg = getConfig().parse.mineru;
const batchId = "ff0bf059-c67a-45e9-a683-28ec914eab91";
const st = await fetch(`${cfg.apiBase}/api/v4/extract-results/batch/${batchId}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
const r = (await st.json()).data.extract_result[0];
const zip = new AdmZip(Buffer.from(await (await fetch(r.full_zip_url)).arrayBuffer()));
const get = (re) => { const e = zip.getEntries().find((x) => re.test(x.entryName)); return e ? JSON.parse(e.getData().toString("utf8")) : null; };

const cl = get(/content_list\.json$/);
console.log("=== content_list.json ===  items:", Array.isArray(cl) ? cl.length : typeof cl);
if (Array.isArray(cl)) {
  for (const it of cl.filter((x) => ["table", "image", "equation"].includes(x.type)).slice(0, 4)) {
    console.log(JSON.stringify({ type: it.type, page: it.page_idx, img: it.img_path, table_body: (it.table_body || "").slice(0, 60), text: (it.text || "").slice(0, 40), bbox: it.bbox?.map(Math.round) }).slice(0, 260));
  }
  const t = cl.find((x) => x.type === "text");
  console.log("text item:", JSON.stringify({ type: t.type, page: t.page_idx, bbox: t.bbox?.map(Math.round), text: (t.text || "").slice(0, 50) }));
}

const layout = get(/layout\.json$/);
console.log("=== layout.json === top keys:", layout ? Object.keys(layout) : null);
if (layout?.pdf_info) {
  const pg = layout.pdf_info[2];
  console.log("pdf_info[2] keys:", Object.keys(pg));
  const blk = (pg.preproc_blocks || pg.para_blocks || []).find((b) => String(b.type).includes("table"));
  if (blk) {
    console.log("table blk keys:", Object.keys(blk));
    const spans = (blk.lines || []).flatMap((l) => l.spans || []);
    for (const sp of spans.slice(0, 2)) console.log("  span:", Object.keys(sp).join("+"), "| html:", !!sp.html, "| content:", (sp.content || sp.html || "").slice(0, 50));
  }
}
