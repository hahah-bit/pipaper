// ---------------- tiny dom helpers ----------------
export const $ = (sel) => document.querySelector(sel);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function toast(msg, isErr = false) {
  let wrap = $(".toast-wrap");
  if (!wrap) {
    wrap = el("div", { class: "toast-wrap" });
    document.body.append(wrap);
  }
  const t = el("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  wrap.append(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3200);
}

// ---------------- in-app prompt/confirm（内嵌浏览器会吞 window.prompt/confirm，统一用 <dialog>） ----------------
function askDialog({ title, message, inputInitial, inputPlaceholder, okText, danger }) {
  return new Promise((resolve) => {
    const input = inputInitial !== undefined
      ? el("input", { class: "dlg-input", type: "text", placeholder: inputPlaceholder || "", value: inputInitial || "" })
      : null;
    const dlg = el("dialog", { class: "native-dialog ask-dialog" },
      el("header", {}, el("strong", {}, title)),
      el("div", { class: "native-dialog-body" },
        message ? el("p", { class: "dlg-message" }, message) : null,
        input),
      el("div", { class: "dlg-btnrow" },
        el("button", { class: "tool-btn", onclick: () => done(null) }, "取消"),
        el("button", { class: "tool-btn primary" + (danger ? " danger" : ""), onclick: () => done(input ? input.value : true) }, okText || "确定")),
    );
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(input.value); } });
    document.body.append(dlg);
    dlg.showModal();
    if (input) { input.focus(); input.select(); }
  });
}

export function askText({ title, message, initial, placeholder, okText } = {}) {
  return askDialog({ title, message, inputInitial: initial ?? "", inputPlaceholder: placeholder, okText });
}

export function askConfirm({ title, message, okText, danger = false } = {}) {
  return askDialog({ title, message, okText, danger }).then((v) => v === true);
}
