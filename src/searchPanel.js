import { persistence } from "./persistence.js";
import { api } from "./platform/api.js";
import { state } from "./shell/state.js";
import { $, el, toast } from "./platform/dom.js";
import { PURPOSES, purposeCategories, filterSearchResults, evidenceLabel, createRequestGate } from "./searchModel.js";

// 筛选条件持久化：检索前设置（年份/分区/OA/排序）记忆在 localStorage
const LS = "pipaper.sch.";
const FILTER_FIELDS = { sort: "sort", quartile: "quartile", yearFrom: "year-from", yearTo: "year-to", purpose: "purpose" };
const searchGate = createRequestGate();
let sourceRequest, toReadRevision = 0, searchTimer, lastResponse, lastSearchProjectId, lastSearchAnchorId;
let sourceChoices = {};
try { sourceChoices = JSON.parse(persistence.getItem(LS + "sources") || "{}"); } catch {}
if (!sourceChoices || typeof sourceChoices !== "object" || Array.isArray(sourceChoices)) sourceChoices = {};

async function requestJson(url, options = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000), ...options });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "HTTP " + res.status);
  if (!data || typeof data !== "object") throw new Error("服务返回格式异常，请检查服务是否正在运行");
  return data;
}

function openResearch() {
  if (!state.projectId) return toast("先在文献库选择或新建一个研究项目", true);
  window.dispatchEvent(new CustomEvent("pipaper:workspace-open", { detail: { moduleId: "research" } }));
}

function researchEnabled() { return !!state.projectId && !!$("#sch-research")?.checked; }

function updateResearchControls() {
  const checkbox = $("#sch-research");
  if (!checkbox) return;
  checkbox.disabled = !state.projectId;
  checkbox.checked = !!state.projectId && persistence.getItem(LS + "research") !== "0";
  $("#sch-sort option[value='research']").disabled = !researchEnabled();
  $("#sch-purpose").disabled = !researchEnabled();
  if (!researchEnabled()) $("#sch-purpose").value = "";
  if (!researchEnabled() && $("#sch-sort").value === "research") $("#sch-sort").value = "recommended";
  renderResearchContext();
}

function stopSearch() {
  searchGate.cancel();
  clearInterval(searchTimer);
  searchTimer = null;
  $("#btn-search").textContent = "🔍 检索";
  $("#btn-sch-cancel").hidden = true;
  $("#sch-results").setAttribute("aria-busy", "false");
}

function saveFilters() {
  for (const [k, id] of Object.entries(FILTER_FIELDS)) {
    const node = $("#sch-" + id);
    if (node) persistence.setItem(LS + k, node.value || "");
  }
  persistence.setItem(LS + "oa", $("#sch-oa").checked ? "1" : "");
}

function restoreFilters() {
  for (const [k, id] of Object.entries(FILTER_FIELDS)) {
    const node = $("#sch-" + id);
    const v = persistence.getItem(LS + k);
    if (node && v != null) node.value = v;
  }
  $("#sch-oa").checked = persistence.getItem(LS + "oa") === "1";
}

export function onShow() {
  renderSources();
  renderToRead();
  updateResearchControls();
}

// 分区徽章行：分区 + SJR 影响指标
function metaBadges(r) {
  const bits = [];
  if (r.quartile) bits.push(el("span", { class: "sr-quartile", title: "SJR 分区（2026）" }, r.quartile));
  if (r.sjr != null) bits.push(el("span", { class: "sr-sjr", title: "SJR 指标" }, "SJR " + r.sjr.toFixed(2)));
  return bits;
}

