import { $ } from "./app.js";

// 工作区的模块注册表。每个模块 = { id, name, icon, mount(body, ctx), unmount() }。
// mount 把模块内容装进某个栏位；unmount 负责还原（reader/chat 是 DOM 搬迁，搬回原位即恢复主界面）。
// 模块管理能力与挂载生命周期；导航归属在 workspaceNavigation.js 中按实际工作流程声明。

const registry = [];

export function registerModule(def) {
  if (!def?.id || getModule(def.id)) return;
  registry.push(def);
}
export const listModules = () => [...registry];
export function getModule(id) {
  return registry.find((m) => m.id === id) || null;
}

// DOM 搬迁型模块：把现有面板节点移入工作区（SSE 流、pdf canvas、事件监听全部存活），
// unmount 时原样放回父节点原位置，并恢复被临时摘掉的折叠/悬浮类。
// 注意：dockview 关闭面板时会删除其内容 DOM 树——所以 mount 时在原位留占位符、
// unmount 用闭包里的节点引用按占位换回，绝不依赖 document 查询（detached 节点查不到）。
export function reparentModule({ id, name, icon, selector, keepClasses = [] }) {
  let origin = null;
  return {
    id, name, icon,
    mount(container) {
      const node = $(selector);
      if (!node) return;
      const placeholder = document.createElement("div");
      node.parentNode?.insertBefore(placeholder, node);
      origin = {
        node,
        placeholder,
        present: keepClasses.filter((c) => node.classList.contains(c)),
        hidden: node.hidden, // #stab-video / #artifacts-view 初始带 hidden（旧版 tab 逻辑遗留）
      };
      for (const c of keepClasses) node.classList.remove(c);
      for (const prop of ["flex", "width", "min-width"]) node.style.removeProperty(prop);
      node.hidden = false;
      container.append(node);
    },
    unmount() {
      if (!origin) return;
      const { node, placeholder, present, hidden } = origin;
      origin = null;
      if (!node) return;
      try { placeholder.replaceWith(node); }
      catch { /* 占位符已不在文档：节点直接挂回占位符原父容器 */ placeholder.parentNode?.append(node); }
      for (const c of present) node.classList.add(c);
      node.hidden = !!hidden;
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
