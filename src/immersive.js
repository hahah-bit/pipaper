import { state, $, el, toast } from "./app.js";
import { listModules, getModule, registerBuiltinModules } from "./modules.js";
import { registerNoteModules, initNotesManage } from "./notesPanel.js";

// 沉浸式阅读工作台：模块化组合 + 两栏 / 一大两小布局。
// 布局与组合持久化；栏位头部可随时切换模块（同屏不允许重复模块，选择时自动互换）。

const LAYOUTS = {
  "2col": { name: "两栏", slots: 2, defaults: ["reader", "chat"] },
  "1+2": { name: "一大两小（左大 + 右侧上下两小）", slots: 3, defaults: ["reader", "chat", "mindmap"], stacked: true },
};
const CFG_KEY = "pipaper.immersive";
const WIDTH_KEY = "pipaper.immersiveWidths";
const MIN_W = 14, MAX_W = 78, MIN_H = 20;

let active = false;
let cfg = null;            // { layout, slots: [moduleId] }
let mounted = [];          // 每栏当前挂载的模块
let slotBodies = [];
let slotStatus = [];
let widths = {};           // layout → [百分比]

function validModules() { return listModules(); }

function sanitizeSlots(layout, slots) {
  const L = LAYOUTS[layout];
  const all = validModules();
  const out = [];
  for (const id of slots || []) if (all.some((m) => m.id === id) && !out.includes(id)) out.push(id);
  for (const d of L.defaults) if (out.length < L.slots && !out.includes(d) && all.some((m) => m.id === d)) out.push(d);
  for (const m of all) if (out.length < L.slots && !out.includes(m.id)) out.push(m.id);
  return out.slice(0, L.slots);
}

function loadCfg() {
  try {
    const saved = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
    if (saved && LAYOUTS[saved.layout]) return { layout: saved.layout, slots: sanitizeSlots(saved.layout, saved.slots) };
  } catch {}
  return null;
}
function saveCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {}
}
function widthsFor(layout) {
  // 一大两小是「左大 + 右侧上下两小」：{ big, top }；两栏是百分比数组
  if (LAYOUTS[layout].stacked) {
    let w = widths[layout];
    if (Array.isArray(w)) w = widths[layout] = null; // 旧版数组格式迁移
    if (!w || typeof w !== "object") {
      try { w = JSON.parse(localStorage.getItem(WIDTH_KEY) || "{}")[layout]; } catch {}
      if (Array.isArray(w)) w = null;
    }
    if (!w || typeof w !== "object" || !Number.isFinite(w.big)) w = { big: 58, top: 50 };
    w.big = Math.min(MAX_W, Math.max(MIN_W, w.big));
    w.top = Math.min(100 - MIN_H, Math.max(MIN_H, w.top));
    widths[layout] = w;
    return w;
  }
  if (!Array.isArray(widths[layout])) {
    try { widths[layout] = JSON.parse(localStorage.getItem(WIDTH_KEY) || "{}")[layout] || null; } catch {}
    if (!Array.isArray(widths[layout]) || widths[layout].length !== LAYOUTS[layout].slots) {
      widths[layout] = [50, 50];
    }
  }
  return widths[layout];
}
function persistWidths() {
  try {
    const all = JSON.parse(localStorage.getItem(WIDTH_KEY) || "{}");
    all[cfg.layout] = widthsFor(cfg.layout);
    localStorage.setItem(WIDTH_KEY, JSON.stringify(all));
  } catch {}
}

