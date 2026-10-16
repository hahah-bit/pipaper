import { state } from "../../shell/state.js";
import { $ } from "../../platform/dom.js";
export function updateZoteroFoot() {
  const foot = $("#side-foot");
  foot.replaceChildren();
  const z = state.zotero;
  if (z?.syncedAt) {
    foot.append(`Zotero 已同步 ${new Date(z.syncedAt).toLocaleString()} · ${z.papers} 篇`);
  } else {
    foot.append("Zotero 未同步 — 点击 ⚙ 设置数据目录");
  }
}
