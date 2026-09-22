import { hashOf, fault } from "./study-store.js";

export const TOPICS = {
  rough: ["问题与动机", "论文主线", "baseline与创新", "实验与假设", "适用边界", "目标匹配"],
  introduction: ["逐段作用", "方法演进", "已有局限与解决思路"],
  method: ["逐段逻辑", "组件与数据流", "创新与设计细节", "训练验证测试"],
  experiments: ["逐段与逐表解释", "假设与实验对照", "证据与局限", "自主验证建议"],
  summary: ["问题方法证据", "未解释问题", "相关论文", "复现实验", "消融实验", "破坏实验"],
};
export const blockText = b => b.html || b.md || b.text || b.latex || b.caption || "";
export function normalizeDocument(doc) {
  const blocks = (Array.isArray(doc) ? doc : doc.blocks || []).map((b, i) => ({ ...b, id: b.id || `legacy_${i}`, page: b.page || 1 }));
  return { ...(Array.isArray(doc) ? {} : doc), blocks };
}
export function roughBlocks(doc) {
  let section = "other";
  return doc.blocks.filter((b, index) => {
    if (index === 0 && (b.type === "heading" || blockText(b).length <= 300)) return true;
    if (b.type === "heading") section = /abstract|摘要/i.test(blockText(b)) ? "abstract" : /conclu|结论|总结/i.test(blockText(b)) ? "conclusion" : "other";
    return section === "abstract" || section === "conclusion" || ["image", "table"].includes(b.type);
  }).filter(b => b.type !== "code");
}
function chunks(blocks, limit = 14000) {
  const out = []; let group = [], size = 0;
  for (const b of blocks) {
    if (group.length && (size + blockText(b).length > limit || group.length >= 12)) { out.push(group); group = []; size = 0; }
    group.push(b); size += blockText(b).length;
  }
  if (group.length) out.push(group);
  return out;
}
export function makeCheckpoints(doc) {
  const groups = { introduction: [], method: [], experiments: [] };
  let current = "introduction", excluded = false;
  for (const b of doc.blocks) {
    const title = b.type === "heading" ? blockText(b) : "";
    if (title) {
      excluded = /^(?:\d+[.\s]*)?(?:references|bibliography|acknowledg|参考文献|致谢)\b/i.test(title.trim());
      if (/intro|related|background|preliminar|引言|相关工作|背景/i.test(title)) current = "introduction";
      else if (/experiment|evaluat|result|ablation|discussion|实验|评估|结果|消融/i.test(title)) current = "experiments";
      else if (/method|approach|framework|architecture|proposed|方法|架构|算法/i.test(title)) current = "method";
    }
    if (!excluded) groups[current].push(b);
  }
  const checkpoint = (kind, blocks, n = 0) => ({ id: `${kind}_${n}`, stage: ["rough", "summary"].includes(kind) ? kind : "deep",
    kind, label: ({ rough: "粗读", introduction: "引言与相关工作", method: "方法", experiments: "实验", summary: "总结与实验设计" })[kind] + (n ? ` · ${n + 1}` : ""),
    blockIds: blocks.map(b => b.id), status: "pending", attempts: [] });
  // Only representative figures/tables in the first pass; always keep abstract/conclusion.
  let figures = 0;
  const rough = roughBlocks(doc).filter(b => !["image", "table"].includes(b.type) || ++figures <= 3);
  const out = [checkpoint("rough", rough)];
  for (const kind of Object.keys(groups)) {
    const slices = chunks(groups[kind]);
    if (!slices.length) slices.push([]); // require an explicit, sourced explanation of missing sections
    slices.forEach((blocks, i) => out.push(checkpoint(kind, blocks, i)));
  }
  out.push(checkpoint("summary", rough));
  return out;
}
export function sourcesText(blocks) {
  return blocks.map(b => `[${b.id} | p.${b.page} | ${b.type}]\n${blockText(b)}${b.caption && b.caption !== blockText(b) ? "\n图注：" + b.caption : ""}`).join("\n\n");
}
export function parseModelJson(text) {
  const input = String(text).trim();
  const fence = input.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const cleaned = fence ? fence[1].trim() : input;
  let reason = "期望 JSON 对象";
  try { const result = JSON.parse(cleaned); if (result && typeof result === "object" && !Array.isArray(result)) return result; }
  catch (error) { reason = error.message; }
  throw Object.assign(fault("模型未返回有效结构化结果，请重试；进度未推进", 422), {
    modelDiagnostics: { reason, output: String(text) },
  });
}
export function validateLesson(raw, checkpoint, doc, goalType) {
  const valid = new Set(doc.blocks.map(b => b.id));
  const permitted = new Set(checkpoint.blockIds);
  const required = [...TOPICS[checkpoint.kind], ...(checkpoint.kind === "summary" && goalType === "innovate" ? ["baseline改进计划"] : [])];
  if (!Array.isArray(raw.topics) || required.some(key => !raw.topics.some(t => t.key === key && typeof t.text === "string" && t.text.trim()))) throw fault("讲解缺少必需主题，请重新生成", 422);
  for (const topic of raw.topics) {
    if (!["paper", "inference", "unreported"].includes(topic.basis) || !Array.isArray(topic.sources) || topic.sources.some(id => !valid.has(id) || (checkpoint.kind === "rough" && !permitted.has(id))) || (topic.basis !== "unreported" && !topic.sources.length)) throw fault("讲解缺少有效原文出处", 422);
  }
  if (!Array.isArray(raw.coveredBlockIds) || checkpoint.blockIds.some(id => !raw.coveredBlockIds.includes(id)) || raw.coveredBlockIds.some(id => !permitted.has(id))) throw fault("讲解未覆盖当前阅读段落", 422);
  if (checkpoint.stage === "deep" && (!Array.isArray(raw.paragraphs) || checkpoint.blockIds.some(id => !raw.paragraphs.some(p => p.blockId === id && typeof p.explanation === "string" && p.explanation.trim())) || raw.paragraphs.some(p => !permitted.has(p.blockId)))) throw fault("精读需要为每个段落和图表提供对应讲解", 422);
  if (checkpoint.kind === "rough" && raw.topics.some(t => t.sources.some(id => !permitted.has(id)))) throw fault("粗读引用了当前范围之外的段落", 422);
  const minimum = ["rough", "summary"].includes(checkpoint.kind) ? 3 : 2;
  const maximum = minimum === 3 ? 5 : 4;
  if (!Array.isArray(raw.questions) || raw.questions.length < minimum || raw.questions.length > maximum) throw fault(`考查题数量不符合要求：本节需要 ${minimum}–${maximum} 题，实际返回 ${Array.isArray(raw.questions) ? raw.questions.length : 0} 题；请合并或补充问题后重试`, 422);
  if (raw.questions.some(q => !q || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.rubric) || !q.rubric.length || q.rubric.some(r => typeof r !== "string" || !r.trim()))) throw fault("考查题或评分要点不完整：每题需要非空 question 字符串及非空 rubric 字符串数组", 422);
  if (checkpoint.kind === "rough" && (!raw.recommendation || typeof raw.recommendation.worthDeep !== "boolean" || !raw.recommendation.reason)) throw fault("缺少精读建议", 422);
  if (checkpoint.kind === "rough") {
    const candidates = checkpoint.localEvidence || [], matches = raw.matches || [];
    if (!Array.isArray(matches) || matches.length !== candidates.length || new Set(matches.map(m => m.id)).size !== candidates.length || matches.some(m => !candidates.some(c => c.id === m.id) || typeof m.relevant !== "boolean" || typeof m.reason !== "string" || !m.reason.trim())) throw fault("本地知识匹配缺少逐项证据判断，请重试", 422);
  }
  if (checkpoint.kind === "summary") {
    const kinds = ["reproduction", "ablation", "destruction", ...(goalType === "innovate" ? ["innovation"] : [])];
    if (!Array.isArray(raw.experiments) || kinds.some(kind => !raw.experiments.some(e => e.kind === kind && ["hypothesis", "variables", "control", "metrics", "expected", "failure"].every(k => typeof e[k] === "string" && e[k].trim())))) throw fault("实验计划缺少假设、对照、指标或失败判据", 422);
  }
  return { ...raw, questions: raw.questions.map((q, i) => ({ question: q.question, rubric: q.rubric, id: `${checkpoint.id}_q${i + 1}` })) };
}
export function validateEvaluation(raw, checkpoint, answers) {
  const questions = checkpoint.lesson.questions;
  if (!Array.isArray(raw.evaluations) || raw.evaluations.length !== questions.length || new Set(raw.evaluations.map(e => e.questionId)).size !== questions.length) throw fault("评估结果不完整", 422);
  for (const question of questions) {
    const evaluation = raw.evaluations.find(e => e.questionId === question.id);
    if (!answers[question.id]?.trim() || !evaluation || !Array.isArray(evaluation.criteria) || evaluation.criteria.length !== question.rubric.length || evaluation.criteria.some(v => typeof v !== "boolean") || typeof evaluation.feedback !== "string" || !evaluation.feedback.trim()) throw fault("评估缺少逐项判断或反馈", 422);
  }
  return { evaluations: raw.evaluations, passed: raw.evaluations.every(e => e.criteria.every(Boolean)), answerHash: hashOf(JSON.stringify(answers)) };
}
export function advanceTask(task, { stopAfterRough = false, confirmPlan = false } = {}) {
  if (task.status !== "active") throw fault("任务当前不能推进", 409);
  const cp = task.checkpoints[task.cursor];
  if (!cp || cp.status !== "passed") throw fault("请先完成当前考查，答题通过后才能推进", 409);
  if (cp.kind === "method" && !["architecture", "pipeline"].every(kind => task.artifacts.some(a => !a.historical && a.checkpointId === cp.id && a.kind === kind))) throw fault("请先生成当前方法的架构图和训练／验证／测试流程图", 409);
  if (cp.kind === "summary") {
    if (!confirmPlan || !cp.research || cp.research.errors?.length) throw fault("请完成相关论文检索并确认实验计划", 409);
    task.status = "completed"; cp.planConfirmed = true;
  } else if (stopAfterRough && cp.kind === "rough") task.status = "rough-completed";
  else task.cursor++;
  return task;
}
