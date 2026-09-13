import { $, el, toast } from "./app.js";
import { getModule, registerModule, reparentModule } from "./modules.js";
import { figureDrawerModule } from "./figurePanel.js";
import { openSetup } from "./setupPanel.js";
import { openSettings } from "./settings.js";
import { openNotesManage } from "./notesPanel.js";
import { DockviewComponent, themeAbyss } from "dockview-core";

// Dock：macOS dock 式功能导航。图标按大分类分组、悬浮放大并显示名称。
// 点击 → 右侧抽屉（占满阅读器同区域）。抽屉是 dockview 工作区：
// 每个功能 = 一个可拖动面板（拖标签分栏 / 重排 / 组合），布局持久化；
// 再点击同一图标 = 关闭该面板，全部面板关闭时抽屉自动收起 → 回到默认的阅读器。
// 新功能接入：注册一个模块（modules.js）并在 DOCK_GROUPS 里加一项即可。

const DOCK_GROUPS = [
  { items: [
    { key: "reader", icon: "📖", name: "阅读器", special: "close", hint: "回到阅读器（默认视图）" },
  ] },
  { label: "图表 · 知识库", items: [
    { key: "figana", icon: "📊", name: "图表分析", hint: "图解析 / 表解析 / 复现大纲" },
    { key: "note", icon: "📝", name: "粗读解析" },
    { key: "mindmap", icon: "🧠", name: "思维导图" },
    { key: "flow", icon: "🗺", name: "流程图" },
  ] },
  { label: "创作 · 产出", items: [
    { key: "mdedit", icon: "✍️", name: "LaTeX·MD 编辑", hint: "手工 + AI 辅助编辑 Markdown 文档" },
    { key: "latex", icon: "📄", name: "LaTeX 编辑", hint: "编译 .tex 并预览 PDF" },
    { key: "artifact", icon: "📦", name: "产出物", hint: "本会话 agent 写出的文件" },
  ] },
  { label: "检索 · 媒体", items: [
    { key: "search", icon: "🔍", name: "论文检索" },
    { key: "video", icon: "🎬", name: "视频解析" },
  ] },
  { label: "系统", items: [
    { key: "notesmgr", icon: "🗂", name: "笔记管理", dialog: openNotesManage },
    { key: "resources", icon: "🧩", name: "资源管理", dialog: () => $("#btn-resources")?.click() },
    { key: "setup", icon: "🩺", name: "环境检查", dialog: openSetup },
    { key: "settings", icon: "⚙", name: "设置", dialog: openSettings },
  ] },
];

const LAYOUT_KEY = "pipaper.workspace";

let dv = null;                 // DockviewComponent 实例（抽屉打开期间存活）
let panelSeq = 0;
const mounted = new Map();     // moduleId → { def }；面板存在 = 模块挂载中

function appRoot() { return document.getElementById("app"); }

function findItem(key) {
  for (const g of DOCK_GROUPS) for (const it of g.items) if (it.key === key) return it;
  return null;
}

function syncDockActive() {
  const open = new Set((dv?.panels || []).map((p) => p.params?.moduleId).filter(Boolean));
  for (const btn of document.querySelectorAll(".dock-btn")) {
    const item = findItem(btn.dataset.key);
    if (item?.special === "close") btn.classList.toggle("active", open.size === 0);
    else btn.classList.toggle("active", open.has(btn.dataset.key));
  }
}

// ---------------- dockview 工作区 ----------------
function makeRenderer() {
  let moduleId = null;
  let def = null;
  let dead = false;
  const statusEl = el("div", { class: "dvp-status res-note", hidden: true });
  const bodyEl = el("div", { class: "dvp-body" });
  const root = el("div", { class: "dvp" }, statusEl, bodyEl);
  return {
    element: root,
    init(parameters) {
      moduleId = parameters.params?.moduleId || null;
      def = moduleId ? getModule(moduleId) : null;
      const item = moduleId ? findItem(moduleId) : null;
      if (!def) {
        bodyEl.append(el("div", { class: "res-note", style: { padding: "18px" } }, "模块未注册：" + (moduleId || "(未知)")));
        return;
      }
      mounted.set(moduleId, { def, item });
      try {
        def.mount(bodyEl, {
          setStatus: (t) => {
            statusEl.textContent = t || "";
            statusEl.hidden = !t;
          },
        });
      } catch (e) {
        console.error(e);
        bodyEl.append(el("div", { class: "res-note", style: { padding: "18px" } }, `打开「${item?.name || moduleId}」失败: ${e.message || e}`));
      }
      syncDockActive();
    },
    dispose() {
      if (dead) return;
      dead = true;
      if (def) { try { def.unmount?.(); } catch (e) { console.error(e); } }
      if (moduleId) mounted.delete(moduleId);
      syncDockActive();
    },
  };
}

