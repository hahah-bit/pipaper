// Retrieval policies are independent of storage, providers and future graph applications.
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stop = new Set(
  "的 了 是 在 和 与 及 什么 如何 是否 请 根据 最新 当前 the a an is are of in on and or to how what does".split(
    " ",
  ),
);
export function terms(text) {
  const words = [
    ...segmenter.segment(String(text).normalize("NFKC").toLowerCase()),
  ]
    .filter((s) => s.isWordLike && !stop.has(s.segment))
    .map((s) => s.segment);
  // Character bigrams complement dictionary segmentation for scientific Chinese terms.
  for (const m of String(text).matchAll(/[\p{Script=Han}]{2,}/gu))
    for (let i = 0; i < m[0].length - 1; i++) words.push(m[0].slice(i, i + 2));
  return words;
}
export function lexicalIndex(documents) {
  const postings = new Map(),
    lengths = [];
  for (const [i, d] of documents.entries()) {
    const tokens = terms(d.searchText),
      counts = new Map();
    lengths.push(tokens.length);
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [term, tf] of counts) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([i, tf]);
    }
  }
  return {
    documents,
    postings,
    lengths,
    average: lengths.reduce((n, v) => n + v, 0) / (lengths.length || 1),
  };
}
export function bm25(query, input, limit = 50) {
  const index = Array.isArray(input) ? lexicalIndex(input) : input,
    scores = new Map();
  for (const term of new Set(terms(query))) {
    const posting = index.postings.get(term) || [],
      idf = Math.log(
        1 +
          (index.documents.length - posting.length + 0.5) /
            (posting.length + 0.5),
      );
    for (const [i, tf] of posting)
      scores.set(
        i,
        (scores.get(i) || 0) +
          (idf * tf * 2.2) /
            (tf +
              1.2 * (0.25 + (0.75 * index.lengths[i]) / (index.average || 1))),
      );
  }
  return [...scores]
    .map(([i, score]) => ({ ...index.documents[i].hit, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
export function fuseRoutes(routes, valid, limit = 80) {
  const fused = new Map();
  for (const route of routes) {
    const seen = new Set();
    let rank = 0;
    for (const hit of route.hits) {
      if (!valid(hit)) continue;
      const key = `${hit.generation_id}:${hit.canonical_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      const row = fused.get(key) || { ...hit, score: 0, retrieval: [] };
      const contribution = (route.weight ?? 1) / (60 + rank);
      row.score += contribution;
      row.retrieval.push({
        route: route.name,
        query: route.query,
        rank,
        rawScore: Number.isFinite(hit.score) ? hit.score : null,
        contribution,
      });
      fused.set(key, row);
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function overlap(a, b) {
  const aa = new Set(terms(a)),
    bb = new Set(terms(b));
  const common = [...aa].filter((t) => bb.has(t)).length;
  return common / (aa.size + bb.size - common || 1);
}
export function boundedText(value, bytes = 7800) {
  let text = String(value || "");
  while (Buffer.byteLength(text) > bytes)
    text = text.slice(0, Math.floor(text.length * 0.9));
  return text.replace(/[\uD800-\uDBFF]$/, "");
}
export function parseDate(value) {
  const m = String(value || "").match(
    /^(19\d{2}|20\d{2})(?:[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?)?/,
  );
  if (!m) return null;
  const year = +m[1],
    month = +(m[2] || 1),
    day = +(m[3] || 1);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const precision = m[3] ? "day" : m[2] ? "month" : "year";
  return {
    value: date.toISOString().slice(0, 10),
    precision,
    end:
      precision === "day"
        ? date.toISOString().slice(0, 10)
        : new Date(Date.UTC(year, precision === "year" ? 12 : month, 0))
            .toISOString()
            .slice(0, 10),
  };
}
export function sourceDate(r, source) {
  const meta = r.metadata || {},
    original = r.sourceType === "original";
  const candidates = original
    ? [
        [meta.publicationDate, "publicationDate"],
        [meta.date, "date"],
        [meta.year, "year"],
      ]
    : [
        [r.contentDate || meta.contentDate, "contentDate"],
        [r.createdAt, "artifactCreatedAt"],
      ];
  for (const [value, basis] of candidates) {
    const date = parseDate(value);
    if (date)
      return {
        ...date,
        basis,
        confidence: "metadata",
        sourcePublication: source ? sourceDate(source) : null,
      };
  }
  // A year in a filename is only a clue; it never drives temporal ranking.
  const clue = String(r.title).match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  return {
    value: null,
    precision: null,
    basis: "unknown",
    confidence: "unknown",
    titleYearClue: clue || null,
  };
}
export function temporalIntent(query, input = {}, now = new Date()) {
  const modes = ["auto", "relevance", "latest", "as_of", "range", "compare"];
  if (!modes.includes(input.mode || "auto")) throw new Error("时间策略无效");
  let mode = input.mode || "auto",
    from = input.from || null,
    to = input.to || null;
  if (mode === "auto") {
    const cutoff =
      query.match(
        /(?:截至|截止|before|as of)\s*(20\d{2}(?:-\d{2}(?:-\d{2})?)?)/i,
      ) || query.match(/(20\d{2})\s*(?:年)?(?:之前|以前|以前的)/);
    const span = query.match(
      /(20\d{2})\s*(?:年)?\s*(?:到|至|—|–|~|to|-)\s*(20\d{2})/i,
    );
    if (cutoff) {
      mode = "as_of";
      to = cutoff[1];
    } else if (span) {
      mode = "range";
      from = span[1];
      to = span[2];
    } else if (
      /演变|历史|对比.*(?:新旧|年份)|historical|evolution|over time/i.test(
        query,
      ) ||
      (/比较|对比|compare|versus|\bvs\b/i.test(query) &&
        new Set(query.match(/20\d{2}/g) || []).size > 1)
    )
      mode = "compare";
    else if (
      /最新|近期|当前|现阶段|近[一二三四五十\d]+年|latest|recent|current|state.of.the.art/i.test(
        query,
      )
    )
      mode = "latest";
    else mode = "relevance";
  }
  const first = from ? parseDate(from) : null,
    last = to ? parseDate(to) : null;
  if (
    (from && !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(from)) ||
    (to && !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(to)) ||
    (from && !first) ||
    (to && !last) ||
    (mode === "as_of" && !last) ||
    (mode === "range" && (!first || !last)) ||
    (first && last && first.value > last.end)
  )
    throw new Error("请提供有效的时间范围");
  return {
    mode,
    from: first?.value || null,
    to: last?.end || null,
    now: now.toISOString().slice(0, 10),
    scope: "indexed-library",
  };
}
export function timeFit(date, intent) {
  if (!date.value)
    return {
      eligible: true,
      score: 0.5,
      warning: "来源时间未知，无法确认时间适用性",
    };
  if (
    (intent.to && date.value > intent.to) ||
    (intent.from && date.end < intent.from)
  )
    return { eligible: false, score: 0, warning: "来源时间超出任务指定范围" };
  if (date.value > intent.now)
    return {
      eligible: true,
      score: 0.5,
      warning: "来源日期晚于检索日期，可能是会议预定年份，须核对",
    };
  if (intent.to && date.end > intent.to)
    return {
      eligible: true,
      score: 0.5,
      warning: "日期精度不足，可能跨越指定截止时间",
    };
  if (intent.mode === "latest" && date.basis === "artifactCreatedAt") {
    const source = date.sourcePublication;
    return {
      eligible: true,
      score: source?.value
        ? Math.exp(
            -Math.max(0, Date.parse(intent.now) - Date.parse(source.value)) /
              (365.25 * 86400000 * 3),
          )
        : 0.5,
      warning: "成果生成时间不能证明其来源知识更新，需核对来源文献日期",
    };
  }
  if (intent.mode === "latest")
    return {
      eligible: true,
      score: Math.exp(
        -Math.max(0, Date.parse(intent.now) - Date.parse(date.value)) /
          (365.25 * 86400000 * 3),
      ),
    };
  return { eligible: true, score: 1 };
}
export function temporalPairs(rows, intent, threshold = 0.9) {
  const pairs = [];
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i],
        b = rows[j];
      if (a.resourceId === b.resourceId) continue;
      const semantic = cosine(a.vector, b.vector),
        lexical = overlap(a.evidenceText, b.evidenceText);
      if (semantic < threshold && lexical < 0.65) continue;
      let preferred = null,
        reason;
      if (!a.date.value || !b.date.value)
        reason = "相似证据存在未知来源时间，不能自动断言哪条更新";
      else if (a.date.value === b.date.value) {
        reason = "相似证据日期相同，按相关性评估；相似向量不能证明事实一致";
      } else if (
        intent.mode === "latest" &&
        (a.date.basis === "artifactCreatedAt") !==
          (b.date.basis === "artifactCreatedAt")
      ) {
        reason =
          "成果生成时间与文献发表时间不是同一口径，不能据此判定哪条研究更新";
      } else if (
        intent.mode === "latest" &&
        !a.temporal.warning &&
        !b.temporal.warning
      ) {
        preferred = a.date.value > b.date.value ? a.id : b.id;
        reason =
          "任务要求近期信息，优先较新且相关的证据；较旧证据保留用于核对变化";
      } else if (["as_of", "range"].includes(intent.mode)) {
        preferred =
          a.temporal.eligible !== b.temporal.eligible
            ? a.temporal.eligible
              ? a.id
              : b.id
            : null;
        reason = "按任务指定时间窗口判断，窗口外证据不用于回答";
      } else
        reason =
          intent.mode === "compare"
            ? "历史对比任务应同时保留两个时间点"
            : "任务没有要求最新，时间差不代表旧证据失效";
      pairs.push({
        ids: [a.id, b.id],
        similarity: Math.max(semantic, lexical),
        method: semantic >= threshold ? "embedding-cosine" : "token-overlap",
        dates: [a.date, b.date],
        preferred,
        reason,
        warning: "向量相似不代表结论相同或旧信息已被取代",
      });
    }
  return pairs.slice(0, 30);
}
export function diversify(rows, limit, intent, lambda = 0.85) {
  const selected = [],
    rest = [...rows];
  while (rest.length && selected.length < limit) {
    let best = 0,
      score = -Infinity;
    rest.forEach((r, i) => {
      const redundancy = Math.max(
        0,
        ...selected.map((s) => {
          // Preserve different dated sources for comparison rather than collapsing them.
          if (
            r.resourceId !== s.resourceId &&
            r.date.value !== s.date.value &&
            intent.mode === "compare"
          )
            return 0;
          return (
            cosine(r.vector, s.vector) ||
            overlap(r.evidenceText, s.evidenceText)
          );
        }),
      );
      const value = lambda * r.relevance - (1 - lambda) * redundancy;
      if (value > score) {
        score = value;
        best = i;
      }
    });
    selected.push(rest.splice(best, 1)[0]);
  }
  return selected;
}
