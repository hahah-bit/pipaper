import AdmZip from "adm-zip";
import { getConfig } from "../server/config.js";
const cfg = getConfig().parse.mineru;
const batchId = "ff0bf059-c67a-45e9-a683-28ec914eab91";

const st = await fetch(`${cfg.apiBase}/api/v4/extract-results/batch/${batchId}`, {
  headers: { Authorization: `Bearer ${cfg.token}` },
});
const sj = await st.json();
const r = sj.data.extract_result[0];
console.log("state:", r.state);
if (!r.full_zip_url) {
  console.log("no zip yet");
  process.exit(0);
}
const zip = new AdmZip(Buffer.from(await (await fetch(r.full_zip_url)).arrayBuffer()));
const names = zip.getEntries().map((e) => e.entryName);
console.log("zip entries:", names.slice(0, 12), "… total", names.length);

const middleEntry = zip.getEntries().find((e) => /middle.*\.json$/i.test(e.entryName));
if (middleEntry) {
  const middle = JSON.parse(middleEntry.getData().toString("utf8"));
  const page = middle.pdf_info[2]; // page 3 (has a table)
  for (const blk of page.preproc_blocks || []) {
    if (String(blk.type).includes("table")) {
      console.log("TABLE block keys:", Object.keys(blk));
      const spans = (blk.lines || []).flatMap((l) => l.spans || []);
      for (const sp of spans) console.log("  span keys:", Object.keys(sp), "| has html:", !!sp.html, "| type:", sp.type, "| content head:", (sp.content || "").slice(0, 40));
      break;
    }
  }
  for (const pg of middle.pdf_info) {
    for (const blk of pg.preproc_blocks || []) {
      if (String(blk.type).includes("image")) {
        const spans = (blk.lines || []).flatMap((l) => l.spans || []);
        console.log("IMAGE block: keys:", Object.keys(blk), "| span keys:", spans.map((s) => Object.keys(s).join("+")).join(","), "| image_path:", spans.map((s) => s.image_path).filter(Boolean).slice(0, 2));
        process.exit(0);
      }
    }
  }
} else {
  console.log("no middle.json in zip; entries:", names.filter((n) => n.endsWith(".json")));
}
