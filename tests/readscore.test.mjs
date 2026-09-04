import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, relevanceScore, venueScore, recencyScore, impactScore, accessScore,
  localScore, scoreResult, rankResults,
} from "../server/search/readscore.js";

const NOW = 2026;

test("tokenize 丢弃停用词与纯数字，保留术语", () => {
  const t = tokenize("Neural Combinatorial Optimization for the VRP: a survey (2024)");
  assert.ok(t.includes("neural") && t.includes("optimization") && t.includes("vrp"));
  assert.ok(!t.includes("for") && !t.includes("the") && !t.includes("2024"));
});

test("相关性：标题命中 > 摘要命中 > 无命中", () => {
  const q = "vehicle routing neural";
  const hitTitle = relevanceScore({ title: "Neural Vehicle Routing", abstract: "", keywords: [] }, q);
  const hitAbs = relevanceScore({ title: "Something Else", abstract: "we study vehicle routing with neural nets", keywords: [] }, q);
  const miss = relevanceScore({ title: "Quantum Chemistry", abstract: "molecular dynamics", keywords: [] }, q);
  assert.ok(hitTitle.score > hitAbs.score && hitAbs.score > miss.score);
  assert.equal(miss.score, 0);
  assert.equal(hitTitle.max, 30);
});

test("venue：Q1 > Q2 > 预印本 > 无分区 > 未知来源", () => {
  const s = (r) => venueScore(r).score;
  const q1 = s({ quartile: "Q1", venue: "IEEE T-ITS" });
  const q2 = s({ quartile: "Q2", venue: "EJOR" });
  const pre = s({ source: "arxiv", venue: "arXiv" });
  const known = s({ venue: "NeurIPS Proceedings" });
  const unknown = s({ venue: "" });
  assert.ok(q1 > q2 && q2 > pre && pre > known && known > unknown);
  assert.equal(venueScore({ source: "arxiv", venue: "arXiv" }).label, "预印本");
});

test("新近性：近 3 年分高，老论文低，未知年份中性", () => {
  assert.ok(recencyScore({ year: NOW - 1 }, NOW).score > recencyScore({ year: NOW - 4 }, NOW).score);
  assert.ok(recencyScore({ year: NOW - 4 }, NOW).score > recencyScore({ year: 1998 }, NOW).score);
  assert.equal(recencyScore({ year: null }, NOW).score, 5);
});

test("影响力按年归一化：新论文 60 引胜过老论文 60 引", () => {
  const fresh = impactScore({ citations: 60, year: NOW - 1 }, NOW);
  const old = impactScore({ citations: 60, year: NOW - 25 }, NOW);
  assert.ok(fresh.score > old.score);
  assert.equal(impactScore({ citations: null }, NOW).score, 4);
  // 25 次/年 → 满分
  assert.equal(impactScore({ citations: 500, year: NOW - 20 }, NOW).score, 15);
});

test("可获取性：PDF 直链 > OA 落地页 > 无", () => {
  assert.ok(accessScore({ pdfUrl: "https://x/y.pdf", oa: true }).score > accessScore({ pdfUrl: "", oa: true }).score);
  assert.equal(accessScore({ pdfUrl: "", oa: false }).score, 0);
});

const ROUTING_ABS = "We study neural combinatorial optimization for vehicle routing problems (VRP) with reinforcement learning.";

// 复刻 paperTokens 的加权方式构造向量（避免依赖 store 里的真实文献库）
function manualVec(p) {
  const m = new Map();
  for (const [toks, w] of [[tokenize(p.title), 3], [tokenize(p.abstract), 1]]) {
    for (const t of toks) m.set(t, Math.max(m.get(t) || 0, w));
  }
  return m;
}

