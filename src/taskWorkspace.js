import { el } from "./platform/dom.js";
import { state } from "./shell/state.js";
import { getModule } from "./modules.js";
import { persistence } from "./persistence.js";

// Each view mounts once. Navigation changes visibility, never an editor's identity.
export function taskWorkspace(area, initial, onChange) {
  const views = new Map();
  let active;
  const context = el("div", { class: "workspace-context" });
  const tabs = el("div", {
    class: "workspace-tabs",
    role: "tablist",
    "aria-label": area.name + "功能",
  });
  const content = el("div", { class: "workspace-content" });
  const root = el(
    "div",
    { class: "task-workspace", "data-workspace": area.id },
    context,
    tabs,
    content,
  );
  const buttons = new Map();
  for (const view of area.views.filter((v) => !v.secondary)) {
    const button = el(
      "button",
      {
        class: "workspace-tab",
        role: "tab",
        id: "workspace-tab-" + area.id + "-" + view.id,
        "aria-controls": "workspace-view-" + area.id + "-" + view.id,
        type: "button",
        title: view.hint,
        onclick: () => select(view.id),
      },
      view.name,
    );
    tabs.append(button);
    buttons.set(view.id, button);
  }
  if (area.views.some((v) => v.secondary)) {
    const tools = el(
      "select",
      {
        class: "workspace-tools",
        "aria-label": "解读的其他工具",
        onchange: () => {
          if (tools.value) select(tools.value);
        },
      },
      el("option", { value: "" }, "其他工具"),
      ...area.views
        .filter((v) => v.secondary)
        .map((v) => el("option", { value: v.id }, v.name)),
    );
    tabs.append(tools);
  }
  if (area.views.length === 1) tabs.hidden = true;
  if (area.page && location.pathname !== area.page) {
    tabs.hidden = false;
    tabs.append(el("a", { href: area.page, target: "_blank", rel: "noopener", class: "workspace-page-link" }, "独立页面 ↗"));
  }
  function updateContext() {
    context.hidden = !area.contextual;
    context.textContent = state.currentPaper
      ? "当前论文 · " + state.currentPaper.title
      : "先从左侧选择论文，再查看粗读、图表或生成图解";
    context.title = context.textContent;
  }
  function select(id, payload) {
    const view = area.views.find((v) => v.id === id) || area.views[0];
    active = view.id;
    let cached = views.get(active);
    if (!cached) {
      const body = el("div", {
        class: "dvp-body workspace-view",
        role: "tabpanel",
        id: "workspace-view-" + area.id + "-" + active,
        "aria-label": view.name,
      });
      const status = el("div", { class: "dvp-status res-note", hidden: true });
      const sheet = el("div", { class: "workspace-sheet" }, status, body);
      cached = { body, sheet, def: getModule(active) };
      views.set(active, cached);
      content.append(sheet);
      try {
        cached.def?.mount(body, {
          initial,
          setStatus: (text) => {
            status.textContent = text || "";
            status.hidden = !text;
          },
        });
        if (!cached.def) throw new Error("该功能尚未就绪");
      } catch (error) {
        body.append(
          el("p", { class: "res-note" }, "打开失败：" + error.message),
        );
      }
    }
    for (const [key, entry] of views) entry.sheet.hidden = key !== active;
    for (const [key, button] of buttons) {
      button.classList.toggle("active", key === active);
      button.setAttribute("aria-selected", String(key === active));
      button.tabIndex = key === active ? 0 : -1;
    }
    const tools = tabs.querySelector("select");
    if (tools) tools.value = view.secondary ? active : "";
    updateContext();
    persistence.setItem("pipaper.workspace.view." + area.id, active);
    onChange?.(active);
    cached.def?.activate?.(payload);
    window.dispatchEvent(new Event("resize"));
  }
  window.addEventListener("pipaper:paper-changed", updateContext);
  return {
    element: root,
    select,
    init() {
      select(
        initial.activeView ||
          persistence.getItem("pipaper.workspace.view." + area.id),
      );
    },
    dispose() {
      window.removeEventListener("pipaper:paper-changed", updateContext);
      for (const { def } of views.values()) def?.unmount?.();
      views.clear();
    },
  };
}

export function diagramModule() {
  let current;
  return {
    id: "diagram",
    name: "图解",
    icon: "◈",
    mount(body, ctx) {
      const modes = [
        ["mindmap", "知识结构 · 思维导图"],
        ["flow", "方法步骤 · 流程图"],
        ["archify", "交互图解 · 架构、时序与数据流"],
      ];
      const selector = el(
        "select",
        { "aria-label": "图解表达方式" },
        ...modes.map(([value, name]) => el("option", { value }, name)),
      );
      const host = el("div", { class: "diagram-content" });
      const cache = new Map();
      const initial =
        ctx?.initial?.diagramKind ||
        persistence.getItem("pipaper.workspace.diagram") ||
        "mindmap";
      function select(id) {
        const mode = modes.some(([key]) => key === id) ? id : "mindmap";
        selector.value = mode;
        if (!cache.has(mode)) {
          const container = el("div", { class: "dvp-body diagram-view" });
          const def = getModule(mode);
          cache.set(mode, { container, def });
          host.append(container);
          def?.mount(container, ctx);
        }
        for (const [key, item] of cache) item.container.hidden = key !== mode;
        persistence.setItem("pipaper.workspace.diagram", mode);
        window.dispatchEvent(new Event("resize"));
      }
      selector.onchange = () => select(selector.value);
      body.append(
        el(
          "div",
          { class: "diagram-workspace" },
          el(
            "div",
            { class: "diagram-choice" },
            el("label", {}, "表达方式", selector),
          ),
          host,
        ),
      );
      current = { select, cache };
      select(initial);
    },
    activate(payload) {
      if (payload?.diagramKind) current?.select(payload.diagramKind);
    },
    unmount() {
      for (const item of current?.cache.values() || []) item.def?.unmount?.();
      current = null;
    },
  };
}
