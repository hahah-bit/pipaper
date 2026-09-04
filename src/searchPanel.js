import { api, state, $, el, toast } from "./app.js";

// 筛选条件持久化：检索前设置（年份/分区/OA/排序）记忆在 localStorage
const LS = "pipaper.sch.";
const FILTER_FIELDS = { sort: "sort", quartile: "quartile", yearFrom: "year-from", yearTo: "year-to" };

function saveFilters() {
  for (const [k, id] of Object.entries(FILTER_FIELDS)) {
    const node = $("#sch-" + id);
    if (node) localStorage.setItem(LS + k, node.value || "");
  }
  localStorage.setItem(LS + "oa", $("#sch-oa").checked ? "1" : "");
}

function restoreFilters() {
  for (const [k, id] of Object.entries(FILTER_FIELDS)) {
    const node = $("#sch-" + id);
    const v = localStorage.getItem(LS + k);
    if (node && v != null) node.value = v;
  }
  $("#sch-oa").checked = localStorage.getItem(LS + "oa") === "1";
}

export function onShow() {
  renderSources();
  renderToRead();
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

// ---------------- 待读清单 ----------------

async function refreshLibraryData() {
  const data = await api.papers();
  state.papers = data.papers;
  state.collections = data.collections;
  state.zotero = data.zotero;
  state.projects = data.projects || state.projects;
  const side = await import("./sidebar.js");
  side.renderProjects();
  side.renderCollections();
  side.renderPapers();
}

export async function addToToRead(r) {
  try {
    const res = await fetch("/api/search/toread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
    toast(j.dup ? "已在待读清单中" : "已加入待读（不会自动下载）");
    renderToRead();
    return true;
  } catch (e) {
    toast("加入待读失败: " + e.message, true);
    return false;
  }
}

// 显式下载导入：仅在用户点“加入项目”时发生，检索/加待读绝不自动下载
async function importEntry(entry, btn) {
  if (!entry.pdfUrl) {
    toast("该条目没有开放 PDF 链接 — 可点“原文”去出版页手动获取", true);
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "下载中…"; }
  try {
    const res = await fetch("/api/search/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfUrl: entry.pdfUrl, title: entry.title, projectId: state.projectId || null }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
    await refreshLibraryData();
    if (state.projectId) toast("已下载并加入当前项目");
    else toast("已下载入库（未选择项目）");
    if (entry.id) {
      await fetch("/api/search/toread/" + entry.id, { method: "DELETE" });
      renderToRead();
    }
  } catch (e) {
    toast("导入失败: " + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = "＋项目"; }
  }
}

function toReadRow(e) {
  return el("div", { class: "tr-row" },
    el("div", { class: "tr-main" },
      el("div", { class: "tr-title", title: e.title }, e.title),
      el("div", { class: "tr-meta" },
        e.year ? el("span", {}, String(e.year)) : null,
        e.quartile ? el("span", { class: "sr-quartile" }, e.quartile) : null,
        e.venue ? el("span", { class: "tr-venue" }, e.venue.slice(0, 40)) : null,
        e.pdfUrl ? el("span", { class: "sr-oa" }, "PDF") : el("span", { class: "tr-nopdf", title: "无开放 PDF，导入时需手动获取" }, "无PDF"),
      ),
    ),
    el("div", { class: "tr-actions" },
      e.pdfUrl ? el("a", { class: "tool-btn", href: e.pdfUrl, target: "_blank", rel: "noreferrer", title: "打开 PDF 链接" }, "PDF") : null,
      e.url ? el("a", { class: "tool-btn", href: e.url, target: "_blank", rel: "noreferrer", title: "打开原文链接" }, "原文") : null,
      el("button", {
        class: "tool-btn", title: "复制 BibTeX",
        onclick: () => navigator.clipboard.writeText(bibtex(e)).then(() => toast("BibTeX 已复制"), () => toast("复制失败", true)),
      }, "BibTeX"),
      el("button", { class: "tool-btn primary", title: "下载 PDF 并加入当前项目/文献库（显式操作，不自动下载）", onclick: (ev) => importEntry(e, ev.currentTarget) }, "＋项目"),
      el("button", {
        class: "tool-btn", title: "从待读清单移除",
        onclick: async () => {
          await fetch("/api/search/toread/" + e.id, { method: "DELETE" });
          renderToRead();
        },
      }, "✕"),
    )
  );
}

export async function renderToRead() {
  const box = $("#sch-toread");
  if (!box) return;
  let entries = [];
  try {
    const j = await fetch("/api/search/toread").then((r) => r.json());
    entries = j.entries || [];
  } catch {}
  const open = localStorage.getItem(LS + "toreadOpen") === "1";
  // replaceChildren 不能收 null（会渲染成 "null" 文本），先收集有效子节点
  const kids = [
    el("div", {
      class: "tr-head" + (entries.length ? "" : " empty"),
      onclick: () => {
        localStorage.setItem(LS + "toreadOpen", open ? "0" : "1");
        renderToRead();
      },
    },
      `📌 待读 (${entries.length})`,
      el("span", { class: "tr-caret" }, open ? "▾" : "▸")
    ),
  ];
  if (open && entries.length) kids.push(el("div", { class: "tr-list" }, ...entries.map(toReadRow)));
  if (open && !entries.length) kids.push(el("div", { class: "tr-empty res-note" }, "待读清单为空 — 检索结果点“＋待读”收藏（不下载）"));
  box.replaceChildren(...kids);
}

// ---------------- 结果卡片 ----------------

function scoreColor(s) {
  return s >= 80 ? "#4cc38a" : s >= 65 ? "var(--accent)" : s >= 50 ? "#e5c07b" : "#767e99";
}

// 评分行：推荐 87 ｜ 相关 28/30 ｜ 质量 Q1/预印本 ｜ 本地相关 强（悬停看逐项解释）
function scoreRow(r) {
  if (r.readScore == null) return [];
  const parts = r.scoreParts || {};
  const bits = [];
  if (r.quartile) bits.push(["质量", r.quartile]);
  else if (parts.venue != null) bits.push(["质量", parts.venue >= 10 ? "预印本" : "无分区"]);
  const localTxt = r.localRel; // 后端直接给 强/中/弱/none
  const row = [
    el("span", {
      class: "sr-score", style: { background: scoreColor(r.readScore) },
      title: (r.explain || []).join("\n"),
    }, "推荐 " + r.readScore),
  ];
  if (parts.rel != null) row.push(el("span", { class: "sr-scorepart", title: (r.explain || [])[0] }, `相关 ${parts.rel}/30`));
  if (bits.length) row.push(el("span", { class: "sr-scorepart", title: (r.explain || [])[1] }, bits[0][0] + " " + bits[0][1]));
  if (r.localRel && r.localRel !== "none") row.push(el("span", { class: "sr-scorepart", title: (r.explain || [])[5] }, "本地相关 " + localTxt));
  if (r.relCurrent) row.push(el("span", { class: "sr-flag", title: "与当前打开的论文语义相近" }, "↔ 当前论文"));
  if (r.relProject) row.push(el("span", { class: "sr-flag", title: "与当前项目/本地文献库相关" }, "▤ 项目库相关"));
  if (r.classic) row.push(el("span", { class: "sr-flag classic", title: "发表多年且被引很高，可能是该方向的基础经典" }, "基础经典"));
  return row;
}

function resultCard(r) {
  const tierColor = r.tier?.color || "#767e99";
  const authors = r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? " 等" : "");
  const absId = "abs-" + Math.random().toString(36).slice(2, 8);
  const inList = { done: false };
  const addBtn = el("button", {
    class: "tool-btn", title: "收藏到待读清单（只存元数据，不下载 PDF）",
    onclick: async () => {
      if (await addToToRead(r)) { inList.done = true; addBtn.textContent = "已在待读 ✓"; addBtn.disabled = true; }
    },
  }, "＋待读");
  const card = el("div", { class: "sch-result" },
    el("div", { class: "sr-scorerow" }, ...scoreRow(r)),
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
      r.pdfUrl ? el("a", { class: "tool-btn", href: r.pdfUrl, target: "_blank", rel: "noreferrer", title: "打开 PDF 链接（不自动下载）" }, "PDF") : null,
      r.url ? el("a", { class: "tool-btn", href: r.url, target: "_blank", rel: "noreferrer", title: "打开原文链接" }, "原文") : null,
      addBtn,
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
  saveFilters();
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
    if ($("#sch-quartile").value) params.set("quartile", $("#sch-quartile").value);
    if ($("#sch-oa").checked) params.set("oa", "1");
    // 本地关联度：带上当前项目与当前论文，后端据此算 ReadScore 的本地项
    if (state.projectId) params.set("projectId", state.projectId);
    if (state.currentPaper?.id) params.set("anchor", state.currentPaper.id);
    const r = await fetch("/api/search?" + params);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    $("#sch-status").textContent = `共 ${j.total} 条` + (j.errors?.length ? `（部分源失败: ${j.errors.join("; ")}）` : "");
    const box = $("#sch-results");
    box.replaceChildren();
    if (!j.results.length) {
      const filtered = $("#sch-quartile").value || $("#sch-oa").checked;
      box.append(el("div", { class: "res-note" }, filtered
        ? "过滤后没有结果 — 分区/OA 过滤会排除 arXiv 与无分区来源，可放宽后重试。"
        : "没有结果 — 试着换英文关键词或增加数据源。"));
      return;
    }
    for (const r of j.results) box.append(resultCard(r));
  } catch (e) {
    $("#sch-status").textContent = "检索失败: " + e.message;
  }
}

export function initSearchPanel() {
  window.__schInit = true;
  restoreFilters();
  renderSources();
  renderToRead();
  // rightbar tabs: search / video switch (+ reopen when collapsed)
  document.querySelectorAll(".rt-tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".rt-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      document.querySelector("#stab-search").hidden = t.dataset.tab !== "search";
      document.querySelector("#stab-video").hidden = t.dataset.tab !== "video";
      const rb = document.getElementById("rightbar");
      rb.classList.remove("collapsed");
      localStorage.setItem("pipaper.rightCollapsed", "0");
      window.dispatchEvent(new Event("resize"));
    })
  );
  $("#btn-search").addEventListener("click", doSearch);
  $("#sch-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doSearch(); }
  });
  for (const k of ["sort", "quartile", "year-from", "year-to"]) {
    const node = $("#sch-" + k);
    node?.addEventListener("change", saveFilters);
  }
  $("#sch-oa").addEventListener("change", saveFilters);
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
