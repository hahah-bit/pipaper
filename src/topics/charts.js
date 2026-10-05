import { node } from "../platform/ui.js";
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, text) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; }
export function trendChart(related, all = []) {
  const host = node("figure", { class: "topic-chart" }), chart = svg("svg", { viewBox: "0 0 420 175", role: "img", "aria-label": "年度方向发文量折线图。当年为不完整年度，虚线显示。" });
  chart.append(svg("title", {}, "方向发文量，完整年度与当年分别显示"));
  const known = related.filter(p => p.count != null), max = Math.max(1, ...known.map(p => p.count));
  const x = i => 40 + i * 108, y = n => 125 - n / max * 94;
  for (let i = 0; i <= 2; i++) { const yy = y(max * i / 2); chart.append(svg("line", { x1: 35, y1: yy, x2: 377, y2: yy, stroke: "var(--line)" }), svg("text", { x: 28, y: yy + 4, "text-anchor": "end", class: "chart-label" }, Math.round(max * i / 2))); }
  related.forEach((p, i) => {
    chart.append(svg("text", { x: x(i), y: 149, "text-anchor": "middle", class: "chart-label" }, p.year + (p.partial ? "*" : "")));
    if (p.count == null) return;
    if (i && related[i - 1].count != null) chart.append(svg("line", { x1: x(i - 1), y1: y(related[i - 1].count), x2: x(i), y2: y(p.count), stroke: "var(--accent)", "stroke-width": 2.5, ...(p.partial ? { "stroke-dasharray": "5 5" } : {}) }));
    const c = svg("circle", { cx: x(i), cy: y(p.count), r: 4.5, fill: "var(--accent)", tabindex: "0" }); c.append(svg("title", {}, `${p.year}${p.partial ? "（截至检索日）" : ""}：${p.count} 篇`)); chart.append(c);
    chart.append(svg("text", { x: x(i), y: y(p.count) - 10, "text-anchor": "middle", class: "chart-value" }, p.count));
  });
  host.append(chart, node("figcaption", {}, "方向发文量 · * 当年截至检索日，不与全年直接比较"));
  const rows = related.map((p, i) => node("tr", {}, node("td", {}, p.year + (p.partial ? "（部分年度）" : "")), node("td", {}, p.count ?? "未知"), node("td", {}, all[i]?.count ?? "未知")));
  host.append(node("details", { class: "chart-data" }, node("summary", {}, "查看统计表"), node("table", {}, node("thead", {}, node("tr", {}, ["年份", "该方向", "该刊总量"].map(s => node("th", {}, s)))), node("tbody", {}, rows))));
  return host;
}
export function radarChart(values) {
  const names = ["主题集中", "方向活跃", "三年增长", "开放获取", "摘要覆盖"], chart = svg("svg", { viewBox: "0 0 300 225", role: "img", "aria-label": names.map((n, i) => `${n}：${values[i] ?? "未知"}`).join("，") });
  const point = (i, n) => { const a = i * 2 * Math.PI / 5 - Math.PI / 2; return [150 + Math.cos(a) * 77 * n, 108 + Math.sin(a) * 77 * n]; };
  for (const r of [.33, .66, 1]) chart.append(svg("polygon", { points: names.map((_, i) => point(i, r).join(",")).join(" "), fill: "none", stroke: "var(--line)" }));
  names.forEach((name, i) => { const [x, y] = point(i, 1), [tx, ty] = point(i, 1.28); chart.append(svg("line", { x1: 150, y1: 108, x2: x, y2: y, stroke: "var(--line)" }), svg("text", { x: tx, y: ty, "text-anchor": "middle", class: "chart-label" }, name)); });
  // Unknown axes are gaps rather than fabricated zero values.
  if (values.every(v => v != null)) chart.append(svg("polygon", { points: values.map((v, i) => point(i, v / 100).join(",")).join(" "), fill: "var(--accent-soft)", stroke: "var(--accent)", "stroke-width": 2 }));
  else values.forEach((v, i) => {
    const next = (i + 1) % values.length;
    if (v == null || values[next] == null) return;
    const [x1, y1] = point(i, v / 100), [x2, y2] = point(next, values[next] / 100);
    chart.append(svg("line", { x1, y1, x2, y2, stroke: "var(--accent)", "stroke-width": 2 }));
  });
  values.forEach((v, i) => { if (v == null) return; const [x, y] = point(i, v / 100); const dot = svg("circle", { cx: x, cy: y, r: 3.5, fill: "var(--accent)" }); dot.append(svg("title", {}, `${names[i]}：${Math.round(v)}`)); chart.append(dot); });
  return node("figure", { class: "topic-radar" }, chart, node("figcaption", {}, values.some(v => v == null) ? "缺失维度留空，不填补分值" : "五维检索匹配 · 非录用概率"));
}
