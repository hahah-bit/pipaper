// Opt-in smoke check. Reuses Pi credentials, isolates every task/session/cache in a temporary directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSessionEventChannel } from "../src/sessionEventChannel.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--paper")) throw new Error("用法：node scripts/study-real-smoke.mjs --paper <已管理论文ID> [--provider 名称 --model ID]");
const paper = JSON.parse(fs.readFileSync(path.join(root, "data", "papers.json"), "utf8")).papers.find(p => p.id === flag("--paper"));
if (!paper?.pdfPath || !fs.existsSync(paper.pdfPath)) throw new Error("论文需要有可读取的 PDF");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-real-smoke-"));
const agent = path.join(directory, "agent"), data = path.join(directory, "data"), sourceAgent = getAgentDir();
const state = {};
let child, channel, logs = "";
try {
  fs.mkdirSync(agent); fs.mkdirSync(data);
  for (const file of ["auth.json", "models.json"]) if (fs.existsSync(path.join(sourceAgent, file))) fs.copyFileSync(path.join(sourceAgent, file), path.join(agent, file));
  const settings = JSON.parse(fs.readFileSync(path.join(sourceAgent, "settings.json"), "utf8"));
  const provider = process.argv.includes("--provider") ? flag("--provider") : settings.defaultProvider;
  const model = process.argv.includes("--model") ? flag("--model") : settings.defaultModel;
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model, defaultThinkingLevel: "off", compaction: { enabled: false } }));
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ zotero: { enabled: false } }));
  fs.writeFileSync(path.join(data, "papers.json"), JSON.stringify({ papers: [{ ...paper, studyOnly: false }], collections: [] }));
  const hash = paper.contentHash || createHash("sha256").update(fs.readFileSync(paper.pdfPath)).digest("hex");
  const cache = "h_" + hash.slice(0, 24), original = path.join(root, "data", "parsed", cache);
  if (fs.existsSync(original)) fs.cpSync(original, path.join(data, "parsed", cache), { recursive: true });
  const probe = http.createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, "server", "index.js")], { cwd: root, windowsHide: true, env: { ...process.env, PORT: String(port), PI_CODING_AGENT_DIR: agent, PIPAPER_DATA_DIR: data, PIPAPER_LIBRARY_DIR: path.join(directory, "library"), PIPAPER_KNOWLEDGE_DIR: path.join(directory, "knowledge") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", text => logs += text); child.stderr.on("data", text => logs += text);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/api/health")).ok) break; } catch {} if (i === 99 || child.exitCode != null) throw new Error("隔离服务启动失败"); await new Promise(r => setTimeout(r, 100)); }
  const request = async (route, body) => { const response = await fetch(url + "/api" + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Pi-Control": state.controlId || "" }, body: body ? JSON.stringify(body) : undefined }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; };
  let task = await request("/studies", { paperId: paper.id, goal: process.argv.includes("--goal") ? flag("--goal") : "理解论文主线、baseline 与实验依据，判断是否适合精读" });
  channel = createSessionEventChannel({ state, fetch: (u, o) => fetch(url + u, o) });
  await channel.connectSessionEvents(task.guideSessionId, () => {});
  const run = async (action, input = {}) => { console.log(`验证 ${action}…`); await channel.waitOperation((await request(`/studies/${task.id}/${action}`, input)).operationId); task = (await request(`/studies/${task.id}`)).task; };
  await run("prepare");
  try { await run("lesson", { checkpointId: "rough_0" }); }
  catch (error) {
    const file = path.join(data, "studies", task.id, "model-failure.json");
    if (fs.existsSync(file)) {
      const failure = JSON.parse(fs.readFileSync(file, "utf8"));
      console.error(JSON.stringify({ model: failure.model, reason: failure.reason, characters: failure.output?.length,
        start: failure.output?.slice(0, 350), end: failure.output?.slice(-350) }));
    }
    throw error;
  }
  console.log(JSON.stringify({ paper: task.title, model: task.checkpoints[0].model, version: task.versionId, topics: task.checkpoints[0].lesson.topics.length, questions: task.checkpoints[0].lesson.questions.length, recommendation: task.checkpoints[0].lesson.recommendation }));
  const doc = await request(`/studies/${task.id}/document`);
  const block = doc.blocks.find(b => ["para", "paragraph", "text"].includes(b.type) && String(b.md || b.text || "").length > 150) || doc.blocks[1];
  await run("translate", { blockId: block.id });
  const tr = task.translations[block.id]; if (tr.error) throw new Error(tr.error);
  console.log(JSON.stringify({ translatedBlock: block.id, model: tr.model, characters: tr.translated.length, preview: tr.translated.slice(0, 250), warnings: tr.warnings }));
} finally {
  channel?.closeSessionEvents();
  if (child && child.exitCode == null) { child.kill(); await new Promise(r => child.once("exit", r)); }
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("pipaper-real-smoke-")) fs.rmSync(resolved, { recursive: true, force: true });
}
