import { persistence } from "./persistence.js";

export const THEMES = [
  { id: "", name: "默认 · 午夜学术" },
  { id: "paper", name: "纸白 · 长文阅读" },
  { id: "nord", name: "Nord 北欧" },
  { id: "ghdark", name: "GitHub Dark" },
  { id: "gruvbox", name: "Gruvbox 暖棕" },
  { id: "solar-light", name: "Solarized 浅色" },
];
export const THEME_KEY = "pipaper.theme";
export function applyTheme(id) {
  if (THEMES.some(theme => theme.id === id) && id) document.documentElement.dataset.theme = id;
  else delete document.documentElement.dataset.theme;
}
let listening = false;
export function initSharedTheme() {
  const restore = () => applyTheme(persistence.getItem(THEME_KEY) || "");
  restore();
  if (!listening) {
    listening = true;
    window.addEventListener("storage", event => { if (!event.key || event.key === THEME_KEY) restore(); });
    window.addEventListener("focus", restore);
  }
}
initSharedTheme();