function bibtex(r) {
  const names = Array.isArray(r.authors) ? r.authors : [];
  const key = (names[0] || "anon").split(" ").pop().toLowerCase() + (r.year || "nd") + ((r.title || "").match(/\w+/)?.[0] || "").toLowerCase();
  const authors = names.join(" and ");
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

async function renderSources() {
  if (sourceRequest) return sourceRequest;
  sourceRequest = (async () => {
    try {
      const d = await requestJson("/api/search/sources");
      const box = $("#sch-sources");
      if (!box) return;
      box.replaceChildren();
      for (const s of d.sources || []) {
        const selected = Object.hasOwn(sourceChoices, s.id) ? sourceChoices[s.id] : s.enabled;
        const cb = el("input", { type: "checkbox", ...(selected && s.type !== "unavailable" ? { checked: true } : {}),
          onchange: () => { sourceChoices[s.id] = cb.checked; persistence.setItem(LS + "sources", JSON.stringify(sourceChoices)); },
        });
        cb.dataset.sid = s.id;
        const label = el("label", { class: "sch-src" + (s.type === "unavailable" ? " off" : ""), title: s.note || "" }, cb, s.name);
        if (s.type === "unavailable") { cb.disabled = true; label.title = s.note || "不可用"; }
        box.append(label);
      }
      if (!d.sources?.length) box.append(el("span", { class: "res-note" }, "没有可用检索源，请在 ⚙ 添加检索源"));
    } catch (e) {
      const box = $("#sch-sources");
      if (!box?.querySelector("input")) box?.replaceChildren(el("span", { class: "res-note sch-source-error" }, "检索源加载失败：" + e.message));
      return false;
    }
    return true;
  })();
  try { return await sourceRequest; } finally { sourceRequest = null; }
}

const QUESTION_SOURCES = { profile: "研究档案", records: "研究记录", "project-papers": "项目论文", anchor: "当前论文", none: "尚未填写" };

function renderResearchContext(context = lastResponse?.researchContext) {
  const box = $("#sch-research-context");
  if (!box) return;
  if (!state.projectId) {
    box.replaceChildren(el("span", {}, "选择研究项目后，可结合研究问题与项目知识库匹配文献。"));
    return;
  }
  const action = el("button", { class: "sr-abs-toggle sch-research-link", onclick: openResearch }, "编辑研究档案");
  if (!researchEnabled()) {
    box.replaceChildren(el("span", {}, "当前研究匹配已关闭。"), action);
    return;
  }
  if (!context || context.projectId && context.projectId !== state.projectId) {
    box.replaceChildren(el("span", {}, "将结合当前项目研究问题与 RAG 证据，给出阅读用途建议。"), action);
    return;
  }
  const nodes = [];
  if (context.question) nodes.push(el("div", { class: "sch-research-question" }, "研究问题：" + context.question,
    el("span", { class: "sch-question-source" }, "来源：" + (QUESTION_SOURCES[context.questionSource] || context.questionSource || "当前项目"))));
  if (!context.profileAvailable) nodes.push(el("span", {}, "尚未填写研究档案；补充研究问题和待改模块，匹配会更准确。"));
  if (context.indexReady) nodes.push(el("span", {}, `项目知识库可检索 · ${context.evidenceCount || 0} 条匹配证据。`));
  else nodes.push(el("span", {}, "项目暂无可用 RAG 索引，可继续根据研究档案和文献元数据匹配。"));
  if (context.reason) nodes.push(el("span", {}, context.reason));
  if (context.warnings?.length) nodes.push(el("div", { class: "sch-research-warning" }, context.warnings.join("；")));
  nodes.push(action);
  box.replaceChildren(...nodes);
}

function purposeBadges(entry) {
  return purposeCategories(entry).map((category) => el("span", {
    class: "sr-purpose", title: category.reason || "阅读用途建议，可在待读清单手工调整",
  }, category.label));
}

function researchMatchRow(entry, saved = false) {
  const match = entry.researchMatch;
  if (!match) return null;
  const level = { strong: "强", moderate: "中", weak: "弱", pending: "待判断" }[match.level] || match.level || "待判断";
  const score = Number.isFinite(Number(match.score)) ? " " + Number(match.score) : "";
  const details = el("details", { class: "sr-research-details" },
    el("summary", {}, "匹配理由与证据"),
    match.basis ? el("div", { class: "sr-match-basis" }, "依据：" + match.basis) : null,
    ...(match.reasons || []).map((reason) => el("div", { class: "sr-match-reason" }, "· " + reason)),
    ...(match.categories || []).filter((category) => category.reason).map((category) => el("div", { class: "sr-match-reason" }, category.label + "：" + category.reason)),
    ...(match.evidence || []).map((evidence) => el("blockquote", {
      class: "sr-research-evidence", title: [evidence.resourceId, evidence.generationId, evidence.recordId].filter(Boolean).join(" / "),
    }, el("cite", {}, evidenceLabel(evidence)), evidence.text ? el("p", {}, evidence.text) : null)),
    !match.evidence?.length ? el("div", { class: "sr-match-basis" }, "尚无项目全文证据，当前建议需精读核对。") : null,
    ...(match.warnings || []).map((warning) => el("div", { class: "sch-research-warning" }, warning)),
  );
  return el("div", { class: "sr-research" },
    el("div", { class: "sr-purpose-row" },
      el("span", { class: "sr-research-score", title: "相对检索时研究的阅读匹配分，不代表论文创新性已验证" }, (saved ? "收录时匹配" : "研究匹配") + score + " · " + level),
      ...purposeBadges(entry),
      !purposeCategories(entry).length ? el("span", { class: "sr-scorepart" }, "用途待判断") : null,
      match.confidence === "low" ? el("span", { class: "sr-match-low" }, "证据有限，待核对") : null),
    details);
}

function renderSearchResults() {
  if (!lastResponse) return;
  const response = lastResponse;
  const all = Array.isArray(response.results) ? response.results : [];
  const purpose = $("#sch-purpose")?.value || "";
  const results = filterSearchResults(all, purpose, $("#sch-sort").value);
  const box = $("#sch-results");
  box.replaceChildren();
  if (!results.length) {
    const failed = response.status === "error" || response.status === "no_sources" || !all.length && response.errors?.length;
    box.append(el("div", { class: "res-note" }, failed
      ? "检索源未返回可用结果。请查看下方来源诊断，检查源设置、凭据或代理后重试。"
      : all.length && purpose ? "这批结果暂无该用途建议，可切换“全部用途”查看；研究问题不足时用途可能待判断。"
      : $("#sch-quartile").value || $("#sch-oa").checked
        ? "过滤后没有结果 — 分区/OA 过滤会排除部分来源，可放宽后重试。"
        : "没有结果 — 试着换英文关键词或增加数据源。"));
  } else for (const result of results) box.append(resultCard(result));
  const failedSources = (response.sourceStatus || []).filter((source) => source.status === "error");
  if (failedSources.length) box.append(el("details", { class: "sch-source-diagnostics", ...(results.length ? {} : { open: true }) },
    el("summary", {}, "检索源诊断（" + failedSources.length + " 个来源异常）"),
    ...failedSources.map((source) => el("div", {}, el("strong", {}, source.name || source.id),
      "：" + (source.message || "请求失败"), source.action ? el("p", {}, source.action) : null))));
  else if (response.errors?.length) box.append(el("div", { class: "sch-source-diagnostics" }, response.errors.join("；")));
  if (purpose && all.length) $("#sch-result-count").textContent = `显示 ${results.length}/${all.length} 条 · 当前用途筛选`;
  else $("#sch-result-count").textContent = "";
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
    const j = await requestJson("/api/search/toread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    });
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
  const projectId = state.projectId || null;
  try {
    const j = await requestJson("/api/search/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfUrl: entry.pdfUrl, title: entry.title, projectId,
        researchMatch: entry.researchMatch,
        ...(Object.hasOwn(entry, "purposeCategories") ? { purposeCategories: entry.purposeCategories } : {}) }),
      signal: AbortSignal.timeout(120000),
    });
    await refreshLibraryData();
    const importedMessage = projectId ? "已下载并加入所选项目" : "已下载入库（未选择项目）";
    toast(importedMessage + (j.matchDiscarded ? "；已忽略其他项目的匹配快照" : ""));
    if (entry.id) {
      try {
        await requestJson("/api/search/toread/" + encodeURIComponent(entry.id), { method: "DELETE" });
        renderToRead();
      } catch (e) { toast("论文已导入，待读移除失败：" + e.message, true); }
    }
  } catch (e) {
    toast("导入失败: " + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = "＋项目"; }
  }
}

