import { $ } from "./app.js";

// 沉浸式工作台的模块注册表。每个模块 = { id, name, icon, mount(body, ctx), unmount() }。
// mount 把模块内容装进某个栏位；unmount 负责还原（reader/chat 是 DOM 搬迁，搬回原位即恢复主界面）。
// 之后新增功能只需 registerModule(...)，组合选择器与栏位切换菜单自动收录。

const registry = [];

export function registerModule(def) {
  if (!def?.id || getModule(def.id)) return;
  registry.push(def);
}
export const listModules = () => [...registry];
export function getModule(id) {
  return registry.find((m) => m.id === id) || null;
}

// DOM 搬迁型模块：把现有面板节点移入沉浸栏位（SSE 流、pdf canvas、事件监听全部存活），
// unmount 时原样放回父节点原位置，并恢复进沉浸前被临时摘掉的折叠/悬浮类。
function reparentModule({ id, name, icon, selector, keepClasses = [] }) {
  let origin = null;
  return {
    id, name, icon,
    mount(container) {
      const node = $(selector);
      if (!node) return;
      origin = {
        parent: node.parentNode,
        next: node.nextSibling,
        present: keepClasses.filter((c) => node.classList.contains(c)),
      };
      for (const c of keepClasses) node.classList.remove(c);
      for (const prop of ["flex", "width", "min-width"]) node.style.removeProperty(prop);
      container.append(node);
    },
    unmount() {
      const node = $(selector);
      if (!node || !origin?.parent) return;
      if (origin.next?.parentNode === origin.parent) origin.parent.insertBefore(node, origin.next);
      else origin.parent.append(node);
      for (const c of origin.present) node.classList.add(c);
      origin = null;
      window.dispatchEvent(new Event("resize")); // 让 panes.js 按保存的状态重新施加布局
    },
  };
}

export function registerBuiltinModules() {
  registerModule(reparentModule({
    id: "reader", name: "论文阅读器", icon: "📖", selector: "#reader-pane",
    keepClasses: ["is-collapsed"],
  }));
  registerModule(reparentModule({
    id: "chat", name: "对话", icon: "💬", selector: "#chat-pane",
    keepClasses: ["is-floating", "is-collapsed"],
  }));
}
