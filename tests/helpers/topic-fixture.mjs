export const topicProfile = { name: "测试画像 · 单卡实验", researchArea: "工业异常检测", hardware: "1张24GB GPU", gpuCount: 1, vramGB: 24,
  months: 6, deadlineStage: "submission", openData: true, experience: "beginner", weeklyHours: 20, contribution: "method" };
export function topicFixtureData() {
  const year = new Date().getUTCFullYear();
  const papers = Array.from({ length: 24 }, (_, i) => ({ id: `https://openalex.org/W${100 + i}`, title: `TEST ONLY: Robust anomaly localization ${i + 1}`, date: `${year - (i % 3)}-01-15`, year: year - (i % 3), citations: 100 - i,
    abstract: "Industrial anomaly detection under distribution shift. We study localized feature reconstruction and robust validation.", source: "OpenAlex", url: `https://arxiv.org/abs/2601.${String(i + 1).padStart(5, "0")}`,
    landing: `https://arxiv.org/abs/2601.${String(i + 1).padStart(5, "0")}`, pdf: null, keywords: ["Machine learning", "Anomaly localization", "Distribution shift"],
    references: i > 2 ? ["https://openalex.org/W100"] : [], paperOpenAccess: true,
    quality: { eligible: true, system: "CAS", rank: 1, venue: "TEST ONLY", year: 2026, sourceUrl: "https://www.fenqubiao.com/test-fixture-only", publicationUrl: "https://example.org/test-only-proceedings" },
    venue: { id: `https://openalex.org/S${100 + i % 13}`, name: `测试期刊 ${i % 13 + 1}`, type: "journal", issns: [] } }));
  const docText = "The dataset is publicly available under the CC BY 4.0 license. All experiments use one GPU with 24 GB memory. We extend the robust baseline with localized reconstruction. 工业异常检测是需要研究的具体问题。";
  const sources = {
    async works(query, options = {}) { const p = options.filter ? papers.filter(p => options.filter.endsWith(p.venue.id.split("/").pop())) : papers; return { papers: structuredClone(p), total: p.length * 20, sourceUrl: "https://api.openalex.org/works?search=TEST", retrievedAt: new Date().toISOString() }; },
    async arxiv() { return { papers: [], sourceUrl: "https://export.arxiv.org/api/query?search_query=TEST" }; },
    async groups(query, group) { return { group_by: group === "keywords.id" ? [{ key: "https://openalex.org/keywords/anomaly-localization", key_display_name: "Anomaly localization", count: 10 }] : group === "primary_location.source.id" ? Array.from({ length: 13 }, (_, i) => ({ key: `https://openalex.org/S${100 + i}`, count: 160 - i })) : [year - 3, year - 2, year - 1, year].map((key, i) => ({ key: String(key), count: (i + 1) * (query ? 10 : 100) })), sourceUrl: "https://api.openalex.org/works?group_by=publication_year" }; },
    async source(id) { return { id, type: "journal", display_name: `测试期刊 ${id.split("S").pop()}`, issn: [] }; },
    async document(url) { const p = papers.find(p => url.includes(p.url.split("/").pop())); const text = (p ? p.title + " " : url.includes("github.com/test/") ? papers.map(p => p.title).join("; ") : "") + docText.repeat(16); return { url, text, pages: [{ page: 1, text }], links: ["https://github.com/test/topic-baseline", "https://huggingface.co/datasets/test/topic-data"], retrievedAt: new Date().toISOString() }; },
  };
  const model = async ({ input, json, signal, onDelta }) => {
    signal?.throwIfAborted(); let value;
    if (input.task === "topic_plan") value = { queries: [{ query: "industrial anomaly detection", focus: "分布偏移" }, { query: "few shot anomaly localization", focus: "少样本定位" }, { query: "cross domain anomaly detection", focus: "跨域迁移" }], policyTerms: ["工业", "异常检测"], framing: "从泛化失败到可靠检测" };
    if (input.task === "topic_concepts") value = { concepts: [{ zh: "异常定位", en: "anomaly localization", role: "task", synonyms: [] }], directions: Array.from({ length: input.exploreSubfields ? 6 : 3 }, (_, i) => ({ parent: `测试主线${i % 3}`, name: `测试问题${i}`, problem: "检验分布偏移", terms: [{ zh: "异常定位", en: "anomaly localization", synonyms: ["anomaly detection"] }], context: [] })), policyTerms: ["工业", "异常检测"], framing: "从泛化失败到可靠检测" };
    if (input.task === "topic_shortlist") value = { paperIds: papers.slice(0, 12).map(p => p.id) };
    if (input.task === "topic_directions") value = { directions: ["域偏移下的可靠定位", "少样本检测的稳定性", "可部署的跨域泛化"].map((name, i) => ({ name, problem: `测试示例：${name}还存在哪些可验证问题？`, rationale: "测试示例：依据提供的文献研究泛化边界。", story: "发现分布偏移导致定位失败，提出不变性假设，再用独立测试集验证。", smallPaper: "测试示例：从一个可证伪的泛化假设切入。", critique: "提升可能只来自数据泄漏，需要跨域验证。", experiment: "匹配预算复现，做消融与破坏性实验，提升消失则否定假设。", timeline: "前2月复现，3–4月实验，第5月写作，第6月投稿。", evidenceIds: papers.slice(i * 3, i * 3 + 3).map(p => p.id), baselineIds: papers.slice(i * 3, i * 3 + 3).map(p => p.id), policy: [],
      dataset: { name: "测试数据集", open: true, url: "https://github.com/test/topic-baseline", quote: "The dataset is publicly available under the CC BY 4.0 license.", downloadUrl: "https://huggingface.co/datasets/test/topic-data" },
      hardware: { gpuCount: 1, vramGB: 24, url: "https://github.com/test/topic-baseline", quote: "All experiments use one GPU with 24 GB memory.", note: "测试证据，不是实际硬件建议" }, extensions: [] })) };
    if (input.task === "topic_journal") value = { narrative: "测试统计：完整年度样本呈增长趋势；可能受收录和检索范围影响。", preference: "测试样本更关注泛化、局部定位与跨域验证。", fitReason: "测试示例：与方向的研究问题存在交集。", evidenceIds: input.papers.slice(0, 2).map(p => p.id), cas: null, conference: null, review: null };
    if (input.task === "topic_venues") value = { sourceIds: input.candidates.map(c => c.id), additionalNames: [], rationale: "测试领域匹配" };
    if (input.task === "topic_overview") value = { directionId: input.directions[0].id, recommendation: "测试建议：先试跑首个方向", why: "测试条件匹配", firstWeek: "固定预算复现", boundaries: "测试示例，不是实际建议" };
    if (json === false) { value = "这是一条测试回复。先复现，再验证分布偏移下的失败条件。"; onDelta?.(value); }
    if (input.task === "topic_category") value = { narrative: "测试类别故事线：从单一域的定位走向跨域验证。", critique: "测试反驳：是否只是扩大数据而不是方法改进？", opportunities: "测试问题：在相同数据预算下检验泛化。" };
    return { value, model: { provider: "test", id: "topic-fixture" } };
  };
  return { sources, model, papers, docText, models: async () => [{ provider: "test", id: "topic-fixture", name: "测试模型（不调用外部服务）" }] };
}
