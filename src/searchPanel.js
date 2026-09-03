import { api, state, $, el, toast } from "./app.js";

let searched = false;

export function onShow() {
  renderSources();
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
  const card = el("div", { class: "sch-result" },
    el("div", { class: "sr-top" },
      el("span", { class: "sr-tier", style: { background: tierColor } }, r.tier?.label || ""),
      r.oa ? el("span", { class: "sr-oa" }, "OA") : null,
      el("span", { class: "sr-year" }, String(r.year || "")),
      el("span", { class: "sr-venue" }, (r.venue || "").slice(0, 42)),
      el("span", { class: "sr-cit" }, r.citations != null ? `被引 ${r.citations}` : ""),
    ),
    el("div", { class: "sr-title", title: r.title }, r.title),
    el("div", { class: "sr-authors" }, authors),
    r.abstract ? el("div", { class: "sr-abs" }, r.abstract.slice(0, 180) + "…") : null,
    el("div", { class: "sr-actions" },
      el("button", {
        class: "tool-btn", title: r.pdfUrl || "无开放获取 PDF",
        onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true; btn.textContent = "下载中…";
          try {
            const res = await fetch("/api/search/import", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pdfUrl: r.pdfUrl, title: r.title, projectId: state.projectId }),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
            toast(j.reused ? "文献库已有该论文（内容相同），已复用解析状态" : `已导入《${(j.title || "").slice(0, 30)}》`);
            btn.textContent = "✓ 已入库";
            const { reloadPapers } = await import("./sidebar.js");
            await reloadPapers();
          } catch (err) {
            btn.disabled = false; btn.textContent = "📥 导入";
            toast("导入失败: " + err.message, true);
          }
        },
      }, "📥 导入"),
      el("button", {
        class: "tool-btn", title: "复制 BibTeX",
        onclick: () => {
          navigator.clipboard.writeText(bibtex(r)).then(() => toast("BibTeX 已复制"), () => toast("复制失败", true));
        },
      }, "BibTeX"),
      r.doi ? el("a", { class: "tool-btn", href: "https://doi.org/" + r.doi, target: "_blank", rel: "noreferrer", style: { textDecoration: "none" } }, "DOI") : null,
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
  $("#btn-search").addEventListener("click", doSearch);
  $("#sch-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doSearch(); }
  });
  $("#btn-sch-sources").addEventListener("click", () => {
    fetch("/api/search/sources").then((r) => r.json()).then((d) => {
      const ta = el("textarea", { rows: "14", style: { width: "100%", fontFamily: "monospace", fontSize: "12px" } });
      ta.value = JSON.stringify(d.sources, null, 2);
      const back = el("div", { id: "tpl-editor-backdrop" }, el("div", { class: "modal", style: { width: "640px" } },
        el("div", { class: "modal-head" }, el("span", {}, "检索源（可自由添加/编辑；type 见 server/search/engines.js）"), el("button", { class: "icon-btn", onclick: () => back.remove() }, "✕")),
        el("div", { class: "modal-body" },
          ta,
          el("div", { style: { display: "flex", gap: "8px", marginTop: "10px" } },
            el("button", {
              class: "tool-btn primary", onclick: async () => {
                try {
                  const sources = JSON.parse(ta.value);
                  await fetch("/api/search/sources", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources }) });
                  toast("检索源已保存");
                  back.remove();
                  renderSources();
                } catch (e) {
                  toast("保存失败: " + e.message, true);
                }
              }
            }, "保存"),
            el("button", { class: "tool-btn", onclick: () => back.remove() }, "取消")
          )
        )
      ));
      document.body.append(back);
    });
  });
}
