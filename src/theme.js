import { $, el } from "./app.js";

// One-click theme switcher. Themes are pure CSS variable sets defined in
// style.css under [data-theme="..."]; names参考成熟开源配色 (Nord / GitHub
// Primer / Gruvbox / Solarized) + 一套纸白阅读主题。

const THEMES = [
  { id: "", name: "默认 · 午夜学术" },
  { id: "paper", name: "纸白 · 长文阅读" },
  { id: "nord", name: "Nord 北欧" },
  { id: "ghdark", name: "GitHub Dark" },
  { id: "gruvbox", name: "Gruvbox 暖棕" },
  { id: "solar-light", name: "Solarized 浅色" },
];

const LS_KEY = "pipaper.theme";

export function initTheme() {
  const saved = localStorage.getItem(LS_KEY) || "";
  applyTheme(saved);
  const btn = el("button", { id: "btn-theme", class: "icon-btn", title: "切换主题" }, "🎨");
  $("#btn-theme-slot").replaceChildren(btn);
  const menu = el("div", { id: "theme-menu" });
  document.body.append(menu);
  const render = () => {
    menu.replaceChildren(
      ...THEMES.map((t) =>
        el("div", {
          class: "theme-item" + ((localStorage.getItem(LS_KEY) || "") === t.id ? " active" : ""),
          onclick: () => {
            applyTheme(t.id);
            localStorage.setItem(LS_KEY, t.id);
            render();
          },
        }, t.name)
      )
    );
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, r.right - 190) + "px";
    menu.classList.toggle("open");
    render();
  });
  document.addEventListener("click", () => menu.classList.remove("open"));
  menu.addEventListener("click", (e) => e.stopPropagation());
}

function applyTheme(id) {
  if (id) document.documentElement.dataset.theme = id;
  else delete document.documentElement.dataset.theme;
}