function makeWatermark() {
  return {
    element: el("div", { class: "dv-wm" },
      el("div", { class: "dv-wm-icon" }, "🧩"),
      el("div", { class: "dv-wm-t" }, "工作区为空"),
      el("div", { class: "dv-wm-s" }, "从右侧 Dock 点击功能图标打开面板", el("br"), "拖动面板标签可分栏 · 重排 · 组合，布局自动保存")),
    init() {},
  };
}

function ensureWorkspace() {
  if (dv) return dv;
  const body = $("#dock-drawer-body");
  body.replaceChildren();
  dv = new DockviewComponent(body, {
    createComponent: makeRenderer,
    createWatermarkComponent: makeWatermark,
    theme: themeAbyss,
    // 标签放不下时收进下拉（禁用换行：窄面板下换行会退化成一列竖排）
    overflow: { mode: "dropdown" },
  });
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      const layout = JSON.parse(saved);
      if (layout?.panels && Object.keys(layout.panels).length) dv.fromJSON(layout);
    }
  } catch (e) { console.warn("工作区布局恢复失败", e); }
  dv.onDidLayoutChange(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(dv.toJSON())); } catch {}
  });
  dv.onDidRemovePanel(() => {
    syncDockActive();
    if (dv && !dv.panels.length) closeDrawer();
  });
  window.dispatchEvent(new Event("resize"));
  return dv;
}

// ---------------- 打开 / 关闭 ----------------
function openItem(item) {
  if (item.special === "close") { closeDrawer(); return; }
  if (item.dialog) { item.dialog(); return; }
  const m = getModule(item.key);
  if (!m) return toast(`「${item.name}」尚未就绪（模块未注册）`, true);
  // 以 dv.panels 为权威状态：再点击已打开的图标 = 关闭该面板（最后一个面板关闭时抽屉一起收起）
  const opened = dv?.panels.filter((p) => p.params?.moduleId === item.key) || [];
  if (opened.length) {
    opened.forEach((p) => p.api.close());
    return;
  }
  appRoot().classList.add("dock-open");
  $("#dock-drawer").hidden = false;
  ensureWorkspace();
  // 布局恢复可能已包含该模块的面板：有则直接激活（避免重复添加）
  const existing = dv.panels.find((p) => p.params?.moduleId === item.key);
  if (existing) {
    existing.api.setActive();
    $("#dock-drawer-icon").textContent = item.icon;
    $("#dock-drawer-title").textContent = item.name;
    syncDockActive();
    return;
  }
  $("#dock-drawer-icon").textContent = item.icon;
  $("#dock-drawer-title").textContent = item.name;
  const panel = dv.addPanel({
    id: `${item.key}#${++panelSeq}`,
    component: "module",
    title: `${item.icon} ${item.name}`,
    params: { moduleId: item.key },
  });
  panel.api.setActive();
  syncDockActive();
  window.dispatchEvent(new Event("resize"));
}

export function closeDrawer() {
  const inst = dv;
  dv = null;
  if (inst) {
    // dispose 之后 onDidLayoutChange 不再发出：先如实保存最终布局（面板全关 = 空布局）
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(inst.toJSON())); } catch {}
    try { inst.dispose(); } catch (e) { console.error(e); } // dispose 逐面板触发 unmount
  }
  mounted.clear();
  $("#dock-drawer-body").replaceChildren();
  appRoot().classList.remove("dock-open");
  $("#dock-drawer").hidden = true;
  syncDockActive();
  window.dispatchEvent(new Event("resize"));
}

function renderDock() {
  const dock = $("#dock");
  dock.replaceChildren();
  for (const group of DOCK_GROUPS) {
    if (group.label) dock.append(el("div", { class: "dock-sep", title: group.label }));
    for (const item of group.items) {
      dock.append(el("button", {
        class: "dock-btn",
        "data-key": item.key,
        "data-name": item.name,
        title: item.hint || item.name,
        onclick: () => openItem(item),
      }, el("span", { class: "dock-glyph" }, item.icon)));
    }
  }
  syncDockActive();
}

export function initDock() {
  // 抽屉型功能模块：检索 / 视频 / 产出物（DOM 搬迁，搬回原位即还原）
  registerModule(reparentModule({ id: "search", name: "论文检索", icon: "🔍", selector: "#stab-search" }));
  registerModule(reparentModule({ id: "video", name: "视频解析", icon: "🎬", selector: "#stab-video" }));
  registerModule(reparentModule({ id: "artifact", name: "产出物", icon: "📦", selector: "#artifacts-view", keepClasses: ["list-collapsed"] }));
  registerModule(figureDrawerModule());

  renderDock();
  $("#btn-drawer-close")?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#dock-drawer").hidden && !document.querySelector("dialog[open]")) {
      closeDrawer();
    }
  });
}