// ---------------- 弹出菜单 ----------------
// 全屏时只有 fullscreen 元素子树会渲染：菜单必须挂进 fullscreenElement 才能点得到。
let openMenuEl = null;
function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
function popupMenu(anchor, items) {
  closeMenu();
  const menu = el("div", { class: "imm-menu" },
    ...items.map((it) => el("button", {
      class: "imm-menu-item" + (it.active ? " active" : ""),
      onclick: () => { closeMenu(); it.onclick?.(); },
    }, it.label))
  );
  (document.fullscreenElement || document.body).append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + "px";
  menu.style.left = Math.min(Math.max(6, r.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 6) + "px";
  openMenuEl = menu;
  setTimeout(() => {
    const closer = (e) => { if (!menu.contains(e.target)) { closeMenu(); document.removeEventListener("pointerdown", closer); } };
    document.addEventListener("pointerdown", closer);
  }, 0);
}

// ---------------- 挂载 / 切换 ----------------
function ctxFor(i) {
  return { setStatus: (t) => { if (slotStatus[i]) slotStatus[i].textContent = t || ""; } };
}
function updateSlotHead(i) {
  const head = slotBodies[i]?.parentElement?.querySelector(".imm-slot-name");
  if (!head || !mounted[i]) return;
  head.querySelector(".imm-slot-icon").textContent = mounted[i].icon || "🧩";
  head.querySelector(".imm-slot-label").textContent = mounted[i].name || mounted[i].id;
}
function mountSlot(i, moduleId) {
  const m = getModule(moduleId) || getModule(LAYOUTS[cfg.layout].defaults[i]) || validModules()[0];
  if (!m) return;
  cfg.slots[i] = m.id;
  m.mount(slotBodies[i], ctxFor(i));
  mounted[i] = m;
  updateSlotHead(i);
}
function switchModule(i, newId) {
  if (!active || !getModule(newId)) return;
  const other = mounted.findIndex((x, idx) => x?.id === newId && idx !== i);
  if (other >= 0) {
    // 目标模块已在另一栏：两栏互换
    const oldId = mounted[i]?.id;
    mounted[other].unmount?.();
    const fallback = LAYOUTS[cfg.layout].defaults.concat(validModules().map((m) => m.id)).find((id) => id && id !== newId && getModule(id) && !cfg.slots.includes(id));
    cfg.slots[other] = oldId && oldId !== newId ? oldId : fallback;
    const m2 = getModule(cfg.slots[other]);
    m2.mount(slotBodies[other], ctxFor(other));
    mounted[other] = m2;
    updateSlotHead(other);
  }
  mounted[i]?.unmount?.();
  mounted[i] = null;
  mountSlot(i, newId);
  saveCfg();
}

// ---------------- 布局 ----------------
function applyWidths() {
  const slots = [...$("#imm-body").querySelectorAll(".imm-slot")];
  const w = widthsFor(cfg.layout);
  if (LAYOUTS[cfg.layout].stacked) {
    if (slots[0]) slots[0].style.flex = `0 0 ${w.big}%`;
    if (slots[1]) slots[1].style.flex = `0 0 ${w.top}%`;
    if (slots[2]) slots[2].style.flex = `0 0 ${100 - w.top}%`;
  } else {
    slots.forEach((s, i) => { if (w[i] != null) s.style.flex = `0 0 ${w[i]}%`; });
  }
}
function vDivider(i) {
  const d = el("div", { class: "imm-divider", title: "拖拽调整栏宽" });
  d.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const body = $("#imm-body");
      const total = body.clientWidth || 1;
      const left = body.getBoundingClientRect().left;
      const w = widthsFor(cfg.layout);
      if (LAYOUTS[cfg.layout].stacked) {
        w.big = Math.min(MAX_W, Math.max(MIN_W, ((ev.clientX - left) / total) * 100));
      } else {
        const pxBefore = (w.slice(0, i - 1).reduce((a, b) => a + b, 0) / 100) * total;
        const nw = Math.min(MAX_W, Math.max(MIN_W, ((ev.clientX - left - pxBefore) / total) * 100));
        const pair = w[i - 1] + w[i];
        w[i - 1] = nw;
        w[i] = pair - nw;
      }
      applyWidths();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistWidths();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  return d;
}
function hDivider() {
  const d = el("div", { class: "imm-divider h", title: "拖拽调整高度" });
  d.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const stack = d.parentElement;
      const total = stack.clientHeight || 1;
      const top = stack.getBoundingClientRect().top;
      const w = widthsFor(cfg.layout);
      w.top = Math.min(100 - MIN_H, Math.max(MIN_H, ((ev.clientY - top) / total) * 100));
      applyWidths();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      persistWidths();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  return d;
}
function unmountAll() {
  for (const m of mounted) { try { m?.unmount?.(); } catch {} }
  mounted = []; slotBodies = []; slotStatus = [];
}
function mkSlotEl(i) {
  const nameBtn = el("button", { class: "imm-slot-name", title: "切换这一栏的模块", onclick: (e) => openSwitchMenu(e.currentTarget, i) },
    el("span", { class: "imm-slot-icon" }), el("span", { class: "imm-slot-label" }), el("span", { class: "caret" }, "▾"));
  const status = el("span", { class: "imm-slot-status res-note" });
  const head = el("div", { class: "imm-slot-head" }, nameBtn, status, el("div", { class: "spacer" }));
  const bodyEl = el("div", { class: "imm-slot-body" });
  slotBodies.push(bodyEl); slotStatus.push(status); mounted.push(null);
  return el("div", { class: "imm-slot" }, head, bodyEl);
}
function buildLayout() {
  unmountAll();
  const body = $("#imm-body");
  body.replaceChildren();
  const L = LAYOUTS[cfg.layout];
  const w = widthsFor(cfg.layout);
  if (L.stacked) {
    // 左侧大栏 + 右侧上下两个小栏
    const big = mkSlotEl(0);
    const top = mkSlotEl(1);
    const bottom = mkSlotEl(2);
    body.append(big, vDivider(1), el("div", { class: "imm-stack" }, top, hDivider(), bottom));
  } else {
    const a = mkSlotEl(0);
    const b = mkSlotEl(1);
    body.append(a, vDivider(1), b);
  }
  cfg.slots = sanitizeSlots(cfg.layout, cfg.slots);
  cfg.slots.forEach((id, i) => mountSlot(i, id));
  applyWidths();
  saveCfg();
}
function openSwitchMenu(anchor, i) {
  const items = validModules()
    .filter((m) => m.id === mounted[i]?.id || !mounted.some((x) => x?.id === m.id))
    .map((m) => ({ label: `${m.icon} ${m.name}`, active: m.id === mounted[i]?.id, onclick: () => switchModule(i, m.id) }));
  popupMenu(anchor, items);
}
function setLayout(key) {
  if (!cfg || !LAYOUTS[key]) return;
  cfg.layout = key;
  cfg.slots = sanitizeSlots(key, cfg.slots);
  saveCfg();
  if (active) { buildLayout(); window.dispatchEvent(new Event("resize")); }
}

// ---------------- 进入 / 退出 ----------------
function start() {
  active = true;
  $("#imm-title").textContent = state.currentPaper?.title ? `沉浸阅读 · ${String(state.currentPaper.title).slice(0, 48)}` : "沉浸阅读（未选择论文）";
  $("#immersive").hidden = false;
  buildLayout();
  const root = $("#immersive");
  if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().catch(() => {});
  window.dispatchEvent(new Event("resize"));
}
export function exitImmersive() {
  if (!active) return;
  active = false;
  unmountAll();
  $("#immersive").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.dispatchEvent(new Event("resize"));
}
export function enterImmersive() {
  if (active) { exitImmersive(); return; }
  cfg = loadCfg();
  if (cfg) start();
  else openPicker({ onApply: (c) => { cfg = c; saveCfg(); start(); } });
}

// ---------------- 组合选择器 ----------------
function openPicker({ onApply } = {}) {
  const modules = validModules();
  let layout = cfg?.layout || "2col";
  let slots = sanitizeSlots(layout, cfg?.slots || LAYOUTS[layout].defaults);
  const dlg = el("dialog", { class: "native-dialog imm-picker" });
  const layoutRow = el("div", { class: "imm-pick-row" });
  const slotsRow = el("div", { class: "imm-pick-slots" });

  function drawSlots() {
    slotsRow.replaceChildren();
    const L = LAYOUTS[layout];
    slots = sanitizeSlots(layout, slots);
    for (let i = 0; i < L.slots; i++) {
      const sel = el("select", { title: "这一栏显示的模块" });
      for (const m of modules) sel.append(el("option", { value: m.id }, `${m.icon} ${m.name}`));
      sel.value = slots[i];
      sel.addEventListener("change", () => {
        const dup = slots.findIndex((v, idx) => idx !== i && v === sel.value);
        const old = slots[i];
        slots[i] = sel.value;
        if (dup >= 0) slots[dup] = old; // 冲突时两栏互换
        drawSlots();
      });
      slotsRow.append(el("label", { class: "imm-pick-slot" },
        el("span", {}, L.slots === 3 ? (i === 0 ? "大栏" : `小栏 ${i}`) : `栏 ${i + 1}`), sel));
    }
  }
  function drawLayout() {
    layoutRow.replaceChildren(el("span", { class: "imm-pick-label" }, "布局"));
    for (const [key, L] of Object.entries(LAYOUTS)) {
      layoutRow.append(el("button", {
        class: "tool-btn" + (key === layout ? " primary" : ""),
        onclick: () => { layout = key; drawLayout(); drawSlots(); },
      }, L.name));
    }
  }
  const preset = (label, l, s) => el("button", { class: "tool-btn", onclick: () => done({ layout: l, slots: sanitizeSlots(l, s) }) }, label);
  function done(v) { dlg.close(); dlg.remove(); if (v) { cfg = v; saveCfg(); onApply?.(v); } }

  drawLayout(); drawSlots();
  dlg.append(
    el("header", {}, el("strong", {}, "沉浸式阅读 · 布局与模块组合")),
    el("div", { class: "native-dialog-body" },
      el("p", { class: "res-note", style: { margin: "0 0 10px" } }, "每个栏位放一个功能模块，进入后可在栏位标题处随时切换；组合会被记住，下次一键进入。"),
      layoutRow,
      slotsRow,
      el("div", { class: "imm-pick-presets" },
        el("span", { class: "imm-pick-label" }, "快速组合"),
        preset("📖 阅读 + 💬 对话", "2col", ["reader", "chat"]),
        preset("📖 阅读 + 💬 对话 + 🧠 导图", "1+2", ["reader", "chat", "mindmap"]),
        preset("📖 阅读 + 🧠 导图", "2col", ["reader", "mindmap"]),
      ),
    ),
    el("div", { class: "dlg-btnrow" },
      el("button", { class: "tool-btn", onclick: () => done(null) }, "取消"),
      el("button", { class: "tool-btn primary", onclick: () => done({ layout, slots }) }, "进入沉浸阅读"),
    )
  );
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------- init ----------------
export function initImmersive() {
  registerBuiltinModules();
  registerNoteModules();
  initNotesManage();
  cfg = loadCfg();

  $("#btn-immersive")?.addEventListener("click", () => enterImmersive());
  $("#btn-imm-exit")?.addEventListener("click", () => exitImmersive());
  $("#btn-imm-combo")?.addEventListener("click", (e) => {
    popupMenu(e.currentTarget, [
      {
        label: "🔄 重新选择布局与模块…",
        onclick: () => openPicker({
          onApply: (c) => {
            cfg = c; saveCfg();
            if (active) buildLayout();
            else start();
          },
        }),
      },
      ...Object.entries(LAYOUTS).map(([key, L]) => ({ label: `${L.name}${cfg?.layout === key ? " ✓" : ""}`, active: cfg?.layout === key, onclick: () => setLayout(key) })),
    ]);
  });
  $("#btn-imm-layout")?.addEventListener("click", (e) => {
    popupMenu(e.currentTarget, Object.entries(LAYOUTS).map(([key, L]) => ({
      label: `${L.name}${cfg?.layout === key ? " ✓" : ""}`, active: cfg?.layout === key, onclick: () => setLayout(key),
    })));
  });
}
