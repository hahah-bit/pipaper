// Project-scoped retrieval grounds reading suggestions in saved research and original passages.
// This is an explainable triage aid; it does not establish a paper's novelty or applicability.
import { getProject, getPaper } from "../store.js";
import { loadProfile, listEvidence, listHypotheses, listConclusions, listReselections } from "../modules/research/store.js";
import { searchKnowledge } from "../rag/search.js";
import { embed, cleanError } from "../rag/providers.js";
import { rerank } from "../rag/rerank.js";
import { vectorIndex } from "../rag/milvus.js";
import { boundedText } from "../rag/retrieval.js";
import { resources, published, generation } from "../storage/catalog.js";

const STOP = new Set(("the a an and or of to in on with for from by is are was were our we this that these those using used use paper papers research study studies method methods approach approaches propose proposed novel new results result performance improve improved improvement based problem problems 研究 当前 如何 是否 通过 进行 方法 论文 提出 问题 结果 提升 一个 一种 以及 相关 的 了 是 与 和 为 对 在 将 用 于" ).split(" "));
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
// Shared concepts reduce the language mismatch without silently translating entire abstracts.
const CONCEPTS = [
  ["vrp", "车辆路径", ["车辆路径", "车辆路线", "vehicle routing", "vrp", "vrptw"]],
  ["routing", "路径规划", ["路径规划", "路线规划", "route planning", "routing"]],
  ["time-window", "时间窗", ["时间窗", "time window", "time windows", "vrptw"]],
  ["combopt", "组合优化", ["组合优化", "combinatorial optimization", "combinatorial optimisation"]],
  ["rl", "强化学习", ["强化学习", "reinforcement learning", "deep rl", "rl"]],
  ["neural", "神经网络", ["神经网络", "neural network", "neural networks", "neural"]],
  ["attention", "注意力", ["注意力", "attention"]],
  ["decoder", "解码器", ["解码器", "解码模块", "decoder", "decoders"]],
  ["encoder", "编码器", ["编码器", "编码模块", "encoder", "encoders"]],
  ["gnn", "图神经网络", ["图神经网络", "graph neural network", "graph neural networks", "gnn"]],
  ["transformer", "Transformer", ["transformer", "transformers"]],
  ["diffusion", "扩散模型", ["扩散模型", "diffusion model", "diffusion models", "diffusion"]],
  ["llm", "大语言模型", ["大语言模型", "大模型", "large language model", "large language models", "llm", "llms"]],
  ["rag", "检索增强", ["检索增强", "retrieval augmented generation", "retrieval-augmented generation", "rag"]],
  ["segmentation", "图像分割", ["图像分割", "语义分割", "image segmentation", "semantic segmentation"]],
  ["detection", "目标检测", ["目标检测", "object detection"]],
  ["retrieval", "检索", ["检索", "retrieval"]],
  ["robust", "鲁棒性", ["鲁棒性", "鲁棒", "robustness", "robust"]],
  ["generalization", "泛化", ["泛化", "generalization", "generalisation"]],
  ["dynamic", "动态", ["动态", "dynamic"]],
  ["domain-adaptation", "域适应", ["域适应", "领域适应", "domain adaptation"]],
  ["few-shot", "少样本", ["少样本", "few shot", "few-shot"]],
  ["contrastive", "对比学习", ["对比学习", "contrastive learning"]],
  ["lora", "低秩适配", ["低秩适配", "low rank adaptation", "low-rank adaptation", "lora"]],
  ["multimodal", "多模态", ["多模态", "multimodal", "multi-modal"]],
  // "Solar" alone also describes astrophysics; power/irradiance context is required.
  ["photovoltaic", "光伏", ["光伏", "太阳能", "photovoltaic", "photovoltaics", "solar power", "solar energy", "solar irradiance", "solar radiation", "pv"]],
  ["time-series", "时序", ["时序", "时间序列", "time series", "time-series", "temporal"]],
  ["fusion", "融合", ["融合", "fusion"]],
  ["convolution", "卷积", ["卷积", "convolution", "convolutional", "cnn"]],
  ["uncertainty", "不确定性", ["不确定性", "uncertainty"]],
  ["optimization", "优化", ["优化", "optimization", "optimisation"]],
  ["scheduling", "调度", ["调度", "scheduling"]],
  ["prediction", "预测", ["预测", "prediction", "forecasting"]],
];
const LABELS = new Map(CONCEPTS.map(([key, label]) => ["concept:" + key, label]));
const escapeRE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const aliasPattern = (alias) => new RegExp((/^[a-z]/i.test(alias) ? "(?<![a-z0-9])" : "") + escapeRE(alias) + (/[a-z0-9]$/i.test(alias) ? "(?![a-z0-9])" : ""), "giu");
const ALIASES = CONCEPTS.flatMap(([key, , aliases]) => aliases.map((alias) => ({ key: "concept:" + key, alias, pattern: aliasPattern(alias) }))).sort((a, b) => b.alias.length - a.alias.length);

