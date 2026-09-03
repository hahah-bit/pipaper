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

  // gutter-3: right panel width / collapse toggle
  const rightbar = document.getElementById("rightbar");
  const closeBtn = document.getElementById("btn-rightbar-close");
  const setCollapsed = (c) => {
    rightbar.classList.toggle("collapsed", c);
    document.getElementById("btn-rightbar-toggle")?.classList.toggle("active", !c);
    try { localStorage.setItem("pipaper.rightCollapsed", c ? "1" : "0"); } catch {}
    window.dispatchEvent(new Event("resize"));
  };
  document.getElementById("btn-rightbar-toggle")?.addEventListener("click", () => {
    setCollapsed(rightbar.classList.contains("collapsed"));
  });
  closeBtn?.addEventListener("click", () => setCollapsed(true));
  try {
    if (localStorage.getItem("pipaper.rightCollapsed") === "1") {
      rightbar.classList.add("collapsed");
      document.getElementById("btn-rightbar-toggle")?.classList.remove("active");
    }
  } catch {}
  $("#gutter-3").addEventListener("dblclick", () => setCollapsed(false));
  const g3 = $("#gutter-3");
  g3.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const w = Math.max(280, Math.min(560, window.innerWidth - ev.clientX));
      root.style.setProperty("--right-w", w + "px");
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        const w = parseInt(getComputedStyle(root).getPropertyValue("--right-w"));
        localStorage.setItem("pipaper.rightw", String(w));
      } catch {}
      window.dispatchEvent(new Event("resize"));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  try {
    const rw = localStorage.getItem("pipaper.rightw");
    if (rw) root.style.setProperty("--right-w", rw + "px");
  } catch {}
}
