import { el } from "./platform/dom.js";

export const retrievalStages = {
  rewrite: "理解问题与改写",
  recall: "多路召回",
  rerank: "相关度重排",
  reflect: "检查证据覆盖",
  retry: "补充检索",
  temporal: "比较相似证据与时间",
  analyze: "分析原文证据",
  verify: "核对分析引用",
  complete: "检索完成",
};
const routeNames = {
  "body-dense": "正文语义",
  "body-bm25": "正文关键词",
  "elements-dense": "图表公式语义",
  "elements-bm25": "图表公式关键词",
  "catalog-bm25": "本地原文关键词",
  "title-metadata": "标题与元数据",
  "element-number": "图表公式编号",
};
export const retrievalRouteName = (name) => routeNames[name] || name;
export function evidenceDate(date) {
  if (!date?.value) return "未知";
  return date.precision === "year"
    ? date.value.slice(0, 4) + "（仅年份）"
    : date.precision === "month"
      ? date.value.slice(0, 7) + "（仅月份）"
      : date.value;
}
export async function streamKnowledgeSearch(options, { signal, onProgress }) {
  const response = await fetch("/api/rag/search/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    signal,
  });
  if (!response.ok) throw new Error("检索服务请求失败：" + response.status);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    result;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "progress") onProgress?.(event.value);
    if (event.type === "result") result = event.value;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
      if (done) break;
    }
    consume(buffer);
    if (!result) throw new Error("检索连接中断，请重试");
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function renderRetrievalAnalysis(data, container, focusEvidence) {
  const results = new Map(data.results.map((r) => [r.id, r]));
  const cite = (id) => {
    const row = results.get(id);
    return el(
      "button",
      {
        class: "knowledge-citation",
        onclick: () => focusEvidence(id),
        title: row?.title || id,
      },
      row?.citationId || "证据",
    );
  };
  if (data.analysis && data.analysis.status !== "disabled") {
    const states = {
      supported: "已有证据支持",
      partial: "部分问题仍缺证据",
      insufficient: "证据不足",
      unavailable: "分析未完成",
    };
    const card = el(
      "section",
      { class: "storage-card knowledge-analysis" },
      el("h3", {}, "证据分析"),
      el("p", { class: "res-note" }, states[data.analysis.status] || "待核对"),
    );
    for (const claim of data.analysis.claims || [])
      card.append(el("p", {}, claim.text, " ", ...claim.citations.map(cite)));
    if (!data.analysis.claims?.length)
      card.append(
        el("p", {}, "尚无通过引用核对的分析结论，请查看下方原文证据。"),
      );
    if (data.analysis.gaps?.length)
      card.append(
        el(
          "details",
          { open: true },
          el("summary", {}, "尚未解决"),
          el(
            "ul",
            {},
            ...data.analysis.gaps.map((g) => el("li", {}, String(g))),
          ),
        ),
      );
    container.append(card);
  }
  if (data.warnings?.length || data.temporal?.pairs?.length) {
    const card = el(
      "section",
      { class: "storage-card knowledge-warning", role: "status" },
      el("h3", {}, "时间与证据提醒"),
    );
    card.append(
      el("ul", {}, ...(data.warnings || []).map((w) => el("li", {}, w))),
    );
    for (const pair of data.temporal?.pairs || []) {
      const comparison = data.analysis?.comparisons?.find((c) =>
        c.ids.every((id) => pair.ids.includes(id)),
      );
      card.append(
        el(
          "details",
          {},
          el(
            "summary",
            {},
            "相似来源 · " + pair.dates.map(evidenceDate).join(" / "),
          ),
          ...pair.sources.map((s, i) =>
            el(
              "p",
              {},
              `${s.title} · ${evidenceDate(pair.dates[i])}${s.eligible ? "" : " · 超出时间范围"} `,
              ...(results.has(s.id) ? [cite(s.id)] : []),
            ),
          ),
          el("p", {}, comparison?.reason || pair.reason),
          el("p", { class: "res-note" }, pair.warning),
        ),
      );
    }
    container.append(card);
  }
  if (data.retrieval) {
    const details = el(
      "details",
      { class: "knowledge-trace" },
      el(
        "summary",
        {},
        `检索过程 · ${data.retrieval.rounds} 轮 · ${data.retrieval.candidates} 个候选`,
      ),
    );
    details.append(
      el("p", {}, data.retrieval.rewrite.rationale),
      el("ol", {}, ...data.retrieval.queries.map((q) => el("li", {}, q))),
    );
    details.append(
      el(
        "ul",
        {},
        ...data.retrieval.routes.map((r) =>
          el(
            "li",
            {},
            `${retrievalRouteName(r.name)}：${r.count} 条${r.error ? " · 不可用" : ""}`,
          ),
        ),
      ),
    );
    container.append(details);
  }
}
