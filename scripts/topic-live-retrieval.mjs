// Real-source regression against a saved survey. No fixtures or report invention.
import fs from "node:fs";
import path from "node:path";
import { complete } from "../server/topics/model.js";
import { conceptPrompt, buildPlan } from "../server/topics/planning.js";
import { createSources } from "../server/topics/sources.js";
import { retrieve } from "../server/topics/retrieval.js";
const id = process.argv[2]; if (!/^topic_[a-f0-9-]+$/.test(id || "")) throw new Error("Pass saved topic id");
const task = JSON.parse(fs.readFileSync(`data/topic-analysis/tasks/${id}/task.json`, "utf8"));
const out = path.resolve("data/topic-live-validation"); fs.mkdirSync(out, { recursive: true });
const sources = createSources(), documents = [], failures = new Set();
const log = (stage, text) => console.log(new Date().toISOString(), stage, text);
const getDoc = async (url, title) => { if (failures.has(url)) return null; const old = documents.find(d => d.url === url); if (old) return old; try { const doc = await sources.document(url); documents.push(doc); return doc; } catch (e) { failures.add(url); log("document", `${title}: ${e.message}`); return null; } };
let plan; const input = conceptPrompt(task);
if(process.argv.includes('--reuse-concepts')) plan=buildPlan(JSON.parse(fs.readFileSync(path.join(out,'concepts-1.json'),'utf8')),task.exploreSubfields);
for(let i=0;!plan&&i<2;i++) { const r = await complete({ model:task.model, input, system:"你是科研检索规划专家。只返回给定结构的JSON；将业务需求映射成简短的英文科学术语。" }); fs.writeFileSync(path.join(out,`concepts-${i}.json`),JSON.stringify(r.value,null,2)); try {plan=buildPlan(r.value,task.exploreSubfields);break;} catch(e){if(i)throw e;input.correction=e.message;} }
fs.writeFileSync(path.join(out,"plan.json"),JSON.stringify(plan,null,2));log("plan",`${plan.queries.length} atomic questions`);
let serial=0; const save=(kind,title,data)=>{ fs.writeFileSync(path.join(out,`${String(++serial).padStart(3,"0")}-${kind}.json`),JSON.stringify({title,data},null,2)); };
const result = await retrieve(plan, { sources, getDoc, documents, save, log });
fs.writeFileSync(path.join(out,"result.json"),JSON.stringify(result,null,2));fs.writeFileSync(path.join(out,"documents.json"),JSON.stringify(documents));
console.log(JSON.stringify({total:result.papers.length,eligible:result.eligible.length,examples:result.eligible.slice(0,15).map(p=>({title:p.title,date:p.date,venue:p.quality.venue,url:p.quality.publicationUrl})),coverage:result.summary.coverage},null,2));
