import { $ } from "./app.js";

// Draggable panes plus a persisted presentation layer. The panels keep their
// existing DOM and behavior; these controls only change their layout.
export function initPanes() {
  const root = document.getElementById("app");
  if (!root) return;

  const cur = { sideW: 264, chatW: 560, rightW: 480 };
  const paneState = { sidebar: false, chat: false, reader: false, right: false, floating: false };

  try {
    const saved = JSON.parse(localStorage.getItem("pipaper.panes") || "{}");
    if (Number.isFinite(saved.sideW)) cur.sideW = saved.sideW;
    if (Number.isFinite(saved.chatW)) cur.chatW = saved.chatW;
    if (Number.isFinite(saved.rightW)) cur.rightW = saved.rightW;
    const savedState = JSON.parse(localStorage.getItem("pipaper.paneState") || "{}");
    for (const key of Object.keys(paneState)) if (typeof savedState[key] === "boolean") paneState[key] = savedState[key];
    if (localStorage.getItem("pipaper.rightCollapsed") === "1") paneState.right = true;
  } catch {}

  const applyWidths = () => {
    root.style.setProperty("--side-w", Math.max(180, Math.min(520, cur.sideW)) + "px");
    root.style.setProperty("--chat-w", "min(" + Math.max(320, cur.chatW) + "px, 60vw)");
    root.style.setProperty("--right-w", Math.max(280, Math.min(640, cur.rightW)) + "px");
  };
  applyWidths();

  function persist() {
    try {
      localStorage.setItem("pipaper.panes", JSON.stringify(cur));
      localStorage.setItem("pipaper.paneState", JSON.stringify(paneState));
      localStorage.setItem("pipaper.rightCollapsed", paneState.right ? "1" : "0");
    } catch {}
    window.dispatchEvent(new Event("resize"));
  }

  function drag(gutterId, apply, reset) {
    const g = $(gutterId);
    if (!g) return;
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
    g.addEventListener("dblclick", () => { reset?.(); persist(); });
  }

  drag("#gutter-1", (x) => {
    cur.sideW = Math.max(180, Math.min(520, x));
    root.style.setProperty("--side-w", cur.sideW + "px");
  }, () => {
    cur.sideW = 264;
    root.style.setProperty("--side-w", "264px");
  });
  drag("#gutter-2", (x) => {
    cur.chatW = Math.max(320, Math.min(window.innerWidth - cur.sideW - 420, x - cur.sideW));
    root.style.setProperty("--chat-w", "min(" + cur.chatW + "px, 60vw)");
  }, () => {
    cur.chatW = 560;
    root.style.setProperty("--chat-w", "min(560px, 60vw)");
  });

  const rightbar = $("#rightbar");
  const rightToggle = $("#btn-rightbar-toggle");
  const closeRight = $("#btn-rightbar-close");
  const sidebar = $("#sidebar");
  const chat = $("#chat-pane");
  const reader = $("#reader-pane");
  const toggleButtons = {
    sidebar: $("#btn-sidebar-toggle"),
    chat: $("#btn-chat-toggle"),
    reader: $("#btn-reader-toggle"),
  };
  const gutters = {
    sidebar: $("#gutter-1"),
    chat: $("#gutter-2"),
    reader: $("#gutter-3"),
    right: $("#gutter-3"),
  };
  const paneElements = { sidebar, chat, reader, right: rightbar };

  const paneName = (key) => key === "sidebar" ? "文献库" : key === "chat" ? "对话" : key === "reader" ? "阅读器" : "检索/视频";
  const setButton = (key, collapsed) => {
    const button = toggleButtons[key];
    if (!button) return;
    const left = key === "sidebar";
    button.textContent = collapsed ? (left ? "›" : "‹") : (left ? "‹" : "›");
    button.title = collapsed ? `展开${paneName(key)}` : `折叠${paneName(key)}`;
    button.setAttribute("aria-expanded", String(!collapsed));
  };

  function syncProportionalWidths() {
    const keys = ["sidebar", "chat", "reader", "right"];
    const anyCollapsed = keys.some((key) => paneState[key]);
    for (const key of keys) {
      const element = paneElements[key];
      if (!element) continue;
      if (!anyCollapsed) {
        element.style.removeProperty("flex");
        element.style.removeProperty("width");
        element.style.removeProperty("min-width");
      }
    }
    if (!anyCollapsed) return;
    const visible = keys.filter((key) => !paneState[key] && !(key === "chat" && paneState.floating));
    const sideWidth = Math.max(180, Math.min(520, cur.sideW));
    const proportional = visible.filter((key) => key !== "sidebar");
    const width = proportional.length
      ? (paneState.sidebar ? root.clientWidth : Math.max(0, root.clientWidth - sideWidth)) / proportional.length
      : 0;
    for (const key of keys) {
      const element = paneElements[key];
      if (!element) continue;
      if (paneState[key]) {
        element.style.setProperty("flex", "0 0 0px", "important");
        element.style.setProperty("width", "0px", "important");
        element.style.setProperty("min-width", "0px", "important");
      } else if (key === "chat" && paneState.floating) {
        element.style.removeProperty("flex");
        element.style.removeProperty("width");
        element.style.removeProperty("min-width");
      } else if (key === "sidebar" && !paneState.sidebar) {
        element.style.setProperty("flex", `0 0 ${sideWidth}px`, "important");
        element.style.setProperty("width", `${sideWidth}px`, "important");
        element.style.setProperty("min-width", `${sideWidth}px`, "important");
      } else if (key !== "chat" || !paneState.floating) {
        element.style.setProperty("flex", `0 0 ${width}px`, "important");
        element.style.setProperty("width", `${width}px`, "important");
        element.style.setProperty("min-width", "0px", "important");
      }
    }
  }

  function updateCollapsedLayout() {
    const anyCollapsed = ["sidebar", "chat", "reader", "right"].some((key) => paneState[key]);
    root.classList.toggle("has-collapsed", anyCollapsed);
    root.classList.toggle("pane-all-collapsed", ["sidebar", "chat", "reader", "right"].every((key) => paneState[key]));
    for (const key of ["sidebar", "chat", "reader", "right"]) {
      root.classList.toggle(`pane-${key}-collapsed`, !!paneState[key]);
    }
    gutters.sidebar?.classList.toggle("has-hotspot", !!paneState.sidebar);
    gutters.chat?.classList.toggle("has-hotspot", !!paneState.chat);
    gutters.reader?.classList.toggle("has-hotspot", !!(paneState.reader || paneState.right));
    syncProportionalWidths();
  }

  function setCollapsed(key, collapsed, save = true) {
    paneState[key] = !!collapsed;
    if (key === "sidebar") sidebar?.classList.toggle("is-collapsed", paneState[key]);
    if (key === "chat") chat?.classList.toggle("is-collapsed", paneState[key]);
    if (key === "reader") reader?.classList.toggle("is-collapsed", paneState[key]);
    if (key === "right") {
      rightbar?.classList.toggle("collapsed", paneState[key]);
      rightToggle?.classList.toggle("active", !paneState[key]);
    }
    setButton(key, paneState[key]);
    updateCollapsedLayout();
    if (save) persist();
  }

  function setFloating(on, save = true) {
    paneState.floating = !!on;
    chat?.classList.toggle("is-floating", paneState.floating);
    const button = $("#btn-chat-float");
    button?.classList.toggle("active", paneState.floating);
    button?.setAttribute("aria-pressed", String(paneState.floating));
    button?.setAttribute("title", paneState.floating ? "还原对话布局" : "悬浮对话");
    if (paneState.floating && paneState.chat) {
      paneState.chat = false;
      chat?.classList.remove("is-collapsed");
      setButton("chat", false);
    }
    updateCollapsedLayout();
    if (save) persist();
  }

  for (const [key, button] of Object.entries(toggleButtons)) {
    button?.addEventListener("click", () => {
      if (key === "chat" && paneState.floating) setFloating(false);
      setCollapsed(key, !paneState[key]);
    });
  }
  $("#btn-chat-float")?.addEventListener("click", () => setFloating(!paneState.floating));
  rightToggle?.addEventListener("click", () => setCollapsed("right", !paneState.right));
  closeRight?.addEventListener("click", () => setCollapsed("right", true));
  document.querySelectorAll(".rt-tab").forEach((tab) => tab.addEventListener("click", () => setCollapsed("right", false)));
  document.querySelectorAll(".pane-reopen").forEach((button) => {
    button.addEventListener("mousedown", (e) => e.stopPropagation());
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = button.dataset.pane;
      if (key) setCollapsed(key, false);
    });
  });

  // gutter-3 adjusts panel 4 and double-clicking it reopens that panel.
  const g3 = gutters.reader;
  g3?.addEventListener("dblclick", () => setCollapsed("right", false));
  g3?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      cur.rightW = Math.max(280, Math.min(640, window.innerWidth - ev.clientX));
      root.style.setProperty("--right-w", cur.rightW + "px");
    };
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

  window.addEventListener("resize", syncProportionalWidths);

  setCollapsed("sidebar", paneState.sidebar, false);
  setCollapsed("chat", paneState.chat, false);
  setCollapsed("reader", paneState.reader, false);
  setCollapsed("right", paneState.right, false);
  setFloating(paneState.floating, false);
}
