import { $ } from "./app.js";

// Draggable panes: two gutters adjust --side-w / --chat-w; persisted in localStorage.
export function initPanes() {
  const root = document.getElementById("app");
  if (!root) return;

  const cur = { sideW: 264, chatW: 560 };
  // restore
  try {
    const saved = JSON.parse(localStorage.getItem("pipaper.panes") || "{}");
    if (saved.sideW) {
      cur.sideW = saved.sideW;
      root.style.setProperty("--side-w", saved.sideW + "px");
    }
    if (saved.chatW) {
      cur.chatW = saved.chatW;
      root.style.setProperty("--chat-w", "min(" + saved.chatW + "px, 60vw)");
    }
  } catch {}

  function persist() {
    try {
      localStorage.setItem("pipaper.panes", JSON.stringify({ sideW: cur.sideW, chatW: cur.chatW }));
    } catch {}
    window.dispatchEvent(new Event("resize"));
  }

  function drag(gutterId, apply) {
    const g = $(gutterId);
    g.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (ev) => apply(ev.clientX);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        persist();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    g.addEventListener("dblclick", () => {
      cur.sideW = 264;
      cur.chatW = 560;
      root.style.setProperty("--side-w", "264px");
      root.style.setProperty("--chat-w", "min(560px, 44vw)");
      persist();
    });
  }

  drag("#gutter-1", (x) => {
    const w = Math.max(180, Math.min(520, x));
    cur.sideW = w;
    root.style.setProperty("--side-w", w + "px");
  });
  drag("#gutter-2", (x) => {
    const w = Math.max(320, Math.min(window.innerWidth - cur.sideW - 420, x - cur.sideW));
    cur.chatW = w;
    root.style.setProperty("--chat-w", "min(" + w + "px, 60vw)");
  });
}
