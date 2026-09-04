// ReadScore — "最该读"排序的评分器（满分 100）：
//   30 相关性 + 20 venue/分区 + 15 新近性 + 15 影响力 + 10 可获取性 + 10 本地关联度
// 评分核心是纯函数（输入 result + 画像），便于测试；画像构建走 store（本地文献库/项目）。
import { listPapers, getPaper, readBlocks, getProject } from "../store.js";

const STOP = new Set(
  ("a an and are as at be based by can could do does for from has have how in into is it its may might must of on or " +
    "our ours that the their them then there these this those to toward towards under via was we what when where which " +
    "while who why will with within without would you your using use used using novel paper study approach method methods " +
    "result results propose proposed proposes present presented show shows shown demonstrate demonstrated also such more " +
    "most between among during through over about after before both each other same only some any all not no than thus " +
    "however therefore their well make makes made new first second third et al")
    .split(" ")
);

// 中英通用分词：英文按非字母数字切，CJK 连续段保留为整体
export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP.has(t));
}

// parts: [tokens, weight][] → 稀疏权重向量
function vec(parts) {
  const m = new Map();
  for (const [toks, w] of parts) {
    for (const t of toks || []) m.set(t, Math.max(m.get(t) || 0, w));
  }
  return m;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [t, w] of b) {
    nb += w * w;
    const wa = a.get(t);
    if (wa) dot += wa * w;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---- 画像：本地文献库 / 当前项目 / 当前论文 ----
function paperTokens(p, parsed) {
  const sections = (parsed?.sections || []).filter((s) => (s.level || 9) <= 2).slice(0, 30).map((s) => s.title);
  return vec([
    [tokenize(p.title), 3],
    [(p.keywords || []).flatMap((k) => tokenize(k)), 2.5],
    [(p.authors || []).flatMap((a) => tokenize(a).filter((t) => t.length >= 3)), 1.5],
    [tokenize(p.abstract), 1],
    [tokenize(sections.join(" ")), 1.5],
  ]);
}

function loadDocTokens(paperId) {
  try {
    return readBlocks(paperId);
  } catch {
    return null;
  }
}

// profile = { docs: [{id,title,vec}], anchor: {id,title,vec}|null, scope: "project"|"library"|"none" }
export function buildLocalProfile({ projectId, anchorPaperId, maxDocs = 80 } = {}) {
  const all = listPapers();
  let scope = "library";
  let pool = all;
  const proj = projectId ? getProject(projectId) : null;
  if (proj && (proj.paperIds || []).length) {
    pool = proj.paperIds.map((id) => getPaper(id)).filter(Boolean);
    scope = "project";
  }
  const docs = pool.slice(0, maxDocs).map((p) => ({
    id: p.id,
    title: p.title,
    vec: paperTokens(p, loadDocTokens(p.id)),
  }));
  let anchor = null;
  const ap = anchorPaperId ? getPaper(anchorPaperId) : null;
  if (ap) anchor = { id: ap.id, title: ap.title, vec: paperTokens(ap, loadDocTokens(ap.id)) };
  return { docs, anchor, scope, total: all.length };
}

function relLabel(localScore) {
  return localScore >= 8 ? "强" : localScore >= 5 ? "中" : localScore >= 2 ? "弱" : "无";
}

// ---- 各维度 ----

// 30 相关性：检索词在 标题(1.0)/关键词(0.7)/摘要(0.5) 的加权命中率
export function relevanceScore(r, query) {
  const qTokens = tokenize(query).slice(0, 12);
  if (!qTokens.length) return { score: 15, max: 30, why: "无有效检索词，给中性分" };
  const title = new Set(tokenize(r.title));
  const kw = new Set((r.keywords || []).flatMap((k) => tokenize(k)));
  const abs = new Set(tokenize(r.abstract));
  let hit = 0, full = 0;
  for (const t of qTokens) {
    const w = title.has(t) ? 1 : kw.has(t) ? 0.7 : abs.has(t) ? 0.5 : 0;
    if (w > 0) full++;
    hit += w;
  }
  const score = Math.round(30 * Math.min(1, hit / qTokens.length));
  const where = qTokens.some((t) => title.has(t)) ? "标题命中" : full ? "摘要/关键词命中" : "匹配弱";
  return { score, max: 30, why: `${where} ${full}/${qTokens.length} 个检索词` };
}

// 20 venue/分区：Q1/Q2 优先；arXiv 标“预印本”不重罚；无分区的正式来源给中性分
export function venueScore(r) {
  const q = r.quartile;
  if (q === "Q1") return { score: 20, max: 20, label: "Q1", why: "Q1 期刊/会议" };
  if (q === "Q2") return { score: 15, max: 20, label: "Q2", why: "Q2 期刊/会议" };
  if (q === "Q3") return { score: 9, max: 20, label: "Q3", why: "Q3 期刊/会议" };
  if (q === "Q4") return { score: 4, max: 20, label: "Q4", why: "Q4 期刊/会议" };
  const preprint = (r.sources || [r.source]).includes("arxiv") || /arxiv/i.test(r.venue || "");
  if (preprint) return { score: 10, max: 20, label: "预印本", why: "预印本（arXiv），无分区不重罚" };
  if (r.venue) return { score: 8, max: 20, label: "无分区", why: "有来源但不在 SJR 目录（会议/新刊）" };
  return { score: 5, max: 20, label: "未知来源", why: "来源未知" };
}

// 15 新近性：CS 近 3-5 年权重高；经典论文靠影响力维度得分，不在这里补偿
export function recencyScore(r, nowYear) {
  if (!r.year) return { score: 5, max: 15, why: "年份未知，给中性分" };
  const age = nowYear - r.year;
  let score, why;
  if (age <= 1) { score = 15; why = `${r.year} 年，最新`; }
  else if (age <= 3) { score = 13; why = `${r.year} 年，近 3 年`; }
  else if (age <= 5) { score = 10; why = `${r.year} 年，近 5 年`; }
  else if (age <= 8) { score = 6; why = `${r.year} 年`; }
  else { score = 2; why = `${r.year} 年，较早期文献`; }
  return { score, max: 15, why };
}

// 15 影响力：引用数按“被引/年限”归一化，避免老论文天然碾压；无数据给保守中性分
export function impactScore(r, nowYear) {
  if (r.citations == null) return { score: 4, max: 15, why: "无被引数据，保守计分" };
  const age = Math.max(1, nowYear - (r.year || nowYear));
  const cpy = (r.citations || 0) / age; // 次/年，25 次/年 → 满分
  const score = Math.round(15 * Math.min(1, Math.log10(1 + cpy) / Math.log10(1 + 25)));
  return { score, max: 15, why: `被引 ${r.citations} 次 ≈ ${cpy.toFixed(1)} 次/年` };
}

// 10 可获取性：有直接 PDF 链接满分，仅 OA 落地页折半
export function accessScore(r) {
  if (r.pdfUrl) return { score: 10, max: 10, why: "有开放 PDF 直链" };
  if (r.oa) return { score: 6, max: 10, why: "开放获取（落地页）" };
  return { score: 0, max: 10, why: "未发现开放全文" };
}

// 10 本地关联度：与库/项目论文的 加权余弦 相似度，取最相近的一篇定档
export function localScore(r, profile) {
  if (!profile?.docs?.length) return { score: 0, max: 10, level: "none", why: "本地文献库为空" };
  const rv = vec([
    [tokenize(r.title), 3],
    [(r.keywords || []).flatMap((k) => tokenize(k)), 2.5],
    [(r.authors || []).flatMap((a) => tokenize(a).filter((t) => t.length >= 3)), 1.5],
    [tokenize(r.abstract), 1],
  ]);
  let best = 0, bestDoc = null, near = 0;
  for (const d of profile.docs) {
    const s = cosine(rv, d.vec);
    if (s > best) { best = s; bestDoc = d; }
    if (s >= 0.12) near++;
  }
  // 0.30+ 强相似；映射到 0-10
  const score = Math.round(10 * Math.min(1, best / 0.3));
  const anchorSim = profile.anchor ? cosine(rv, profile.anchor.vec) : 0;
  const bits = [];
  if (bestDoc && score > 0) {
    bits.push(`与库中《${String(bestDoc.title).slice(0, 30)}》最相近（${best.toFixed(2)}）`);
    if (near > 1) bits.push(`另有 ${near - 1} 篇共享术语`);
  } else {
    bits.push("与本地库无明显重合");
  }
  return { score, max: 10, level: relLabel(score), sim: +best.toFixed(3), anchorSim: +anchorSim.toFixed(3), near, why: bits.join("，") };
}

// ---- 汇总：给一条结果打分并生成解释 ----
export function scoreResult(r, query, profile, nowYear) {
  const rel = relevanceScore(r, query);
  const ven = venueScore(r);
  const rec = recencyScore(r, nowYear);
  const imp = impactScore(r, nowYear);
  const acc = accessScore(r);
  const loc = localScore(r, profile);
  const readScore = Math.min(100, rel.score + ven.score + rec.score + imp.score + acc.score + loc.score);
  return {
    ...r,
    readScore,
    scoreParts: { rel: rel.score, venue: ven.score, recency: rec.score, impact: imp.score, access: acc.score, local: loc.score },
    localRel: loc.level,
    localSim: loc.sim ?? 0,
    // 标记：与当前论文/项目库相关；基础经典（年限×被引）
    relCurrent: !!(profile?.anchor && loc.anchorSim >= 0.22),
    relProject: loc.level === "强" || loc.level === "中",
    classic: r.year && nowYear - r.year >= 7 && (r.citations || 0) >= 150,
    explain: [rel, ven, rec, imp, acc, loc].map((x) => `${x.why}（${x.score}/${x.max}）`),
  };
}

// 对聚合结果批量评分 + 排序（sort: recommended 默认 | local | 其他由外层处理）
export function rankResults(results, query, { projectId, anchorPaperId, profile, sort, nowYear = new Date().getFullYear() } = {}) {
  const prof = profile || buildLocalProfile({ projectId, anchorPaperId });
  const scored = results.map((r) => scoreResult(r, query, prof, nowYear));
  if (sort === "local") {
    scored.sort((a, b) => (b.localSim - a.localSim) || (b.readScore - a.readScore));
  } else if (!sort || sort === "recommended") {
    scored.sort((a, b) => (b.readScore - a.readScore) || (b.localSim - a.localSim));
  }
  return scored;
}