function toReadRow(e) {
  let purposeSaving = false, row;
  const manual = Array.isArray(e.purposeCategories) && e.purposeCategories.length;
  const purposeSelect = el("select", { class: "tr-purpose-select", "aria-label": "手工调整阅读用途", title: "手工调整用途；选择自动建议可恢复系统分类",
    onchange: async () => {
      if (purposeSaving) return;
      const previous = manual ? e.purposeCategories[0] : "";
      const nextPurposes = purposeSelect.value ? [purposeSelect.value] : [];
      const actionStates = [...row.querySelectorAll(".tr-actions button")].map(button => [button, button.disabled]);
      purposeSaving = true;
      purposeSelect.disabled = true;
      for (const [button] of actionStates) button.disabled = true;
      try {
        await requestJson("/api/search/toread/" + encodeURIComponent(e.id), {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purposeCategories: nextPurposes }),
        });
        e.purposeCategories = nextPurposes;
        await renderToRead();
      } catch (err) { purposeSelect.value = previous; toast("用途保存失败：" + err.message, true); }
      finally {
        purposeSaving = false;
        purposeSelect.disabled = false;
        for (const [button, disabled] of actionStates) button.disabled = disabled;
      }
    },
  }, el("option", { value: "" }, "用途：自动建议"), ...PURPOSES.map((purpose) => el("option", { value: purpose.id }, "用途：" + purpose.label)));
  purposeSelect.value = manual ? e.purposeCategories[0] : "";
  row = el("div", { class: "tr-row" },
    el("div", { class: "tr-main" },
      el("div", { class: "tr-title", title: e.title }, e.title),
      el("div", { class: "tr-meta" },
        e.year ? el("span", {}, String(e.year)) : null,
        e.quartile ? el("span", { class: "sr-quartile" }, e.quartile) : null,
        e.venue ? el("span", { class: "tr-venue" }, e.venue.slice(0, 40)) : null,
        e.pdfUrl ? el("span", { class: "sr-oa" }, "PDF") : el("span", { class: "tr-nopdf", title: "无开放 PDF，导入时需手动获取" }, "无PDF"),
        ...(!e.researchMatch ? purposeBadges(e) : []),
      ),
      e.researchMatch ? researchMatchRow(e, true) : null,
    ),
    el("div", { class: "tr-actions" },
      purposeSelect,
      e.pdfUrl ? el("a", { class: "tool-btn", href: e.pdfUrl, target: "_blank", rel: "noreferrer", title: "打开 PDF 链接" }, "PDF") : null,
      e.url ? el("a", { class: "tool-btn", href: e.url, target: "_blank", rel: "noreferrer", title: "打开原文链接" }, "原文") : null,
      el("button", {
        class: "tool-btn", title: "复制 BibTeX",
        onclick: () => navigator.clipboard.writeText(bibtex(e)).then(() => toast("BibTeX 已复制"), () => toast("复制失败", true)),
      }, "BibTeX"),
      el("button", { class: "tool-btn primary", title: "下载 PDF 并加入当前项目/文献库（显式操作，不自动下载）", onclick: (ev) => {
        if (!purposeSaving) return importEntry(e, ev.currentTarget);
      } }, "＋项目"),
      el("button", {
        class: "tool-btn", title: "从待读清单移除",
        onclick: async (ev) => {
          if (purposeSaving) return;
          const button = ev.currentTarget;
          button.disabled = true;
          try {
            await requestJson("/api/search/toread/" + encodeURIComponent(e.id), { method: "DELETE" });
            renderToRead();
          } catch (err) { toast("移除失败：" + err.message, true); button.disabled = false; }
        },
      }, "✕"),
    )
  );
  return row;
}

