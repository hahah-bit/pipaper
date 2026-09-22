import { fault } from "./store.js";

export function conceptPrompt(task) {
  return { task: "topic_concepts", area: task.researchArea, exploreSubfields: task.exploreSubfields,
    instruction: `先提取关键词和关键方向，再将关键方向细分为可独立检索的科学问题。${task.exploreSubfields ? "提取3–5个关键方向，拆成6–12个细分问题，覆盖原需求的不同主线。" : "只拆解用户指定领域内的1–4个具体问题，不扩展其他领域。"} 中文业务术语必须映射成论文常用英文术语。OpenClaw、Doris等是工具/实现载体，制造业/中小企业是应用背景，不要要求每篇文献都同时出现它们。每个细分问题只有1–2个核心术语，其中第一个必须是足够具体、可单独检索的任务/机制短语（如 tool learning、entity matching、job shop scheduling），而非 artificial intelligence 或 machine learning。同义词是真实学术表达，不是添加约束。不要输出布尔表达式、论文或结论。`,
    disambiguation: "每个核心术语至多5个英文单词，通常2–3词。不要写skill learning for language model agents这种长短语，拆成skill learning与language model两个词组。注意歧义：智能体的skill learning必须加language model等机制词，不能召回人类运动技能研究；制造资源配置优先production scheduling而不是单独resource allocation。不要直译数据要素为data element resource allocation这类罕见表达，要映射为data valuation、data acquisition、decision-focused learning等可检索任务。仍然限制每式最多两个术语。",
    format: { concepts: [{ zh: "从需求提取的中文关键词", en: "规范学术英文", role: "task/method/context/tool", synonyms: ["英文同义词"] }], directions: [{ parent: "关键方向", name: "细分方向", problem: "只描述一个待研究问题", terms: [{ zh: "具体核心术语", en: "specific academic phrase", synonyms: ["alternative academic phrase"] }], context: ["应用背景，不作为必选检索词"] }], policyTerms: ["政策相关中文技术词"], framing: "这些研究主线的关系" } };
}
const clean = s => typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";
const broad = /^(artificial intelligence|machine learning|deep learning|computer science|manufacturing|large language models?|optimization|agent|agents)$/i;
const ambiguous = /^(skill learning|skill acquisition|resource allocation|reinforcement learning|transfer learning|language models?|LLMs?|RPA)$/i;
const synonyms = (values, count) => (Array.isArray(values) ? values : []).filter(s => typeof s === "string" && !/^(?:AND|OR|NOT)$/.test(s.trim())).slice(0, count).map(term);
function term(s) {
  const t = clean(s).replace(/\s*[（(][^()（）]*[）)]/g, "").trim();
  if (!t || t.length > 80 || /["()\u3400-\u9fff]|\b(?:AND|OR|NOT)\b/.test(t) || t.split(" ").length > 9) throw fault(`核心词“${clean(s)}”须为简短的学术英文术语，不是长句或布尔式`, 422);
  return t;
}
export function buildPlan(value, exploreSubfields = true) {
  if (!Array.isArray(value.concepts) || !value.concepts.length || !Array.isArray(value.directions) || value.directions.length < (exploreSubfields ? 6 : 1) || value.directions.length > (exploreSubfields ? 12 : 4)) throw fault("先提取关键词；探索模式需6–12个细分问题，指定方向需1–4个", 422);
  const concepts = value.concepts.slice(0, 30).map(c => ({ zh: clean(c.zh), en: term(c.en), role: ["task", "method", "context", "tool"].includes(c.role) ? c.role : "context", synonyms: synonyms(c.synonyms, 3) }));
  const queries = value.directions.map((d, i) => {
    if (![d.parent, d.name, d.problem].every(x => clean(x)) || !Array.isArray(d.terms) || !d.terms.length || d.terms.length > 2) throw fault("每个细分方向必须包含名称、所属主线、单一问题和1–2个核心术语", 422);
    const terms = d.terms.map(t => ({ zh: clean(t.zh), en: term(t.en), synonyms: synonyms(t.synonyms, 2) }));
    if (terms.some(t => t.en.split(" ").length > 5 || t.synonyms.some(s => s.split(" ").length > 5))) throw fault("核心检索词及同义词最多5词；把 for/of/in 连接的任务与机制拆成两个短语，不要照译业务句子", 422);
    if (broad.test(terms[0].en)) throw fault(`“${terms[0].en}”过于宽泛，第一个词须为可单独检索的细分任务`, 422);
    const quote = x => `"${x}"`;
    const query = terms.map(t => quote(t.en)).join(" AND ");
    const alternatives = terms[0].synonyms.map(s => [quote(s), ...terms.slice(1).map(t => quote(t.en))].join(" AND "));
    const atomic = terms.flatMap(t => [t.en, ...t.synonyms]).filter(s => !broad.test(s) && !ambiguous.test(s));
    const variants = [...new Set([query, ...alternatives.slice(0, 1), ...atomic.map(quote)])].slice(0, 4);
    return { id: `query-${i + 1}`, parent: clean(d.parent), name: clean(d.name), focus: clean(d.problem), terms, context: (d.context || []).map(clean).slice(0, 5), query, variants };
  });
  if (!Array.isArray(value.policyTerms) || !value.policyTerms.length) throw fault("缺少政策检索词", 422);
  return { schemaVersion: 2, concepts, queries, policyTerms: value.policyTerms.slice(0, 15).map(clean), framing: clean(value.framing) };
}
