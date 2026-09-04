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
    const activeProj = state.projects.find((p) => p.id === state.projectId);
    for (const f of files) {
      try {
        const r = await api.importPdf(f, state.projectId);
        await reloadPapers();
        const where = activeProj ? `，已归入项目「${activeProj.name}」` : "";
        toast(r.reused ? `${f.name} 与已管理论文内容相同，已复用解析状态${where}` : `${f.name} 已导入${where}`);
      } catch (err) {
        toast(`导入失败: ${err.message}`, true);
      }
    }
  });
  // project controls
  $("#project-select").addEventListener("change", (e) => switchProject(e.target.value));
  $("#btn-del-project").addEventListener("click", async () => {
    const p = state.projects.find((x) => x.id === state.projectId);
    if (!p) return;
    if (!confirm(`删除项目「${p.name}」？（论文不会被删除，只解除分组）`)) return;
    try {
      await api.deleteProject(p.id);
      state.projects = state.projects.filter((x) => x.id !== p.id);
      state.projectId = null;
      renderProjects();
      renderPapers();
      toast(`项目「${p.name}」已删除`);
    } catch (e) {
      toast("删除失败: " + e.message, true);
    }
  });
  $("#btn-new-project").addEventListener("click", async () => {
    const name = prompt("项目名称：");
    if (!name?.trim()) return;
    const asZotero = confirm(`「${name.trim()}」是否作为 Zotero 联动项目？\n\n确定 = Zotero 联动（会话自动加载论文综合技能组，工具栏出现打开 Zotero 按钮）\n取消 = 临时文献项目`);
    try {
      const p = await api.createProject(name.trim(), asZotero ? "zotero" : "temp");
      p.type = asZotero ? "zotero" : "temp";
      state.projects.push(p);
      state.projectId = p.id;
      renderProjects();
      renderPapers();
      updateProjectBar();
      toast(`项目「${p.name}」已创建${asZotero ? "（Zotero 联动）" : ""}`);
    } catch (e) {
      toast("创建失败: " + e.message, true);
    }
  });
  $("#btn-open-zotero").addEventListener("click", () => {
    window.open("zotero://open-library", "_blank");
    setTimeout(() => toast("如果 Zotero 未打开，请确认 Zotero 已安装并在运行", true), 800);
  });
}

export async function loadPapers(refresh = false) {
  const data = await api.papers(refresh);
  state.papers = data.papers;
  state.collections = data.collections;
  state.zotero = data.zotero;
  if (data.projects) state.projects = data.projects;
  return data;
}

export async function reloadPapers(refresh = false) {
  await loadPapers(refresh);
  renderCollections();
  renderProjects();
  renderPapers();
  updateZoteroFoot();
}

// ---- projects ----

export function renderProjects() {
  const sel = $("#project-select");
  if (!sel) return;
  sel.replaceChildren();
  sel.append(el("option", { value: "" }, `📂 全部文献 (${state.papers.length}篇)`));
  for (const p of state.projects) {
    sel.append(el("option", { value: p.id }, `${p.type === "zotero" ? "🔗" : "📁"} ${p.name} (${p.paperIds.length}篇)`));
  }
  sel.value = state.projectId || "";
  $("#btn-del-project").hidden = !state.projectId;
  updateProjectBar();
}

function updateProjectBar() {
  const proj = state.projects.find((x) => x.id === state.projectId);
  const btn = $("#btn-open-zotero");
  if (btn) btn.hidden = proj?.type !== "zotero";
}

export async function switchProject(id) {
  state.projectId = id || null;
  renderProjects();
  renderPapers();
  // refresh session list so dropdown regroups
  const { refreshSessions, syncSessionBinding } = await import("./chat.js");
  await syncSessionBinding();
  await refreshSessions();
}

async function togglePaperInProject(paperId) {
  if (!state.projectId) return toast("先在顶部选择或新建一个项目", true);
  try {
    const p = state.projects.find((x) => x.id === state.projectId);
    const has = p.paperIds.includes(paperId);
    await api.updateProject(state.projectId, has ? { removePaper: paperId } : { addPaper: paperId });
    has ? p.paperIds = p.paperIds.filter((x) => x !== paperId) : p.paperIds.push(paperId);
    renderPapers();
    toast(has ? "已从项目移除" : "已加入项目");
  } catch (e) {
    toast("操作失败: " + e.message, true);
  }
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
  const proj = state.projects.find((x) => x.id === state.projectId);
  let list = state.papers;
  if (proj) {
    list = list.filter((p) => proj.paperIds.includes(p.id));
  } else if (activeCollection != null) {
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
    wrap.append(el("div", { style: { color: "var(--fg2)", fontSize: "13px", padding: "12px 8px" } },
      proj ? "项目里还没有论文 — 在「全部」里点击论文条目上的 📁 加入" : "没有论文 — 导入 PDF 或同步 Zotero"));
    return;
  }
  for (const p of list) {
    const status = p.parse?.status || "none";
    const authors = (p.creators || []).slice(0, 2).join(", ");
    const inProject = proj?.paperIds.includes(p.id);
    const item = el(
      "div",
      { class: "paper-item" + (state.currentPaper?.id === p.id ? " active" : ""), onclick: () => selectPaper(p) },
      el("div", { class: "t" }, p.title || "(无标题)"),
      el("div", { class: "m" },
        el("span", { class: "dot " + status, title: "解析状态: " + status }),
        el("span", { class: "m-text" }, [authors, p.year, p.source === "zotero" ? collectionName((p.collectionIds || [])[0]) || "Zotero" : "本地导入"].filter(Boolean).join(" · ")),
        el("button", {
          class: "p-proj" + (inProject ? " in" : ""),
          title: proj ? (inProject ? "从项目中移除" : "加入当前项目") : "加入项目（先在顶部选择项目）",
          onclick: (e) => { e.stopPropagation(); togglePaperInProject(p.id); },
        }, inProject ? "✓" : "📁")
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
  const { updateComposerHint, syncSessionBinding } = await import("./chat.js");
  updateComposerHint();
  await syncSessionBinding();
}
