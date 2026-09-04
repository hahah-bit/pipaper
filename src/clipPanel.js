import { $, el, toast, addChip, askConfirm } from "./app.js";

// Clipboard manager: floating panel — collapsible + draggable + resizable.
// Captures copies/selections inside the app; entries expire server-side (2 days).

const LS_POS = "pipaper.clip.pos";
const LS_SIZE = "pipaper.clip.size";
const LS_OPEN = "pipaper.clip.open";

let entries = [];

export function initClipboard() {
  buildPanel();
  // capture app-side copies
  document.addEventListener("copy", () => {
    const t = window.getSelection()?.toString().trim();
    if (t && t.length > 1) push(t);
  });
  refresh();
}

function buildPanel() {
  if ($("#clip-panel")) return;
  const savedOpen = localStorage.getItem(LS_OPEN) === "1";
  const size = JSON.parse(localStorage.getItem(LS_SIZE) || '{"w":300,"h":360}');
  const pos = JSON.parse(localStorage.getItem(LS_POS) || "null") || { left: 12, bottom: 12 };

  const body = el("div", { class: "clip-body" });
  const list = el("div", { class: "clip-list" });
  body.append(
    el("div", { class: "clip-tools" },
      el("button", { class: "tool-btn", title: "清空全部", onclick: async () => {
        if (!(await askConfirm({ title: "清空剪贴板", message: "清空全部剪贴板历史？", okText: "清空", danger: true }))) return;
        await fetch("/api/clip/clear", { method: "POST" });
        refresh();
      } }, "清空"),
      el("button", { class: "tool-btn", title: "折叠", onclick: () => toggle(false) }, "▾")
    )
  );
  body.append(list);

  const head = el("div", { class: "clip-head" },
    el("span", { class: "clip-title" }, "📋 剪贴板"),
    el("span", { class: "clip-expand", title: "展开", onclick: () => toggle(true) }, "📋"),
  );
  head.addEventListener("click", () => { if (panel.classList.contains("mini")) toggle(true); });
  head.addEventListener("dblclick", () => toggle(false));

  const panel = el("div", { id: "clip-panel" }, head, body);

  const rz = el("div", { class: "clip-rz", title: "缩放" });
  panel.append(rz);
  document.body.append(panel);

  // position/size restore
  Object.assign(panel.style, {
    width: size.w + "px", height: size.h + "px",
    left: pos.left != null ? pos.left + "px" : "auto",
    right: pos.left != null ? "auto" : pos.right + "px",
    top: pos.top != null ? pos.top + "px" : "auto",
    bottom: pos.top != null ? "auto" : pos.bottom + "px",
  });
  toggle(savedOpen);

  // drag (head) + resize (rz)
  head.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx)) + "px";
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      savePos(panel);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  rz.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const move = (ev) => {
      panel.style.width = Math.max(220, ev.clientX - r.left) + "px";
      panel.style.height = Math.max(160, ev.clientY - r.top) + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      localStorage.setItem(LS_SIZE, JSON.stringify({ w: parseInt(panel.style.width), h: parseInt(panel.style.height) }));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  function toggle(open) {
    if (open) {
      try {
        const size = JSON.parse(localStorage.getItem(LS_SIZE) || '{"w":300,"h":360}');
        panel.style.width = size.w + "px";
        panel.style.height = size.h + "px";
      } catch {}
    }
    panel.classList.toggle("collapsed", !open);
    panel.classList.toggle("mini", !open);
    if (!open) {
      panel.style.width = "auto";
      panel.style.height = "auto";
      panel.style.left = "14px";
      panel.style.bottom = "14px";
      panel.style.top = "auto";
      panel.style.right = "auto";
    }
    localStorage.setItem(LS_OPEN, open ? "1" : "0");
  }
}

function savePos(panel) {
  const r = panel.getBoundingClientRect();
  localStorage.setItem(LS_POS, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
}

async function refresh() {
  try {
    const d = await fetch("/api/clip").then((r) => r.json());
    entries = d.entries || [];
  } catch {}
  renderList();
}

function renderList() {
  const list = document.querySelector(".clip-list");
  if (!list) return;
  list.replaceChildren();
  if (!entries.length) {
    list.append(el("div", { class: "res-note" }, "暂无内容 — 在应用里复制/划选文本会自动收集，2 天后自动清理。"));
    return;
  }
  const day = (at) => new Date(at).toLocaleString();
  for (const e of entries) {
    list.append(
      el("div", { class: "clip-entry" },
        el("div", { class: "clip-entry-text", title: "点击复制", onclick: () => {
          navigator.clipboard.writeText(e.text).then(() => toast("已复制"));
        } }, e.text.slice(0, 160)),
        el("div", { class: "clip-entry-meta" },
          el("span", {}, day(e.at)),
          el("span", { class: "clip-a", onclick: () => { addChip({ kind: "text", tag: "剪贴板", body: e.text }); toast("已加入对话"); } }, "＋对话"),
          el("span", { class: "clip-a", onclick: async () => { await fetch(`/api/clip/${e.id}`, { method: "DELETE" }); refresh(); } }, "✕"),
        )
      )
    );
  }
}

async function push(text) {
  try {
    await fetch("/api/clip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    refresh();
  } catch {}
}
