import { persistence } from "./persistence.js";
import { $, el } from "./platform/dom.js";
import { THEMES, THEME_KEY as LS_KEY, applyTheme, initSharedTheme } from "./themeTokens.js";

// One-click theme switcher. Themes are pure CSS variable sets defined in
// theme.css under [data-theme="..."]; names参考成熟开源配色 (Nord / GitHub
// Primer / Gruvbox / Solarized) + 一套纸白阅读主题。

export function initTheme() {
  initSharedTheme();
  const btn = el("button", { id: "btn-theme", class: "icon-btn", title: "切换主题" }, "🎨");
  $("#btn-theme-slot").replaceChildren(btn);
  const menu = el("div", { id: "theme-menu" });
  document.body.append(menu);
  const render = () => {
    menu.replaceChildren(
      ...THEMES.map((t) =>
        el("div", {
          class: "theme-item" + ((persistence.getItem(LS_KEY) || "") === t.id ? " active" : ""),
          onclick: () => {
            applyTheme(t.id);
            persistence.setItem(LS_KEY, t.id);
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
