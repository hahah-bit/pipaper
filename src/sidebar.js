import { api, state, $, el, toast, updateZoteroFoot } from "./app.js";

let activeCollection = null; // collection id or null = all
let searchQ = "";

export function initSidebar() {
  $("#paper-search").addEventListener("input", (e) => {
    searchQ = e.target.value.trim().toLowerCase();
    renderPapers();
  });
  $("#btn-import").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    for (const f of files) {
      try {
        toast(`导入 ${f.name} …`);
        await api.importPdf(f);
        await reloadPapers();
        toast(`${f.name} 已导入`, false);
      } catch (err) {
        toast(`导入失败: ${err.message}`, true);
      }
    }
  });
}

export async function loadPapers(refresh = false) {
  const data = await api.papers(refresh);
  state.papers = data.papers;
  state.collections = data.collections;
  state.zotero = data.zotero;
  return data;
}

export async function reloadPapers(refresh = false) {
  await loadPapers(refresh);
  renderCollections();
  renderPapers();
  updateZoteroFoot();
}

export function renderCollections() {
  const wrap = $("#collections");
  wrap.replaceChildren();
  const cols = state.collections || [];
  if (!cols.length) {
    wrap.append(el("div", { class: "coll-item", style: { color: "var(--fg2)" } }, "（无分类目录）"));
    return;
  }
  const byParent = new Map();
  for (const c of cols) {
    const key = c.parentId == null ? "root" : c.parentId;
    (byParent.get(key) || byParent.set(key, []).get(key)).push(c);
  }
  const nameOf = (id) => cols.find((c) => c.id === id)?.name || "";

  const mk = (c, depth) => {
    const item = el("div", { class: "coll-item" + (activeCollection === c.id ? " active" : ""), onclick: () => { activeCollection = activeCollection === c.id ? null : c.id; renderCollections(); renderPapers(); } }, nameOf(c.id) || `分类 ${c.id}`);
    const children = (byParent.get(c.id) || []).map((x) => mk(x, depth + 1));
    const box = el("div", { class: depth === 0 ? "" : "coll-children" }, item, el("div", { class: "coll-children" }, children));
    return box;
  };
  const allBtn = el("div", { class: "coll-item" + (activeCollection === null ? " active" : ""), onclick: () => { activeCollection = null; renderCollections(); renderPapers(); } }, "全部文献");
  wrap.append(allBtn);
  for (const c of byParent.get("root") || []) wrap.append(mk(c, 0));
}

function collectionName(id) {
  return state.collections.find((c) => c.id === id)?.name || "";
}

export function renderPapers() {
  const wrap = $("#paper-list");
  wrap.replaceChildren();
  let list = state.papers;
  if (activeCollection != null) {
    list = list.filter((p) => (p.collectionIds || []).includes(activeCollection));
  }
  if (searchQ) {
    list = list.filter((p) => {
      const hay = [p.title, (p.creators || []).join(" "), p.year, p.abstract].join(" ").toLowerCase();
      return hay.includes(searchQ);
    });
  }
  list = [...list].sort((a, b) => String(b.added || "").localeCompare(String(a.added || "")));
  if (!list.length) {
    wrap.append(el("div", { style: { color: "var(--fg2)", fontSize: "13px", padding: "12px 8px" } }, "没有论文 — 导入 PDF 或同步 Zotero"));
    return;
  }
  for (const p of list) {
    const status = p.parse?.status || "none";
    const authors = (p.creators || []).slice(0, 2).join(", ");
    const item = el(
      "div",
      { class: "paper-item" + (state.currentPaper?.id === p.id ? " active" : ""), onclick: () => selectPaper(p) },
      el("div", { class: "t" }, p.title || "(无标题)"),
      el("div", { class: "m" },
        el("span", { class: "dot " + status, title: "解析状态: " + status }),
        el("span", {}, [authors, p.year, p.source === "zotero" ? collectionName((p.collectionIds || [])[0]) || "Zotero" : "本地导入"].filter(Boolean).join(" · "))
      )
    );
    wrap.append(item);
  }
}

export async function selectPaper(p) {
  state.currentPaper = state.papers.find((x) => x.id === p.id) || p;
  renderPapers();
  const { readerLoadPaper } = await import("./reader.js");
  readerLoadPaper(p);
  const { updateComposerHint } = await import("./chat.js");
  updateComposerHint();
}
