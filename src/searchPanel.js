import { api, state, $, el, toast } from "./app.js";

let searched = false;

export function onShow() {
  renderSources();
}

// 分区徽章行：分区 + SJR 影响指标
function metaBadges(r) {
  const bits = [];
  if (r.quartile) bits.push(el("span", { class: "sr-quartile", title: "SJR 分区（2026）" }, r.quartile));
  if (r.sjr != null) bits.push(el("span", { class: "sr-sjr", title: "SJR 指标" }, "SJR " + r.sjr.toFixed(2)));
  return bits;
}

function bibtex(r) {
  const key = (r.authors[0] || "anon").split(" ").pop().toLowerCase() + (r.year || "nd") + (r.title.match(/\w+/)?.[0] || "").toLowerCase();
  const authors = r.authors.join(" and ");
  return [
    "@article{" + key + ",",
    `  title = {${r.title}},`,
    `  author = {${authors}},`,
    r.year ? `  year = {${r.year}},` : null,
    r.venue ? `  journal = {${r.venue}},` : null,
    r.doi ? `  doi = {${r.doi}},` : null,
    r.url ? `  url = {${r.url}},` : null,
    "}",
  ].filter(Boolean).join("\n");
}

function renderSources() {
  fetch("/api/search/sources").then((r) => r.json()).then((d) => {
    const box = $("#sch-sources");
    box.replaceChildren();
    for (const s of d.sources) {
      const cb = el("input", { type: "checkbox", ...(s.enabled && s.type !== "unavailable" ? { checked: true } : {}) });
      cb.dataset.sid = s.id;
      const label = el("label", { class: "sch-src" + (s.type === "unavailable" ? " off" : ""), title: s.note || "" }, cb, s.name);
      if (s.type === "unavailable") { cb.disabled = true; label.title = s.note || "不可用"; }
      box.append(label);
    }
  });
}

function resultCard(r) {
  const tierColor = r.tier?.color || "#767e99";
  const authors = r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? " 等" : "");
  const absId = "abs-" + Math.random().toString(36).slice(2, 8);
  const card = el("div", { class: "sch-result" },
    el("div", { class: "sr-top" },
      el("span", { class: "sr-tier", style: { background: tierColor } }, r.tier?.label || ""),
      ...metaBadges(r),
      r.oa ? el("span", { class: "sr-oa" }, "OA") : null,
      el("span", { class: "sr-year" }, String(r.year || "")),
      el("span", { class: "sr-venue" }, (r.venue || "").slice(0, 42)),
      el("span", { class: "sr-cit" }, r.citations != null ? `被引 ${r.citations}` : ""),
    ),
    el("div", { class: "sr-title", title: r.title }, r.title),
    el("div", { class: "sr-authors" }, authors),
    r.abstract ? el("div", {},
      el("div", { class: "sr-abs", id: absId, style: { maxHeight: "44px", overflow: "hidden" } }, r.abstract),
      el("a", {
        class: "sr-abs-toggle", style: { fontSize: "11px", color: "var(--accent)", cursor: "pointer" },
        onclick: () => {
          const a = document.getElementById(absId);
          const open = a.style.maxHeight !== "none";
          a.style.maxHeight = open ? "none" : "44px";
          a.textContent = r.abstract;
          a.nextElementSibling.textContent = open ? "收起" : "展开摘要";
        },
      }, "展开摘要"),
    ) : null,
    el("div", { class: "sr-actions" },
      r.pdfUrl ? el("a", { class: "tool-btn", href: r.pdfUrl, target: "_blank", rel: "noreferrer", title: "打开/下载 PDF 链接" }, "PDF") : null,
      r.url ? el("a", { class: "tool-btn", href: r.url, target: "_blank", rel: "noreferrer", title: "打开原文链接" }, "原文") : null,
      el("button", {
        class: "tool-btn", title: "复制 BibTeX",
        onclick: () => {
          navigator.clipboard.writeText(bibtex(r)).then(() => toast("BibTeX 已复制"), () => toast("复制失败", true));
        },
      }, "BibTeX"),
      el("span", { class: "sr-src" }, (r.sources || [r.source]).join("+")),
    )
  );
  return card;
}

async function doSearch() {
  const q = $("#sch-q").value.trim();
  if (!q) return;
  const sources = [...document.querySelectorAll("#sch-sources input:checked")].map((c) => c.dataset.sid);
  $("#sch-status").textContent = "检索中…";
  $("#sch-results").replaceChildren();
  try {
    const params = new URLSearchParams({
      q, sources: sources.join(","), sort: $("#sch-sort").value,
      limit: "15",
    });
    if ($("#sch-year-from").value) params.set("yearFrom", $("#sch-year-from").value);
    if ($("#sch-year-to").value) params.set("yearTo", $("#sch-year-to").value);
    if ($("#sch-oa").checked) params.set("oa", "1");
    const r = await fetch("/api/search?" + params);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    searched = true;
    $("#sch-status").textContent = `共 ${j.total} 条` + (j.errors?.length ? `（部分源失败: ${j.errors.join("; ")}）` : "");
    const box = $("#sch-results");
    box.replaceChildren();
    if (!j.results.length) {
      box.append(el("div", { class: "res-note" }, "没有结果 — 试着换英文关键词或增加数据源。"));
      return;
    }
    for (const r of j.results) box.append(resultCard(r));
  } catch (e) {
    $("#sch-status").textContent = "检索失败: " + e.message;
  }
}

export function initSearchPanel() {
  window.__schInit = true;
  renderSources();
  $("#btn-search").addEventListener("click", doSearch);
  $("#sch-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doSearch(); }
  });
  $("#btn-sch-sources").addEventListener("click", () => {
    const url = el("input", { type: "text", placeholder: "镜像/站点网址，如 https://sc.panda985.com", style: { width: "100%" } });
    const key = el("input", { type: "text", placeholder: "Semantic Scholar apiKey（可选）", style: { width: "100%" } });
    const cookie = el("input", { type: "text", placeholder: "镜像 Cookie（可选：浏览器过验证后 F12 复制 Cookie 头）", style: { width: "100%" } });
    const back = el("div", { id: "tpl-editor-backdrop" }, el("div", { class: "modal", style: { width: "560px" } },
      el("div", { class: "modal-head" }, el("span", {}, "添加检索源"), el("button", { class: "icon-btn", onclick: () => back.remove() }, "✕")),
      el("div", { class: "modal-body" },
        el("p", { class: "res-note" }, "只需填网址（和可选的密钥/Cookie），其余元数据自动补全。Google 学术镜像需先在浏览器过一次人机验证，再把 Cookie 复制进来即可免登录检索。"),
        el("label", { class: "modal-label" }, "网址", url),
        el("label", { class: "modal-label" }, "API Key（可选）", key),
        el("label", { class: "modal-label" }, "Cookie（可选）", cookie),
        el("div", { style: { display: "flex", gap: "8px", marginTop: "10px" } },
          el("button", {
            class: "tool-btn primary", onclick: async () => {
              try {
                const res = await fetch("/api/search/sources/add", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ url: url.value, apiKey: key.value, cookie: cookie.value }),
                });
                const j = await res.json();
                if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
                toast("检索源已添加: " + (j.source?.name || ""));
                back.remove();
                renderSources();
              } catch (e) {
                toast("添加失败: " + e.message, true);
              }
            }
          }, "添加源"),
          el("button", { class: "tool-btn", onclick: () => back.remove() }, "取消")
        )
      )
    ));
    document.body.append(back);
  });
}