function tokens(text) {
  let remaining = String(text || "").normalize("NFKC").toLowerCase();
  const found = new Set();
  // Match against the original text so overlapping concepts such as VRPTW keep both meanings.
  for (const { key, pattern } of ALIASES) {
    pattern.lastIndex = 0;
    if (pattern.test(String(text || "").normalize("NFKC").toLowerCase())) found.add(key);
    pattern.lastIndex = 0;
    remaining = remaining.replace(pattern, " ");
  }
  for (const word of segmenter.segment(remaining)) {
    let token = word.segment;
    if (!word.isWordLike || token.length < 2 || STOP.has(token) || /^\d+$/.test(token)) continue;
    if (/^[a-z]{5,}s$/.test(token)) token = token.slice(0, -1);
    if (!STOP.has(token)) found.add(token);
    // Unknown Chinese technical phrases still support partial matching.
    if (/^[\p{Script=Han}]{3,}$/u.test(token)) {
      for (let i = 0; i < token.length - 1; i++) {
        const pair = token.slice(i, i + 2);
        if (!STOP.has(pair)) found.add(pair);
      }
    }
  }
  return [...found];
}
function vector(parts) {
  const result = new Map();
  for (const [text, weight] of parts) for (const term of tokens(text)) result.set(term, Math.max(result.get(term) || 0, weight * (term.startsWith("concept:") ? 1.5 : 1)));
  return result;
}
function similarity(a, b) {
  const terms = [...a.keys()].filter((key) => b.has(key));
  const dot = terms.reduce((sum, key) => sum + a.get(key) * b.get(key), 0);
  const norm = (v) => Math.sqrt([...v.values()].reduce((sum, n) => sum + n * n, 0));
  return { score: dot / (norm(a) * norm(b) || 1), terms };
}
const meaningful = (match) => match.terms.length >= 2 || match.terms.some((term) => term.startsWith("concept:") && !["concept:optimization", "concept:dynamic", "concept:neural", "concept:prediction", "concept:retrieval"].includes(term));
const paperVector = (paper) => vector([[paper.title, 3], [(paper.keywords || []).join(" "), 2], [paper.abstract, 1]]);
const termLabels = (match) => [...new Set(match.terms.map((term) => LABELS.get(term) || term))].slice(0, 5).join("、");
const snippet = (text, length = 1000) => String(text || "").trim().slice(0, length);
const profileFields = ["question", "scope", "goal", "constraints"];

function defaultKnowledgeSources(project) {
  return resources().filter((r) => r.lifecycle === "active" && (project.paperIds?.includes(r.paperId) || project.paperIds?.includes(r.sourcePaperId) || r.projectId === project.id))
    .map((r) => ({ resourceId: r.id, title: r.title || "", generationId: published(r.id)?.id || "" }));
}

// All remote retrieval operations share one budget. A vector/rerank failure leaves the
// already-built catalog BM25 routes available inside searchKnowledge; no second query is needed.
function budgetedKnowledgeServices(services, signal) {
  const custom = services.knowledgeServices || {};
  const deadline = Date.now() + Math.max(1, Math.min(10000, Number(services.networkBudgetMs) || 6000));
  const within = async (operation) => {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("研究匹配的向量/重排检索达到时间预算，继续本地词法召回");
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(combined.reason || new Error("检索已取消"));
      combined.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("研究匹配的向量/重排检索超时，继续本地词法召回")), remaining);
      Promise.resolve().then(() => operation(combined)).then(resolve, reject).finally(() => {
        clearTimeout(timer);
        combined.removeEventListener("abort", onAbort);
      });
      // Also clear the timer if a provider ignores cancellation and never settles.
      combined.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
  };
  const index = custom.index || {
    searchRoutes: (query, queryVector, options) => within(async () => {
      const first = generation(options.generationIds[0]);
      if (!first) throw new Error("项目知识版本不可用");
      const current = vectorIndex(first.config);
      await current.ready();
      return current.searchRoutes(query, queryVector, options);
    }),
  };
  // The facade also bounds injected providers, which may not support AbortSignal themselves.
  return {
    ...custom,
    embed: (texts, options) => within((boundedSignal) => (custom.embed || embed)(texts, { ...options, signal: boundedSignal })),
    rerank: (query, documents, options) => within((boundedSignal) => (custom.rerank || rerank)(query, documents, { ...options, signal: boundedSignal })),
    index: {
      ready: () => index.ready ? within(() => index.ready()) : undefined,
      searchRoutes: (query, queryVector, options) => within(() => index.searchRoutes
        ? index.searchRoutes(query, queryVector, options)
        : Promise.resolve(index.search(query, queryVector, options)).then((routes) => routes.map((hits, i) => ({ name: "vector-route-" + i, hits })))),
    },
  };
}

