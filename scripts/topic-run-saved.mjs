// Continue the user's existing task using same-day, real-source regression data.
// This never imports fixture sources and never starts/stops the web server.
import fs from "node:fs";
import * as store from "../server/topics/store.js";
import { analyze } from "../server/topics/pipeline.js";
import { years, createSources } from "../server/topics/sources.js";
import { qualifyPapers } from "../server/topics/quality.js";
const id = process.argv[2], task = store.read(id), sources = createSources();
const state = await (await fetch(`http://127.0.0.1:4318/api/topics/${id}`)).json();
if (state.operations?.length || task.status === "running") throw new Error("Task is already running; do not race it");
const controller = new AbortController(); process.on("SIGINT", () => controller.abort());
let resumeDiscoveryId;
if (process.argv.includes("--import-live")) {
  const plan = JSON.parse(fs.readFileSync("data/topic-live-validation/plan.json", "utf8")), discovery = JSON.parse(fs.readFileSync("data/topic-live-validation/result.json", "utf8")), documents = JSON.parse(fs.readFileSync("data/topic-live-validation/documents.json", "utf8"));
  await qualifyPapers(discovery.papers, { sources, documents, signal: controller.signal, getDoc: async url => {
    const old = documents.find(d => d.url === url); if (old) return old;
    try { const doc = await sources.document(url, controller.signal); documents.push(doc); return doc; } catch { return null; }
  } });
  discovery.eligible = discovery.papers.filter(p => p.quality?.eligible && p.date >= years().baselineFrom && p.date <= years().to && p.type !== "review"); discovery.summary.eligible = discovery.eligible.length;
  const dependencies = [];
  for (const name of fs.readdirSync("data/topic-live-validation").filter(n => /^\d+-search.json$/.test(n))) { const item = JSON.parse(fs.readFileSync(`data/topic-live-validation/${name}`, "utf8")); dependencies.push(store.artifact(id, "search", item.title, item.data)); }
  dependencies.push(store.artifact(id, "retrieval", "真实检索覆盖与 Baseline 核验", discovery.summary));
  resumeDiscoveryId = store.artifact(id, "discovery", "当前调查卡 · 已核验真实检索快照", { area: task.researchArea, period: years(), plan, discovery, documents }, dependencies);
} else if (process.argv.includes("--resume")) resumeDiscoveryId = task.artifacts.filter(a => a.kind === "discovery").map(a => ({ id: a.id, v: store.readArtifact(id, a.id) })).filter(x => x.v.period?.to === years().to).sort((a, b) => b.v.discovery.summary.eligible - a.v.discovery.summary.eligible)[0]?.id;
store.change(id, t => { t.status = "running"; t.stage = "plan"; t.lastError = null; });
try {
  const report = await analyze(id, { signal: controller.signal, resumeDiscoveryId, resumeDirectionsId: process.argv.includes("--directions") ? process.argv[process.argv.indexOf("--directions") + 1] : undefined, emit: event => console.log(new Date().toISOString(), event.stage, event.text) });
  console.log(JSON.stringify({ status: report.status, conclusions: report.conclusions.map(d => d.name), pending: report.pending.map(d => ({ name: d.name, reasons: d.filterReasons })), journals: report.journals.length, warnings: report.warnings.length }, null, 2));
} catch (e) { store.change(id, t => { t.status = controller.signal.aborted ? "interrupted" : "failed"; t.lastError = e.message; }); console.error(e); process.exitCode = 1; }
