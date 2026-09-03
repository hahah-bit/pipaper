import { api, state, $, el, toast, updateZoteroFoot } from "./app.js";
import { reloadPapers } from "./sidebar.js";

export function initSettings() {
  const backdrop = $("#modal-backdrop");
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-close").addEventListener("click", () => (backdrop.hidden = true));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.hidden = true;
  });
  $("#btn-settings-save").addEventListener("click", saveSettings);
  $("#btn-zotero-sync").addEventListener("click", syncZotero);
}

async function openSettings() {
  $("#modal-backdrop").hidden = false;
  try {
    const { config, zotero } = await api.getConfig();
    $("#cfg-zotero-dir").value = config.zotero?.dataDir || "";
    $("#cfg-mineru-mode").value = config.parse?.mineru?.mode || "off";
    $("#cfg-mineru-token").value = config.parse?.mineru?.token || "";
    $("#cfg-mineru-cmd").value = config.parse?.mineru?.cmd || "mineru";
    $("#cfg-uns-mode").value = config.parse?.unstructured?.mode || "off";
    $("#cfg-uns-key").value = config.parse?.unstructured?.apiKey || "";
    $("#cfg-uns-url").value = config.parse?.unstructured?.url || "";
    $("#zotero-sync-status").textContent = zotero?.syncedAt
      ? `上次同步 ${new Date(zotero.syncedAt).toLocaleString()}（${zotero.papers} 篇）`
      : "尚未同步";
  } catch (e) {
    toast("读取配置失败: " + e.message, true);
  }
}

async function saveSettings() {
  const msg = $("#settings-msg");
  try {
    await api.saveConfig({
      zotero: { dataDir: $("#cfg-zotero-dir").value.trim() },
      parse: {
        mineru: {
          mode: $("#cfg-mineru-mode").value,
          token: $("#cfg-mineru-token").value.trim(),
          cmd: $("#cfg-mineru-cmd").value.trim() || "mineru",
        },
        unstructured: {
          mode: $("#cfg-uns-mode").value,
          apiKey: $("#cfg-uns-key").value.trim(),
          url: $("#cfg-uns-url").value.trim() || "https://api.unstructured.io",
        },
      },
    });
    msg.textContent = "已保存 ✓";
    msg.className = "ok";
    setTimeout(() => (msg.textContent = ""), 2500);
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "err";
  }
}

async function syncZotero() {
  const msg = $("#zotero-sync-status");
  msg.textContent = "同步中…（复制 zotero.sqlite 快照并读取）";
  try {
    // save dataDir first so sync uses it
    await api.saveConfig({ zotero: { dataDir: $("#cfg-zotero-dir").value.trim() } });
    await reloadPapers(true);
    msg.textContent = `同步完成 ✓ ${state.zotero?.papers || 0} 篇`;
    toast("Zotero 库已同步");
  } catch (e) {
    msg.textContent = "同步失败: " + e.message;
    toast("Zotero 同步失败: " + e.message, true);
  }
}
