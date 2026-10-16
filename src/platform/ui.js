import { renderMd } from "./markdown.js";

export function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "class") element.className = value;
    else if (key === "value") element.value = value;
    else if (key === "style") Object.assign(element.style, value);
    else if (value != null && value !== false) element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) element.append(child.nodeType ? child : document.createTextNode(child));
  return element;
}
export { requestJson as request } from "./http.js";
export function markdown(text, host = node("div", { class: "md-body" })) {
  renderMd(text, host);
  host.querySelectorAll('a[href^="http"]').forEach(a => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  return host;
}
export function notify(message, error = false) {
  const box = node("div", { class: "study-toast" + (error ? " error" : ""), role: "status" }, message);
  document.body.append(box); setTimeout(() => box.remove(), error ? 9000 : 4000);
}
export function button(label, action, className = "tool-btn") {
  return node("button", { type: "button", class: className, onclick: async event => {
    const btn = event.currentTarget;
    try { btn.disabled = true; await action(event); } catch (e) { notify(e.message, true); } finally { btn.disabled = false; }
  } }, label);
}
export function dialog(title, content, actions = []) {
  const dlg = node("dialog", { class: "study-dialog" });
  dlg.append(node("header", {}, node("h2", {}, title), button("关闭", () => dlg.close())), content, node("footer", {}, actions));
  dlg.addEventListener("close", () => dlg.remove(), { once: true });
  document.body.append(dlg); dlg.showModal(); return dlg;
}
export function confirmDelete(title, message) {
  return new Promise(resolve => {
    let accepted = false;
    const dlg = dialog(title, node("p", {}, message), [button("取消", () => dlg.close()), button("彻底删除任务", () => { accepted = true; dlg.close(); }, "tool-btn danger")]);
    dlg.addEventListener("close", () => resolve(accepted), { once: true });
  });
}
