import { persistence } from "./persistence.js";
import { $, el, toast } from "./app.js";
import { getModule, registerModule, reparentModule } from "./modules.js";
import { figureDrawerModule } from "./figurePanel.js";
import { openSettings } from "./settings.js";
import { archifyModule } from "./archifyPanel.js";
import { storageModule, knowledgeModule } from "./storagePanel.js";
import { DockviewComponent, themeAbyss } from "dockview-core";
import { dockIcon } from "./dockIcons.js";
import {
  WORKSPACES,
  workspaceById,
  moduleDestination,
  migrateWorkspace,
} from "./workspaceNavigation.js";
import { taskWorkspace, diagramModule } from "./taskWorkspace.js";
import { subscribeStorageEvents, storageSummary } from "./storageEvents.js";

const LAYOUT_KEY = "pipaper.workspace";
let dv = null,
  panelSeq = 0,
  restoring = false;
const mounted = new Map();
function saveLayout() {
  if (dv && !restoring)
    persistence.setItem(LAYOUT_KEY, JSON.stringify(dv.toJSON()));
}
function syncDockActive() {
  const shown = !$("#dock-drawer").hidden;
  const settings = !$("#modal-backdrop").hidden;
  const areaId = settings
    ? "settings"
    : shown
      ? dv?.activePanel?.params?.workspaceId
      : "reader";
  for (const button of document.querySelectorAll(".dock-btn")) {
    const active = button.dataset.key === areaId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}
function updateHeader(panel) {
  const area = workspaceById(panel?.params?.workspaceId);
  if (!area) return;
  $("#dock-drawer-icon").replaceChildren(dockIcon(area.icon, ""));
  const view = area.views.find((v) => v.id === panel.params.activeView);
  $("#dock-drawer-title").textContent =
    area.name + (view && view.name !== area.name ? " · " + view.name : "");
  syncDockActive();
}
function makeRenderer() {
  const root = el("div", { class: "dvp" });
  let workspace, legacy;
  return {
    element: root,
    init(parameters) {
      const area = workspaceById(parameters.params?.workspaceId);
      if (!area) {
        legacy = getModule(parameters.params?.moduleId);
        legacy?.mount(root);
        return;
      }
      workspace = taskWorkspace(area, parameters.params, (activeView) => {
        parameters.api.updateParameters({
          workspaceId: area.id,
          activeView,
          diagramKind: undefined,
          libraryView: undefined,
        });
        persistence.setItem("pipaper.workspace.area", area.id);
        if (dv?.activePanel?.id === parameters.api.id)
          updateHeader(dv.activePanel);
        saveLayout();
      });
      mounted.set(parameters.api.id, workspace);
      root.append(workspace.element);
      workspace.init();
    },
    dispose() {
      workspace?.dispose();
      legacy?.unmount?.();
      for (const [id, item] of mounted)
        if (item === workspace) mounted.delete(id);
    },
  };
}
function ensureWorkspace() {
  if (dv) return;
  const body = $("#dock-drawer-body");
  dv = new DockviewComponent(body, {
    createComponent: makeRenderer,
    createWatermarkComponent: () => ({
      element: el(
        "div",
        { class: "dv-wm" },
        "从右侧选择检索、解读、写作或资料",
      ),
      init() {},
    }),
    theme: themeAbyss,
    overflow: { mode: "dropdown" },
  });
  dv.onDidActivePanelChange(({ panel }) => updateHeader(panel));
  try {
    const saved = persistence.getItem(LAYOUT_KEY);
    if (saved) {
      const original = JSON.parse(saved),
        layout = migrateWorkspace(original);
      if (JSON.stringify(original) !== JSON.stringify(layout)) {
        if (!persistence.getItem("pipaper.workspace.legacy-backup"))
          persistence.setItem("pipaper.workspace.legacy-backup", saved);
      }
      if (layout?.grid && Object.keys(layout.panels || {}).length) {
        restoring = true;
        try {
          dv.fromJSON(layout);
        } finally {
          restoring = false;
        }
      }
    }
  } catch (error) {
    console.warn("工作区布局恢复失败", error);
  }
  dv.onDidLayoutChange(saveLayout);
  dv.onDidRemovePanel(() => {
    syncDockActive();
    if (!dv?.panels.length) closeDrawer();
  });
  saveLayout();
}
export function openWorkspace(areaId, view, payload) {
  const area = workspaceById(areaId);
  if (!area) return;
  $("#app").classList.add("dock-open");
  $("#dock-drawer").hidden = false;
  ensureWorkspace();
  let panel = dv.panels.find((p) => p.params?.workspaceId === areaId);
  if (!panel) {
    while (dv.panels.some((p) => p.id === areaId + "#" + (panelSeq + 1)))
      panelSeq++;
    panel = dv.addPanel({
      id: areaId + "#" + ++panelSeq,
      component: "module",
      title: area.name,
      params: {
        workspaceId: areaId,
        activeView:
          view || persistence.getItem("pipaper.workspace.view." + areaId),
      },
    });
  }
  panel.api.setActive();
  if (view) mounted.get(panel.id)?.select(view, payload);
  updateHeader(panel);
  window.dispatchEvent(new Event("resize"));
}
export function closeDrawer() {
  // Reading changes destination without destroying editors or their unsaved drafts.
  saveLayout();
  $("#app").classList.remove("dock-open");
  $("#dock-drawer").hidden = true;
  syncDockActive();
  window.dispatchEvent(new Event("resize"));
}
function renderDock() {
  const dock = $("#dock");
  dock.replaceChildren();
  const items = [
    { id: "reader", name: "阅读", icon: "reader" },
    ...WORKSPACES,
    { id: "settings", name: "设置", icon: "settings" },
  ];
  for (const item of items) {
    const button = el(
      "button",
      {
        class: "dock-btn" + (item.id === "settings" ? " dock-settings" : ""),
        "data-key": item.id,
        "data-name": item.name,
        "aria-label": item.name,
        title: item.name,
        onclick: () =>
          item.id === "reader"
            ? closeDrawer()
            : item.id === "settings"
              ? openSettings()
              : openWorkspace(item.id),
      },
      el("span", { class: "dock-glyph" }, dockIcon(item.icon, "")),
      el("span", { class: "dock-label" }, item.name),
    );
    dock.append(button);
  }
  syncDockActive();
}
export function initDock() {
  registerModule(
    reparentModule({
      id: "search",
      name: "论文检索",
      selector: "#stab-search",
    }),
  );
  registerModule(
    reparentModule({ id: "video", name: "视频解析", selector: "#stab-video" }),
  );
  registerModule(
    reparentModule({
      id: "artifact",
      name: "会话产出",
      selector: "#artifacts-view",
      keepClasses: ["list-collapsed"],
    }),
  );
  registerModule(figureDrawerModule());
  registerModule(archifyModule());
  registerModule(diagramModule());
  registerModule(storageModule());
  registerModule(knowledgeModule());
  renderDock();
  $("#btn-drawer-close")?.addEventListener("click", closeDrawer);
  let summarySequence = 0;
  const refreshSummary = async () => {
    const ticket = ++summarySequence;
    try {
      const responses = await Promise.all([
        fetch("/api/ingestion/jobs"),
        fetch("/api/rag/reviews"),
      ]);
      if (responses.some((response) => !response.ok)) return;
      const [jobs, reviews] = await Promise.all(
        responses.map((response) => response.json()),
      );
      if (ticket !== summarySequence) return;
      const summary = storageSummary(jobs.jobs, reviews.reviews);
      const button = document.querySelector('.dock-btn[data-key="library"]');
      button.querySelector(".dock-badge")?.remove();
      const count = summary.failed + summary.reviews;
      if (count || summary.running)
        button.append(el("span", { class: "dock-badge" }, count || "·"));
      button.title = `资料 · 运行 ${summary.running} · 待处理 ${summary.failed} · 待核对 ${summary.reviews}`;
    } catch {
      /* The last observed status remains visible during temporary service outages. */
    }
  };
  subscribeStorageEvents(refreshSummary);
  void refreshSummary();
  window.addEventListener("pipaper:settings-visibility", syncDockActive);
  window.addEventListener("pipaper:workspace-open", (event) => {
    const { moduleId, ...payload } = event.detail || {};
    const destination = moduleDestination(moduleId);
    if (destination)
      openWorkspace(destination.workspaceId, destination.activeView, {
        ...destination,
        ...payload,
      });
    else toast("未找到对应的工作区", true);
  });
  document.addEventListener("keydown", (event) => {
    const tabs = event.target.closest?.(".workspace-tabs");
    if (
      tabs &&
      event.target.getAttribute("role") === "tab" &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      const buttons = [...tabs.querySelectorAll('[role="tab"]')].filter(
        (button) => !button.disabled,
      );
      const index = buttons.indexOf(event.target);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
              buttons.length;
      event.preventDefault();
      buttons[next]?.click();
      buttons[next]?.focus();
      return;
    }
    if (
      event.key === "Escape" &&
      !$("#dock-drawer").hidden &&
      !document.querySelector("dialog[open]") &&
      $("#modal-backdrop").hidden &&
      !document.querySelector(".mindmap-lightbox")
    )
      closeDrawer();
  });
}