function evidenceFromHit(hit) {
  const text = hit.text || [hit.element?.text, hit.element?.caption, hit.element?.description, ...(hit.contexts || []).map((item) => item.text)].filter(Boolean).join("\n");
  if (!hit.resourceId || !hit.generationId || !text?.trim()) return null;
  return {
    resourceId: hit.resourceId,
    generationId: hit.generationId,
    recordId: hit.chunkId || hit.element?.id || hit.recordId || "",
    title: hit.title || "知识库原文",
    pages: Array.isArray(hit.pages) ? hit.pages.filter((n) => Number.isInteger(n) && n > 0) : [],
    sectionPath: Array.isArray(hit.sectionPath) ? hit.sectionPath.map(String) : [],
    text: snippet(text),
    retrieval: hit.retrieval || [],
  };
}
function pendingMatch(reason, projectId = null, basis = "尚无可用的当前研究依据") {
  return { projectId, score: 0, level: "pending", reasons: [reason], categories: [], evidence: [], basis, confidence: "low", warnings: [], sources: [] };
}

function classify(candidate, matchedEvidence, score, questionMatch) {
  const metadataOnly = !matchedEvidence.length;
  // Clear methods/review signals can make a useful first-use suggestion even when a long
  // English abstract dilutes cosine similarity. Require two actual research intersections.
  if (score < 25 || (metadataOnly && (score < 30 || questionMatch.terms.length < 2))) return [];
  const text = [candidate.title, candidate.abstract].filter(Boolean).join("\n");
  const location = candidate.abstract ? "标题/摘要" : "标题";
  const cite = metadataOnly ? "当前研究主题" : "项目原文「" + matchedEvidence[0].title + "」" + (matchedEvidence[0].pages.length ? "第 " + matchedEvidence[0].pages.join("、") + " 页" : "");
  const qualifier = metadataOnly ? "仅据标题/摘要的低置信建议：" : "";
  const categories = [];
  if (/\blimitations?\b|\bgaps?\b|open problems?|future work|unexplored|unresolved|bottleneck|局限|缺口|开放问题|未解决|瓶颈|未来工作/i.test(text)) {
    categories.push({ id: "innovation", label: "找创新点", reason: `${qualifier}${location}包含局限或未解决问题，且与${cite}有主题交集；可用于寻找潜在研究缺口，尚未验证创新性。` });
  }
  if (/\bmodules?\b|\bdecoders?\b|\bencoders?\b|\battention\b|\barchitectures?\b|\bframeworks?\b|\badapters?\b|\bloss functions?\b|\bfusion\b|\bconvolutional\b|\bcnn\b|\bgru\b|\blstm\b|\btransformers?\b|模块|解码|编码|注意力|架构|损失函数|融合模块|卷积/i.test(text)) {
    categories.push({ id: "module", label: "改模块", reason: `${qualifier}${location}涉及可比较的模型模块，且关联${cite}；建议核对接口、任务与实验条件后再考虑改造。` });
  }
  if (score >= (metadataOnly ? 30 : 45) && (/\bsurvey\b|\breview\b|\bbenchmark\b|systematic|综述|基准|评测/i.test(text) || (score >= 70 && meaningful(questionMatch) && questionMatch.score >= 0.35))) {
    categories.push({ id: "topic", label: "选题必读", reason: `${qualifier}${/\bsurvey\b|\breview\b|综述/i.test(text) ? "综述性文献" : "与研究问题相近的文献"}关联${cite}；建议在确定选题与比较基线前优先阅读。` });
  }
  if (!categories.length && (!metadataOnly || score >= 40)) categories.push({ id: "background", label: "背景参考", reason: `${qualifier}${location}与${cite}有主题交集，可用于了解研究背景；具体用途仍需阅读全文核对。` });
  return categories;
}

