// Real sources + configured Pi model. No personal profile or permanent task is used.
import assert from "node:assert/strict";
import { complete } from "../server/topics/model.js";
import { validatePlan } from "../server/topics/analysis.js";
import { createSources } from "../server/topics/sources.js";
const source = createSources(), sample = await source.works('"industrial anomaly detection"', { limit: 6 });
const result = await complete({ system: "你是科研选题助手。仅依给定的真实论文拟定精准检索式。", input: {
  task: "topic_plan", instruction: "queries必须1–5项，每项包含query和focus字符串。", papers: sample.papers.map(p => ({ id: p.id, title: p.title, abstract: p.abstract.slice(0, 1200) })),
  format: { queries: [{ query: "带双引号的具体英文短语", focus: "待解决的问题" }], policyTerms: ["中文技术词"] },
} });
console.log(JSON.stringify({ fields: Object.keys(result.value || {}), queries: result.value.queries })); validatePlan(result.value);
console.log(JSON.stringify({ passed: true, model: result.model, papers: sample.papers.length, queries: result.value.queries, usage: result.usage }));