export async function renderToRead() {
  const box = $("#sch-toread");
  if (!box) return;
  const revision = ++toReadRevision;
  let entries = [];
  try {
    const j = await requestJson("/api/search/toread");
    entries = j.entries || [];
  } catch (e) {
    if (revision === toReadRevision) box.replaceChildren(el("div", { class: "res-note" }, "待读清单加载失败：" + e.message,
      el("button", { class: "tool-btn", onclick: renderToRead }, "重试")));
    return;
  }
  if (revision !== toReadRevision) return;
  const open = persistence.getItem(LS + "toreadOpen") === "1";
  // replaceChildren 不能收 null（会渲染成 "null" 文本），先收集有效子节点
  const kids = [
    el("div", {
      class: "tr-head" + (entries.length ? "" : " empty"),
      role: "button", tabindex: "0", "aria-expanded": String(open),
      onkeydown: (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.currentTarget.click(); } },
      onclick: () => {
        persistence.setItem(LS + "toreadOpen", open ? "0" : "1");
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
  const names = Array.isArray(r.authors) ? r.authors : [];
  const authors = names.slice(0, 3).join(", ") + (names.length > 3 ? " 等" : "");
  const absId = "abs-" + Math.random().toString(36).slice(2, 8);
  const addBtn = el("button", {
    class: "tool-btn", title: "收藏到待读清单（只存元数据，不下载 PDF）",
    onclick: async () => {
      addBtn.disabled = true;
      if (await addToToRead(r)) addBtn.textContent = "已在待读 ✓";
      else addBtn.disabled = false;
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
    researchMatchRow(r),
    r.abstract ? el("div", {},
      el("div", { class: "sr-abs", id: absId, style: { maxHeight: "44px", overflow: "hidden" } }, r.abstract),
      el("button", {
        class: "sr-abs-toggle", "aria-expanded": "false", "aria-controls": absId,
        onclick: () => {
          const a = document.getElementById(absId);
          const open = a.style.maxHeight !== "none";
          a.style.maxHeight = open ? "none" : "44px";
          a.textContent = r.abstract;
          a.nextElementSibling.textContent = open ? "收起" : "展开摘要";
          a.nextElementSibling.setAttribute("aria-expanded", String(open));
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
  if (!q) { stopSearch(); $("#sch-status").textContent = "请输入主题、方法或模型名后检索。"; return; }
  const yearFrom = $("#sch-year-from").value, yearTo = $("#sch-year-to").value;
  if (yearFrom && yearTo && Number(yearFrom) > Number(yearTo)) {
    stopSearch();
    $("#sch-status").textContent = "起始年份不能晚于结束年份。";
    return;
  }
  saveFilters();
  const request = searchGate.begin();
  clearInterval(searchTimer);
  $("#sch-status").textContent = "加载检索源…";
  if (!$("#sch-sources input")) await renderSources();
  if (!searchGate.isCurrent(request)) return;
  const sources = [...document.querySelectorAll("#sch-sources input:checked")].map((c) => c.dataset.sid);
  if (!sources.length) {
    stopSearch();
    $("#sch-status").textContent = "请勾选至少一个可用检索源；加载失败时可重新打开检索面板重试。";
    return;
  }
  const projectId = state.projectId || null;
  lastResponse = null;
  lastSearchProjectId = projectId;
  lastSearchAnchorId = state.currentPaper?.id || null;
  const useResearch = researchEnabled();
  $("#btn-search").textContent = "🔍 重新检索";
  $("#btn-sch-cancel").hidden = false;
  $("#sch-results").setAttribute("aria-busy", "true");
  $("#sch-result-count").textContent = "";
  renderResearchContext();
  $("#sch-status").textContent = "检索中…";
  // 多源聚合通常 10–20s：计时提示让等待可感知
  const t0 = Date.now();
  searchTimer = setInterval(() => {
    if (!searchGate.isCurrent(request)) return;
    $("#sch-status").textContent = `检索中… ${Math.round((Date.now() - t0) / 1000)}s（多源聚合通常 10–20s）`;
  }, 500);
  $("#sch-results").replaceChildren();
  try {
    const params = new URLSearchParams({
      q, sources: sources.join(","), sort: $("#sch-sort").value,
      limit: "15",
      research: useResearch ? "1" : "0",
    });
    if ($("#sch-year-from").value) params.set("yearFrom", $("#sch-year-from").value);
    if ($("#sch-year-to").value) params.set("yearTo", $("#sch-year-to").value);
    if ($("#sch-quartile").value) params.set("quartile", $("#sch-quartile").value);
    if ($("#sch-oa").checked) params.set("oa", "1");
    // 本地关联度：带上当前项目与当前论文，后端据此算 ReadScore 的本地项
    if (projectId) params.set("projectId", projectId);
    const anchorInProject = !projectId || state.projects?.find(project => project.id === projectId)?.paperIds?.includes(lastSearchAnchorId);
    if (lastSearchAnchorId && anchorInProject) params.set("anchor", lastSearchAnchorId);
    const j = await requestJson("/api/search?" + params, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(75000)]) });
    if (!searchGate.isCurrent(request) || projectId !== (state.projectId || null)) return;
    lastResponse = j;
    const failed = j.status === "error" || j.status === "no_sources";
    $("#sch-status").textContent = (failed ? "检索源失败" : `共 ${j.total ?? j.results?.length ?? 0} 条`)
      + `（${((Date.now() - t0) / 1000).toFixed(1)}s）` + (j.status === "partial" || j.errors?.length && !failed ? " · 部分来源异常" : "");
    renderResearchContext(j.researchContext);
    renderSearchResults();
  } catch (e) {
    if (!searchGate.isCurrent(request)) return;
    $("#sch-status").textContent = e.name === "TimeoutError"
      ? "检索超时，可减少检索源或检查代理后重试。" : "检索失败: " + e.message;
  } finally {
    if (searchGate.isCurrent(request)) {
      clearInterval(searchTimer);
      searchTimer = null;
      $("#btn-search").textContent = "🔍 检索";
      $("#btn-sch-cancel").hidden = true;
      $("#sch-results").setAttribute("aria-busy", "false");
    }
  }
}

export function initSearchPanel() {
  if (window.__schInit) return;
  window.__schInit = true;
  restoreFilters();
  renderSources();
  renderToRead();
  updateResearchControls();
  // 旧版 rightbar tab 切换已移除：检索/视频由 dock 抽屉按需挂载
  $("#btn-search").addEventListener("click", doSearch);
  $("#btn-sch-cancel").addEventListener("click", () => { stopSearch(); $("#sch-status").textContent = "已取消检索。"; });
  $("#sch-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !e.shiftKey && !e.repeat) { e.preventDefault(); doSearch(); }
  });
  for (const k of ["quartile", "year-from", "year-to"]) {
    const node = $("#sch-" + k);
    node?.addEventListener("change", saveFilters);
  }
  $("#sch-sort").addEventListener("change", () => { saveFilters(); if (lastResponse || searchTimer) doSearch(); });
  $("#sch-purpose").addEventListener("change", () => { saveFilters(); renderSearchResults(); });
  $("#sch-research").addEventListener("change", () => {
    persistence.setItem(LS + "research", $("#sch-research").checked ? "1" : "0");
    updateResearchControls();
    if (lastResponse || searchTimer) doSearch();
  });
  window.addEventListener("pipaper:project-changed", () => {
    if (lastSearchProjectId !== (state.projectId || null)) {
      stopSearch();
      lastResponse = null;
      $("#sch-results").replaceChildren();
      $("#sch-status").textContent = "项目已切换，请重新检索以匹配当前研究。";
      $("#sch-result-count").textContent = "";
    }
    updateResearchControls();
  });
  window.addEventListener("pipaper:paper-changed", () => {
    if (lastSearchAnchorId === (state.currentPaper?.id || null) || lastSearchAnchorId === undefined) return;
    stopSearch();
    lastResponse = null;
    $("#sch-results").replaceChildren();
    $("#sch-status").textContent = "当前论文已切换，请重新检索以更新论文关联度。";
    $("#sch-result-count").textContent = "";
    renderResearchContext();
  });
  $("#sch-oa").addEventListener("change", saveFilters);
  $("#btn-sch-sources").addEventListener("click", () => {
    const url = el("input", { type: "text", placeholder: "镜像/站点网址，如 https://sc.panda985.com", style: { width: "100%" } });
    const key = el("input", { type: "password", placeholder: "OpenAlex / Semantic Scholar apiKey（可选）", style: { width: "100%" } });
    const cookie = el("input", { type: "password", placeholder: "镜像 Cookie（可选：浏览器过验证后 F12 复制 Cookie 头）", style: { width: "100%" } });
    const back = el("div", { id: "tpl-editor-backdrop" }, el("div", { class: "modal", style: { width: "560px" } },
      el("div", { class: "modal-head" }, el("span", {}, "添加检索源"), el("button", { class: "icon-btn", onclick: () => back.remove() }, "✕")),
      el("div", { class: "modal-body" },
        el("p", { class: "res-note" }, "填写网址及可选密钥/Cookie，系统会识别支持的检索源。部分学术镜像需要先在浏览器完成验证；Cookie 失效或站点限流时仍可能无法检索。"),
        el("label", { class: "modal-label" }, "网址", url),
        el("label", { class: "modal-label" }, "API Key（可选）", key),
        el("label", { class: "modal-label" }, "Cookie（可选）", cookie),
        el("div", { style: { display: "flex", gap: "8px", marginTop: "10px" } },
          el("button", {
            class: "tool-btn primary", onclick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const j = await requestJson("/api/search/sources/add", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ url: url.value, apiKey: key.value, cookie: cookie.value }),
                });
                toast("检索源已添加: " + (j.source?.name || ""));
                back.remove();
                renderSources();
              } catch (e) {
                toast("添加失败: " + e.message, true);
                button.disabled = false;
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