test("本地关联度：同主题命中 > 无关", () => {
  const docVec = { title: "Neural Combinatorial Optimization for Vehicle Routing", abstract: ROUTING_ABS, keywords: [], authors: [], year: 2026 };
  // 直接用内部逻辑：构造带向量的 profile
  const prof = {
    docs: [{ id: "p1", title: "Neural Combinatorial Optimization for Vehicle Routing", vec: manualVec(docVec) }],
    anchor: null, scope: "project", total: 1,
  };
  const related = localScore({ title: "Deep RL for Dynamic Vehicle Routing", abstract: "neural combinatorial optimization for VRP routes", keywords: [], authors: [] }, prof);
  const unrelated = localScore({ title: "Protein Folding Prediction", abstract: "amino acid structures", keywords: [], authors: [] }, prof);
  assert.ok(related.score > unrelated.score);
  assert.equal(unrelated.score, 0);
});

test("scoreResult：汇总不超 100，解释齐全，标记正确", () => {
  const prof = {
    docs: [{ id: "p1", title: "Neural Combinatorial Optimization for Vehicle Routing", vec: manualVec({ title: "Neural Combinatorial Optimization for Vehicle Routing", abstract: ROUTING_ABS }) }],
    anchor: { id: "p1", title: "Neural Combinatorial Optimization for Vehicle Routing", vec: manualVec({ title: "Neural Combinatorial Optimization for Vehicle Routing", abstract: ROUTING_ABS }) },
    scope: "project", total: 1,
  };
  const r = scoreResult({
    title: "Reinforcement Learning for Vehicle Routing Problems", abstract: ROUTING_ABS, keywords: ["vehicle routing"],
    authors: ["J. Doe"], year: NOW - 1, citations: 40, quartile: "Q1", oa: true, pdfUrl: "https://x/y.pdf", venue: "EJOR", source: "crossref",
  }, "vehicle routing neural", prof, NOW);
  assert.ok(r.readScore > 80 && r.readScore <= 100);
  assert.equal(Object.keys(r.scoreParts).length, 6);
  assert.equal(r.explain.length, 6);
  assert.ok(r.explain.every((x) => /（\d+\/\d+）$/.test(x)));
  assert.equal(r.localRel, "强");
  assert.ok(r.relCurrent && r.relProject);
  // 经典标记：老 + 高被引
  const classic = scoreResult({ title: "A study", abstract: "", keywords: [], authors: [], year: 2010, citations: 900, venue: "", source: "x" }, "study", { docs: [], anchor: null }, NOW);
  assert.ok(classic.classic);
});

test("rankResults：recommended 按 ReadScore 降序，local 按本地相似度降序", () => {
  const prof = { docs: [], anchor: null, scope: "none", total: 0 };
  const mk = (over) => ({ title: "t", abstract: "", keywords: [], authors: [], source: "s", venue: "", ...over });
  const strong = mk({ title: "vehicle routing neural exact match", abstract: "vehicle routing neural", year: NOW - 1, citations: 300, quartile: "Q1", pdfUrl: "https://x/y.pdf", oa: true });
  const weak = mk({ title: "unrelated topic", abstract: "other stuff", year: 2001, citations: 2 });
  const ranked = rankResults([weak, strong], "vehicle routing neural", { profile: prof, sort: "recommended", nowYear: NOW });
  assert.ok(ranked[0].readScore >= ranked[1].readScore);
  assert.equal(ranked[0].title, strong.title);
  // local 排序：本地相似度优先于总分
  const a = mk({ title: "vehicle routing neural exact match", abstract: "vehicle routing neural", year: 2010, citations: 5 });
  const b = mk({ title: "somewhat related routing", abstract: "routing", year: NOW - 1, citations: 0, quartile: "Q1", pdfUrl: "https://x/y.pdf", oa: true });
  const docVec = manualVec({ title: "dynamic routing with deep reinforcement", abstract: "vehicle routing deep reinforcement learning" });
  const prof2 = { docs: [{ id: "d", title: "dynamic routing", vec: docVec }], anchor: null, scope: "project", total: 1 };
  const rankedLocal = rankResults([b, a], "routing", { profile: prof2, sort: "local", nowYear: NOW });
  assert.equal(rankedLocal[0].title, a.title); // a 与画像重叠更大（vehicle routing neural）
});
