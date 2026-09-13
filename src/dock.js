import { $, el, toast } from "./app.js";
import { getModule, registerModule, reparentModule } from "./modules.js";
import { figureDrawerModule } from "./figurePanel.js";
import { openSetup } from "./setupPanel.js";
import { openSettings } from "./settings.js";
import { openNotesManage } from "./notesPanel.js";

// Dock：macOS dock 式功能导航。图标按大分类分组、悬浮放大并显示名称；
// 点击 → 右侧抽屉（占满阅读器同区域），再点一次或 ✕ 关闭 → 回到默认的阅读器。
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

let activeKey = null;   // 当前抽屉里的 dock item key；null = 默认阅读器
let mountedDef = null;

function appRoot() { return document.getElementById("app"); }

function unmountCurrent() {
  try { mountedDef?.unmount?.(); } catch (e) { console.error(e); }
  mountedDef = null;
}

function syncDockActive() {
  for (const btn of document.querySelectorAll(".dock-btn")) {
    const key = btn.dataset.key;
    const item = findItem(key);
    if (item?.special === "close") btn.classList.toggle("active", activeKey == null);
    else btn.classList.toggle("active", activeKey === key);
  }
}

function findItem(key) {
  for (const g of DOCK_GROUPS) for (const it of g.items) if (it.key === key) return it;
  return null;
}

function openItem(item) {
  if (item.special === "close") { closeDrawer(); return; }
  if (item.dialog) { item.dialog(); return; }
  const m = getModule(item.key);
  if (!m) return toast(`「${item.name}」尚未就绪（模块未注册）`, true);
  if (activeKey === item.key) { closeDrawer(); return; } // 再点一次 = 收起
  unmountCurrent();
  const body = $("#dock-drawer-body");
  $("#dock-drawer-icon").textContent = item.icon;
  $("#dock-drawer-title").textContent = item.name;
  $("#dock-drawer-status").textContent = "";
  try {
    m.mount(body, { setStatus: (t) => { $("#dock-drawer-status").textContent = t || ""; } });
  } catch (e) {
    console.error(e);
    toast(`打开「${item.name}」失败: ${e.message || e}`, true);
    return;
  }
  // 检索/视频 stab 之前可能带着 hidden 属性（旧版 tab 逻辑遗留），搬入抽屉后强制可见
  body.querySelectorAll(".stab[hidden]").forEach((n) => (n.hidden = false));
  mountedDef = m;
  activeKey = item.key;
  appRoot().classList.add("dock-open");
  $("#dock-drawer").hidden = false;
  syncDockActive();
  window.dispatchEvent(new Event("resize"));
}

export function closeDrawer() {
  if (activeKey == null && $("#dock-drawer").hidden) return;
  unmountCurrent();
  $("#dock-drawer-body").replaceChildren();
  appRoot().classList.remove("dock-open");
  $("#dock-drawer").hidden = true;
  activeKey = null;
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
    if (e.key === "Escape" && activeKey != null && !$("#dock-drawer").hidden && !document.querySelector("dialog[open]")) {
      closeDrawer();
    }
  });
}