/**
 * @returns {Promise<{results:Array, researchContext:Object}>}
 * services is a test seam for store readers/searchKnowledge; knowledgeServices are the
 * existing RAG provider hooks. Neither suggestions nor evidence are persisted by this call.
 */
export async function enrichResearchResults(results, query, { projectId, anchorPaperId, services = {}, signal } = {}) {
  signal?.throwIfAborted();
  const candidates = Array.isArray(results) ? results : [];
  const context = {
    enabled: true, projectId: projectId || null, projectTitle: "", profileAvailable: false,
    question: "", questionSource: "none", indexReady: false, evidenceCount: 0,
    paperCount: 0, recordCount: 0, status: "pending", reason: "", warnings: [],
    retrievalMode: "none", indexedResourceCount: 0, knowledgeSources: [], profileSources: [],
    analysisMethod: "可解释的术语匹配与项目原文召回；阅读用途为建议，不构成创新性验证",
  };
  const pending = (reason) => ({ results: candidates.map((row) => ({ ...row, researchMatch: pendingMatch(reason, projectId || null) })), researchContext: { ...context, reason } });
  if (!projectId) return pending("尚未选择项目，请先选择当前研究项目");
  let project;
  try { project = await (services.getProject || getProject)(projectId); }
  catch (error) { context.status = "unavailable"; return pending("项目读取失败：" + cleanError(error.message)); }
  if (!project) { context.status = "unavailable"; return pending("当前项目不存在或已删除"); }
  context.projectTitle = project.name || projectId;
  const readers = {
    profile: services.loadProfile || loadProfile,
    evidence: services.listEvidence || listEvidence,
    hypotheses: services.listHypotheses || listHypotheses,
    conclusions: services.listConclusions || listConclusions,
    reselections: services.listReselections || listReselections,
    knowledge: services.listKnowledgeSources || (() => defaultKnowledgeSources(project)),
  };
  const loaded = await Promise.allSettled(Object.entries(readers).map(async ([kind, read]) => ({ kind, value: await read(projectId) })));
  const data = {};
  loaded.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") data[outcome.value.kind] = outcome.value.value;
    else context.warnings.push("研究来源读取失败（" + Object.keys(readers)[i] + "）：" + cleanError(outcome.reason.message));
  });
  signal?.throwIfAborted();
  const profile = data.profile || {};
  context.profileAvailable = profileFields.some((field) => typeof profile[field] === "string" && profile[field].trim());
  const sources = profileFields.filter((field) => profile[field]?.trim()).map((field) => ({ resourceId: "research-profile:" + projectId, field, title: { question: "研究问题", scope: "研究范围", goal: "研究目标", constraints: "研究约束" }[field], text: snippet(profile[field], 2000) }));
  context.profileSources = sources.map(({ resourceId, field, title, text }) => ({ resourceId, field, title, text }));
  const paperIds = [...new Set(project.paperIds || [])].slice(0, 80);
  const papers = (await Promise.all(paperIds.map(async (id) => {
    try { return await (services.getPaper || getPaper)(id); } catch { return null; }
  }))).filter(Boolean);
  context.paperCount = papers.length;
  for (const paper of papers) sources.push({ resourceId: "paper:" + paper.id, title: paper.title || "项目文献", text: [paper.title, paper.abstract, ...(paper.keywords || [])].filter(Boolean).join("\n"), vector: paperVector(paper), kind: "paper" });
  for (const [kind, prefix] of [["evidence", "research-evidence:"], ["hypotheses", "research-hypothesis:"], ["conclusions", "research-conclusion:"], ["reselections", "research-reselection:"]]) {
    const records = Array.isArray(data[kind]) ? data[kind] : [];
    context.recordCount += records.length;
    for (const row of records.slice(0, 30)) {
      const body = [row.content, row.statement, row.note, row.scope, row.conditions, row.limits, row.unknowns, row.counterExamples,
        ...(row.openQuestions || []).map((item) => typeof item === "string" ? item : item.text),
        ...(row.candidates || []).flatMap((item) => [item.text, item.rationale])].filter(Boolean).join("\n");
      if (body) sources.push({ resourceId: prefix + row.id, recordId: row.id, title: row.title || (kind === "evidence" ? "保存的证据卡" : "研究记录"), text: snippet(body, 2000), kind });
    }
  }
  if (profile.question?.trim()) { context.question = snippet(profile.question, 500); context.questionSource = "profile"; }
  else {
    const firstQuestion = (data.hypotheses || []).find((row) => row.statement?.trim());
    if (firstQuestion) { context.question = snippet(firstQuestion.statement, 500); context.questionSource = "records"; }
    else if (papers.length) { context.question = "以项目文献为参照：" + papers.slice(0, 3).map((paper) => paper.title).join("；"); context.questionSource = "project-papers"; }
    else if (context.profileAvailable) { context.question = snippet(profile.scope || profile.goal || profile.constraints, 500); context.questionSource = "profile"; }
    else if (sources.length) { context.question = snippet(sources[0].text, 500); context.questionSource = "records"; }
  }
  let anchor = null;
  if (anchorPaperId && paperIds.includes(anchorPaperId)) anchor = papers.find((paper) => paper.id === anchorPaperId);
  else if (anchorPaperId) context.warnings.push("参照论文不属于当前项目，已忽略该参照以保持项目范围");
  const sourceVectors = sources.map((source) => ({ ...source, vector: source.vector || vector([[source.text, source.field === "question" ? 3 : 2]]) }));
  const questionVector = context.profileAvailable
    ? vector([[profile.question || "", 3], [profile.scope || "", 2], [profile.goal || "", 2], [profile.constraints || "", 1]])
    : vector([[context.question, 3]]);
  const sourceTerms = new Set(sourceVectors.flatMap((source) => [...source.vector.keys()]));
  context.knowledgeSources = (Array.isArray(data.knowledge) ? data.knowledge : []).slice(0, 80).map(({ resourceId, generationId, title }) => ({ resourceId, generationId: generationId || "", title: title || "" }));
  context.indexedResourceCount = context.knowledgeSources.filter((source) => source.generationId).length;
  context.indexReady = context.indexedResourceCount > 0;
  if (!sourceTerms.size) return pending("当前项目缺少研究档案、文献摘要或研究记录，用途暂待判断");
  if (!candidates.length) { context.status = "metadata-only"; context.reason = "没有候选文献需要分析"; return { results: [], researchContext: context }; }

  const translations = [...sourceTerms].filter((term) => term.startsWith("concept:")).slice(0, 20).flatMap((term) => CONCEPTS.find(([key]) => "concept:" + key === term)?.[2].filter((alias) => /[a-z]/i.test(alias)).slice(0, 2) || []);
  const retrievalQuery = boundedText([snippet(query, 800), ...profileFields.map((field) => snippet(profile[field], 450)),
    sourceVectors.slice(0, 8).map((source) => snippet(source.text, 120)).join(" "), translations.join(" ")].filter(Boolean).join("\n"), 6000);
  let retrieved = [], response = null;
  try {
    response = await (services.searchKnowledge || searchKnowledge)(retrievalQuery, {
      projectId, limit: 20, selfRag: false, imageBudget: 0,
      services: budgetedKnowledgeServices(services, signal), signal,
    });
    context.warnings.push(...(Array.isArray(response.warnings) ? response.warnings.map((warning) => cleanError(warning)) : []));
    retrieved = (Array.isArray(response.results) ? response.results : []).map(evidenceFromHit).filter(Boolean);
    // searchKnowledge owns scope checking; injected adapters must supply project-scoped data too.
    const allowed = new Set(context.knowledgeSources.map((source) => source.resourceId));
    if (allowed.size) retrieved = retrieved.filter((hit) => allowed.has(hit.resourceId));
    context.evidenceCount = retrieved.length;
    context.indexReady ||= retrieved.length > 0;
    context.retrievalMode = response.retrieval?.routes?.some((route) => route.count > 0 && !["catalog-bm25", "title-metadata", "element-number"].includes(route.name)) ? "hybrid" : "local-lexical";
    context.status = retrieved.length ? "ready" : "metadata-only";
    context.reason = retrieved.length ? "已从当前项目召回可反查原文片段；用途为待全文核对的阅读建议" : context.indexReady ? "项目知识库未召回相关原文，用途待判断" : "项目尚无已发布的知识索引；当前仅比较研究档案和文献元数据";
  } catch (error) {
    signal?.throwIfAborted();
    context.status = "unavailable";
    context.reason = "项目知识库检索不可用：" + cleanError(error.message);
    context.warnings.push(context.reason);
  }
  const evidenceVectors = retrieved.map((hit) => ({ ...hit, vector: vector([[hit.text, 2]]), contextMatch: similarity(vector([[hit.text, 2]]), vector(sourceVectors.map((source) => [source.text, 1]))) }));
  const enriched = candidates.map((candidate) => {
    const candidateVector = paperVector(candidate);
    const direct = similarity(candidateVector, questionVector);
    const matchedSources = sourceVectors.map((source) => ({ ...source, match: similarity(candidateVector, source.vector) })).filter((source) => meaningful(source.match)).sort((a, b) => b.match.score - a.match.score);
    const best = matchedSources[0]?.match.score || 0;
    const matches = evidenceVectors.map((hit) => ({ ...hit, match: similarity(candidateVector, hit.vector) }))
      .filter((hit) => meaningful(hit.match) && hit.match.score >= 0.08 && meaningful(hit.contextMatch) && hit.contextMatch.score >= 0.05)
      .sort((a, b) => b.match.score - a.match.score).slice(0, 3);
    const anchorMatch = anchor ? similarity(candidateVector, paperVector(anchor)) : { score: 0, terms: [] };
    const grounded = matches[0]?.match.score || 0;
    let score = Math.round(Math.min(100, (Math.max(direct.score, best * 0.8) * 70) + (grounded * 30) + (anchorMatch.score * 10)));
    if (!matches.length) score = Math.min(score, 60);
    if (!meaningful(direct) && !matchedSources.length && !matches.length) score = 0;
    const taskConflict = questionVector.has("concept:photovoltaic") && /\bsolar flares?\b|\bsunspots?\b|\bgeomagnetic\b|\bcoronal mass ejections?\b|太阳耀斑|日冕物质抛射|太阳黑子/i.test(candidate.title || "");
    if (taskConflict) score = Math.min(score, 15);
    const reasons = [];
    if (taskConflict) reasons.push("候选标题涉及太阳耀斑或空间天气，与当前光伏预测任务不同；一般预测术语不足以证明研究匹配");
    if (meaningful(direct)) reasons.push((context.profileAvailable ? "研究档案（" + profileFields.filter((field) => profile[field]?.trim()).map((field) => ({ question: "研究问题", scope: "范围", goal: "目标", constraints: "约束" }[field])).join("、") + "）" : "当前研究参照（" + (context.questionSource === "records" ? "已保存研究记录" : "项目文献") + "）") + "与候选标题/摘要共有术语：" + termLabels(direct));
    for (const source of matchedSources.slice(0, 2)) if (!source.field) reasons.push("与「" + source.title + "」" + (source.kind === "paper" ? "的文献元数据" : "的已保存研究记录") + "共有术语：" + termLabels(source.match));
    for (const hit of matches.slice(0, 2)) reasons.push("项目原文「" + hit.title + "」" + (hit.pages.length ? "第 " + hit.pages.join("、") + " 页" : "") + "提供可核对交集：" + termLabels(hit.match));
    if (!reasons.length) reasons.push("候选元数据与当前研究来源未发现足够的术语交集");
    const evidence = matches.map(({ vector: ignoredVector, match, contextMatch, retrieval, ...hit }) => hit);
    const categories = taskConflict ? [] : classify(candidate, evidence, score, direct);
    return { ...candidate, researchMatch: {
      projectId, score, level: score >= 70 ? "strong" : score >= 40 ? "moderate" : score > 0 ? "weak" : "pending",
      reasons, categories, evidence,
      basis: evidence.length ? "研究档案/项目研究来源 + RAG 原文片段；可解释规则建议" : categories.length ? "仅据研究档案与候选标题/摘要的低置信用途建议；无项目 RAG 原文证据" : "仅研究档案/项目元数据匹配；缺少足够依据，用途待判断",
      confidence: evidence.length && candidate.abstract && score >= 40 ? "medium" : "low",
      warnings: !evidence.length ? [categories.length ? "未获得与该候选相关的项目 RAG 原文；用途仅据标题/摘要建议，需阅读全文核对" : "尚无足够的匹配依据，具体阅读用途暂待判断"] : !candidate.abstract ? ["候选仅有标题，用途建议置信度较低"] : [],
      sources: matchedSources.slice(0, 4).map(({ resourceId, recordId, field, title, text }) => ({ resourceId, recordId, field, title, text: snippet(text, 400) })),
    } };
  });
  if (context.status === "metadata-only" && enriched.some((row) => row.researchMatch.categories.length))
    context.reason = context.indexReady ? "项目知识库未召回相关原文；当前用途仅据研究来源与候选标题/摘要作低置信建议" : "项目尚无已发布的知识索引；当前用途仅据研究来源与候选标题/摘要作低置信建议";
  context.warnings = [...new Set(context.warnings)];
  return { results: enriched, researchContext: context };
}
