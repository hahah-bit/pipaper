import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { spawn } from "node:child_process";
import os from "node:os";

// MinerU engine: api mode (mineru.net batch upload) or local CLI mode (mineru / magic-pdf).
// Resolves to { md, assets: Map<fileName, buffer> }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mineruApi(pdfPath, cfg, log) {
  const base = (cfg.apiBase || "https://mineru.net").replace(/\/$/, "");
  const token = cfg.token;
  if (!token) throw new Error("MinerU API token 未配置（设置 → MinerU → API token）");
  const name = path.basename(pdfPath).replace(/\.pdf$/i, "");

  log(`申请上传链接…`);
  const applyRes = await fetch(`${base}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      enable_formula: true,
      enable_table: true,
      language: "en",
      files: [{ name: name + ".pdf", is_ocr: true, data_id: name }],
    }),
  });
  const apply = await applyRes.json();
  if (apply.code !== 0) throw new Error("MinerU 申请上传失败: " + JSON.stringify(apply.msg || apply));
  const batchId = apply.data.batch_id;
  const uploadUrl = apply.data.file_urls?.[0];
  if (!uploadUrl) throw new Error("MinerU 未返回上传 URL");

  log(`上传 PDF (${(fs.statSync(pdfPath).size / 1e6).toFixed(1)} MB)…`);
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    body: new Uint8Array(fs.readFileSync(pdfPath)),
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!upRes.ok) throw new Error("PDF 上传失败: HTTP " + upRes.status);

  log("排队解析中（MinerU 云端）…");
  const started = Date.now();
  for (;;) {
    await sleep(5000);
    const st = await fetch(`${base}/api/v4/extract-results/batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ batch_id: batchId }),
    });
    const sj = await st.json();
    const r = sj.data?.extract_result?.[0];
    if (!r) throw new Error("MinerU 查询失败: " + JSON.stringify(sj.msg || sj));
    if (r.state === "done" && r.full_zip_url) {
      log("解析完成，下载结果包…");
      const zipRes = await fetch(r.full_zip_url);
      const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
      let md = null;
      const assets = new Map();
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        const entryName = e.entryName.split("/").pop();
        if (/\.md$/i.test(entryName) && !md) md = e.getData().toString("utf8");
        else if (/\.(png|jpe?g|gif|svg|webp)$/i.test(entryName)) assets.set(entryName, e.getData());
      }
      if (!md) throw new Error("MinerU 结果包中没有 markdown");
      return { md, assets };
    }
    if (r.state === "failed") throw new Error("MinerU 解析失败: " + (r.err_msg || ""));
    if (Date.now() - started > 15 * 60 * 1000) throw new Error("MinerU 解析超时（15 分钟）");
    log(`解析中… ${Math.round((Date.now() - started) / 1000)}s`);
  }
}

async function mineruLocal(pdfPath, cfg, log) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mineru-out-"));
  const cmdName = path.basename(cfg.cmd || "mineru");
  const args = cmdName.startsWith("magic-pdf")
    ? ["-p", pdfPath, "-o", outDir]
    : ["-p", pdfPath, "-o", outDir, "-b", "pipeline"];
  log(`本地解析：${cmdName} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const p = spawn(cfg.cmd || "mineru", args, { shell: true });
    let tail = "";
    p.stdout.on("data", (d) => {
      tail = (tail + d).slice(-400);
      if (/\n/.test(d)) log(d.toString().trim().split("\n").pop());
    });
    p.stderr.on("data", (d) => {
      tail = (tail + d).slice(-400);
    });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`mineru 退出码 ${code}: ${tail}`))));
  });
  // locate output md + images
  let found = null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.md$/i.test(e.name) && (!found || full.includes("full"))) found = full;
    }
  };
  walk(outDir);
  if (!found) throw new Error("本地 mineru 未产出 markdown");
  const md = fs.readFileSync(found, "utf8");
  const assets = new Map();
  const imgDir = path.dirname(found);
  for (const e of fs.readdirSync(imgDir, { withFileTypes: true })) {
    if (e.isFile() && /\.(png|jpe?g|gif|svg|webp)$/i.test(e.name)) {
      assets.set(e.name, fs.readFileSync(path.join(imgDir, e.name)));
    }
  }
  return { md, assets };
}

export async function parseMineru(pdfPath, cfg, log = () => {}) {
  if (cfg.mode === "api") return mineruApi(pdfPath, cfg, log);
  if (cfg.mode === "local") return mineruLocal(pdfPath, cfg, log);
  throw new Error("MinerU 未启用（设置 → 解析 → MinerU → api / local）");
}
