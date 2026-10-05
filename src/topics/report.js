import { node, button, markdown, dialog } from "../study/ui.js";
import { trendChart, radarChart } from "./charts.js";

export function link(label, url, className = "source-link") {
  try { const u = new URL(url); if (u.protocol !== "https:") throw new Error(); return node("a", { href: u.href, target: "_blank", rel: "noopener noreferrer", class: className }, label); }
  catch { return node("span", { class: "muted" }, `${label}（暂无链接）`); }
}
const pill = text => node("span", { class: "topic-pill" }, text);
function baseline(p, main = false, extensions = []) {
  const root = node("article", { class: main ? "baseline-main" : "baseline-small" }, node("div", { class: "baseline-meta" }, pill(main ? "主 Baseline · 从复现开始" : "对照 Baseline"), node("span", {}, `${p.date} · ${p.citations == null ? "引用量未提供" : `${p.citations}次引用`}`)), node(main ? "h3" : "h4", {}, p.title),
    main && node("p", {}, p.abstract?.slice(0, 650) || "该论文暂无可用摘要，请查看原文。"), p.availabilityNote && node("p", { class: "muted" }, p.availabilityNote),
    p.quality?.eligible ? node("div", { class: "baseline-verification" }, pill(p.quality.system === "CAS" ? `中科院1区 · ${p.quality.year}` : `CCF A · ${p.quality.venue} · 目录${p.quality.year}`), link("正式发表记录 ↗", p.quality.publicationUrl), p.quality.sourceTable ? node("span", { class: "muted" }, `分区依据：导入的官方分区表 ${p.quality.year} 年版`) : link("分区 / 目录依据 ↗", p.quality.sourceUrl)) : node("p", { class: "inline-error" }, "历史结果未通过当前 Baseline 来源标准，请重新分析。"),
    node("div", { class: "topic-actions" }, link(p.pdf ? "论文 PDF ↗" : "论文原文 ↗", p.pdf || p.url), ...(p.code || []).flatMap(c => [link("作者项目仓库 ↗", c.url), c.downloadUrl && link("下载仓库 ZIP ↗", c.downloadUrl)]), !(p.code || []).length && node("small", { class: "muted" }, "代码入口未核实")));
  root.append(node("details", { class: "extension-capsule" }, node("summary", {}, `后续工作与改进关系 ${extensions.length ? `· ${extensions.length}篇` : "· 暂无已核实关系"}`),
    extensions.length ? extensions.map(e => node("div", { class: "extension-item" }, node("strong", {}, e.paper.title), node("p", {}, e.change), link("论文 / 下载", e.paper.pdf || e.paper.url), (e.paper.code || []).map(c => link("代码", c.url)), node("small", {}, e.quote))) : node("p", { class: "muted" }, "只有引用关系和原文明示的改进才归入此处，相关论文不自动视为衍生工作。")));
  return root;
}
export function directionDetail(d) {
  const body = node("div", { class: "direction-detail" }, node("p", { class: "eyebrow" }, d.name), node("h2", {}, d.problem),
    node("div", { class: d.eligible ? "evidence-callout" : "evidence-callout amber" }, d.eligible ? "公开数据与执行路线有原文依据；耗时、费用和创新性仍须首周试跑确认。" : d.filterReasons.join("；")),
    node("h3", {}, "为什么值得做"), markdown(d.rationale), node("h3", {}, "大课题的故事主线"), markdown(d.story), node("h3", {}, "可以落地的小论文"), markdown(d.smallPaper),
    node("h3", {}, "审稿人会如何挑刺"), markdown(d.critique), node("h3", {}, "用实验回答反驳"), markdown(d.experiment), node("h3", {}, "周期与阶段目标"), markdown(d.timeline || "周期尚待估算"),
    node("h3", {}, "政策与基金：原文 → 科学问题"),
    d.policy.length ? d.policy.map(p => node("blockquote", {}, node("p", {}, p.quote), link("查看官方原文 ↗", p.url), markdown(p.implication))) : node("p", { class: "muted" }, "尚无与本问题直接匹配的政策引文，不把宽泛政策表述当作创新性依据。"),
    node("div", { class: "form-grid" }, node("section", { class: "evidence-box" }, node("h4", {}, "数据可用性"), node("p", {}, d.dataset.name || "待核实"), node("p", {}, d.dataset.note || (d.dataset.status === "open-evidence" ? "已找到公开证据与下载入口" : "尚未确认开放")), d.dataset.quote && node("blockquote", {}, d.dataset.quote), d.dataset.url && link("许可 / 声明", d.dataset.url), d.dataset.downloadUrl && link("数据入口 ↗", d.dataset.downloadUrl)),
      node("section", { class: "evidence-box" }, node("h4", {}, "硬件匹配"), node("p", {}, d.hardware.status === "reported" ? `${d.hardware.gpuCount} 张 GPU · 单卡 ${d.hardware.vramGB} GB` : "待核实"), node("p", {}, d.hardware.note), d.hardware.quote && node("blockquote", {}, d.hardware.quote), d.hardware.url && link("硬件原文", d.hardware.url))),
    node("h3", {}, "近三年 Baseline 路线"), d.baselines.map((p, i) => baseline(p, i === 0, d.extensions.filter(e => e.parentId === p.id))),
    node("h3", {}, "这个方向的投稿落点"), (d.journalTargets || []).length ? d.journalTargets.map(j => node("section", { class: "evidence-box" }, link(j.name, j.url), node("p", {}, `${j.match ?? "—"} 分 · ${j.reason}`))) : node("p", { class: "muted" }, "尚未取得方向与具体期刊的匹配证据，可查看期刊报告继续比较。"),
    node("h3", {}, "论据文献"), d.evidence.map(p => node("div", { class: "evidence-reference" }, link(p.title, p.url), node("small", {}, `${p.date} · ${p.source}`))));
  const dlg = dialog("方向详细报告", body); dlg.classList.add("report-dialog");
}
export function directionCards(report) {
  const root = node("div", { class: "report-directions" }, node("div", { class: "report-heading" }, node("div", {}, node("p", { class: "eyebrow" }, "THE RESEARCH SHORTLIST"), node("h2", {}, "先看值得研究的问题")), node("span", { class: "count-badge" }, String(report.conclusions.length + report.pending.length).padStart(2, "0"))),
    node("p", { class: "muted" }, `基于 ${report.corpusSize} 篇去重检索候选 · ${report.recentSize} 篇通过近期 Baseline 来源核验 · ${new Date(report.createdAt).toLocaleDateString()}`));
  if (report.conclusions.length + report.pending.length) root.append(node("p", { class: "muted" }, `${report.conclusions.length + report.pending.length} 个候选方向 · ${report.conclusions.length} 个通过资源约束核验 · ${report.pending.length} 个待核验 / 暂不匹配`));
  const cards = (rows, pending = false) => rows.map((d, i) => {
    const b = node("button", { class: "direction-card" + (pending ? " pending" : ""), type: "button", onclick: () => directionDetail(d) }, node("div", { class: "direction-top" }, node("span", { class: "direction-number" }, String(i + 1).padStart(2, "0")), pill(d.name), node("span", { class: "card-arrow" }, "↗")), node("h3", {}, d.problem), node("p", {}, d.smallPaper),
      node("div", { class: "direction-bottom" }, node("span", {}, pending ? "◷ " + d.filterReasons.join(" · ") : "✓ 数据与执行路线有据"), node("small", {}, "3 篇近期 Baseline →")),
      node("div", { class: "baseline-preview" }, node("small", {}, "主 BASELINE"), node("span", {}, d.baselines[0].title)));
    return b;
  });
  if (report.overview) root.append(node("section", { class: "report-recommendation" }, node("p", { class: "eyebrow" }, "建议先从这里开始"), node("h3", {}, report.overview.recommendation), markdown(report.overview.why), node("h4", {}, "第一周怎么验证"), markdown(report.overview.firstWeek), node("p", { class: "muted" }, report.overview.boundaries)));
  root.append(...cards(report.conclusions));
  if (!report.conclusions.length) root.append(node("div", { class: "evidence-callout amber" }, report.phase === "evidence" ? "检索已结束，但通过发表核验的论文不足，暂不能生成可靠的方向结论。请查看下方诊断及中栏来源记录，修复来源或补充证据后重新分析。" : "暂未获得同时满足约束的方向。下面保留有研究价值但证据或资源条件不足的候选。"));
  if (report.pending.length) root.append(node("h3", { class: "pending-heading" }, "待核验 / 暂不匹配"), ...cards(report.pending, true));
  root.append(node("section", { class: "keyword-section" }, node("h3", {}, "近三个完整年度 · 具体关键词"), node("p", { class: "muted" }, report.keywordMethod || "去重论文样本内，每篇每词计一次；已排除学科门类。"), node("div", { class: "keyword-list" }, report.keywords.map(k => node("span", { title: Object.entries(k.years).map(([y, n]) => `${y}：${n ?? "未进入该年top200，未知"}`).join("；") }, k.name, node("b", {}, k.count))))));
  return root;
}
export function journalCards(report) {
  const root = node("div", {}, node("p", { class: "eyebrow" }, "WHERE YOUR WORK COULD BELONG"), node("h2", {}, "寻找适合讲这个故事的期刊"), node("p", { class: "muted" }, "中科院分区、会议等级独立核验。匹配分来自可解释统计，不代表录用率。"));
  if (report.status === "partial") root.append(node("p", { class: "evidence-callout" }, `当前为阶段报告，已保存 ${report.journals.length} 个来源。期刊统计尚未全部完成，可先查看方向结论。`));
  const filters = node("div", { class: "journal-filters" }), grid = node("div", { class: "journal-grid" });
  const definitions = [["all", "全部"], ["cas1", "中科院1区"], ["cas2", "中科院2区"], ["cas3", "中科院3区"], ["cas4", "中科院4区"], ["conference", "会议"], ["unknown", "待核验分区"]];
  const matches = (j, key) => key === "all" || key === "conference" && j.type === "conference" || key === "unknown" && j.type === "journal" && !j.cas || key.startsWith("cas") && j.cas?.zone === Number(key.slice(3));
  const draw = key => {
    [...filters.children].forEach(b => b.classList.toggle("active", b.dataset.key === key));
    const rows = report.journals.filter(j => matches(j, key)); grid.replaceChildren();
    if (!rows.length) grid.append(node("p", { class: "evidence-callout" }, "该分类暂无已核实来源。可在中间检索栏补充官方分区或会议目录链接，再重新分析。"));
    for (const j of rows) {
      const details = node("details", { class: "journal-details" }, node("summary", {}, "查看偏好、来源与统计口径"), node("h4", {}, "发文偏好 · 样本推断"), markdown(j.preference), node("h4", {}, "为什么匹配"), markdown(j.fitReason), node("p", { class: "muted" }, j.scoreMethod),
        node("p", { class: "muted" }, `论文元数据样本 ${j.sampleSize} 篇；摘要覆盖 ${j.coverage}%；匹配分维度覆盖 ${j.scoreCoverage}%。${j.keywordMethod || ""}${j.countScope || ""}`), j.phrases?.length && node("p", { class: "muted" }, `计数短语：${j.phrases.join(" · ")}`), j.sources.map((u, i) => link(`统计来源 ${i + 1} ↗`, u)),
        j.evidenceIds.map(id => { const p = j.papers.find(p => p.id === id); return p && node("p", {}, link(p.title, p.url)); }),
        j.cas && node("p", {}, j.cas.fromTable ? node("span", { class: "muted" }, `中科院 ${j.cas.year} 年版 · ${j.cas.category || "分类未注明"} · 来自导入分区表`) : [link(`中科院 ${j.cas.year} · ${j.cas.category || "分类未注明"}`, j.cas.url), node("small", {}, j.cas.quote)]),
        j.review && node("p", {}, link("审稿指标原文", j.review.url), node("small", {}, j.review.quote)));
      grid.append(node("article", { class: "journal-card" }, node("header", {}, node("div", {}, pill(j.type === "conference" ? `会议 ${j.conference?.rank || "等级待核实"}` : j.cas ? `中科院${j.cas.zone}区 · ${j.cas.year}` : "中科院分区待核实"), node("h3", {}, j.name)), node("div", { class: "match-score" }, node("strong", {}, j.match ?? "—"), node("small", {}, "检索匹配"))),
        node("div", { class: "journal-stats" }, node("div", {}, node("strong", {}, j.count ?? "—"), node("span", {}, "窗口内方向论文")), node("div", {}, node("strong", {}, j.growth == null ? "—" : `${j.growth > 0 ? "+" : ""}${j.growth}%`), node("span", {}, "完整三年首尾变化")), node("div", {}, node("strong", {}, j.review ? `${j.review.days} 天` : "待核实"), node("span", {}, j.review ? ({ "first-decision": "首次决定（非外审）", review: "外审周期", acceptance: "至录用周期" })[j.review.metric] : "审稿周期"))),
        j.statisticsMethod && node("p", { class: "muted" }, "Crossref 题名 / 摘要短语匹配统计 · 完整口径见下方详情"), node("div", { class: "journal-chart-grid" }, trendChart(j.related, j.all), radarChart(j.radar)), markdown(j.narrative),
        node("div", { class: "keyword-list compact" }, j.keywords.slice(0, 7).map(k => node("span", {}, k.name, node("b", {}, k.count)))), details, j.homepage && link("期刊官网 ↗", j.homepage)));
    }
  };
  definitions.forEach(([key, label]) => { const b = button(`${label} ${report.journals.filter(j => matches(j, key)).length}`, () => draw(key), "filter-btn"); b.dataset.key = key; filters.append(b); });
  const groups = node("details", { class: "category-reports" }, node("summary", {}, "按中科院分区 / 顶会类别查看研究故事线"),
    (report.categories || []).map(c => node("section", { class: "category-report" }, node("h3", {}, `${c.name} · ${c.venueCount}个来源`),
      c.venueCount ? [trendChart(c.trend), markdown(c.narrative), node("h4", {}, "模拟挑刺"), markdown(c.critique), node("h4", {}, "仍可推进的问题"), markdown(c.opportunities)] : node("p", { class: "muted" }, "当前分类没有已核实来源，不推断其发文趋势。"))));
  root.append(groups, filters, grid); draw("all"); return root;
}
