import { api, state, $, el, toast, updateZoteroFoot } from "./app.js";
import { reloadPapers } from "./sidebar.js";
import { openSetup } from "./setupPanel.js";

export function initSettings() {
  const backdrop = $("#modal-backdrop");
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-close").addEventListener("click", () => (backdrop.hidden = true));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.hidden = true;
  });
  $("#btn-settings-save").addEventListener("click", saveSettings);
  $("#btn-zotero-sync").addEventListener("click", syncZotero);
  $("#btn-open-setup").addEventListener("click", () => {
    backdrop.hidden = true;
    openSetup();
  });
}

export async function openSettings() {
  const backdrop = $("#modal-backdrop");
  backdrop.hidden = false;
  try {
    const [cfgRes, srcRes] = await Promise.all([api.getConfig(), api.searchSources()]);
    const { config, zotero } = cfgRes;
    $("#cfg-zotero-dir").value = config.zotero?.dataDir || "";
    $("#cfg-mineru-mode").value = config.parse?.mineru?.mode || "off";
    $("#cfg-mineru-token").value = config.parse?.mineru?.token || "";
    $("#cfg-mineru-cmd").value = config.parse?.mineru?.cmd || "mineru";
    $("#cfg-uns-mode").value = config.parse?.unstructured?.mode || "off";
    $("#cfg-uns-key").value = config.parse?.unstructured?.apiKey || "";
    $("#cfg-uns-url").value = config.parse?.unstructured?.url || "";
    // 检索源密钥：接口返回的是打码值；用户不改动则原样回传（服务端还原）
    const s2 = (srcRes.sources || []).find((s) => s.id === "semanticscholar");
    const scholar = (srcRes.sources || []).find((s) => s.type === "scholar-mirror");
    $("#cfg-s2-key").value = s2?.apiKey || "";
    $("#cfg-scholar-cookie").value = scholar?.cookie || "";
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
    await saveSearchKeys();
    msg.textContent = "已保存 ✓";
    msg.className = "ok";
    setTimeout(() => (msg.textContent = ""), 2500);
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "err";
  }
}

// 检索源密钥：仅当用户输入了非打码的新值才写回；打码值/空值表示保持不变
async function saveSearchKeys() {
  const s2v = $("#cfg-s2-key").value.trim();
  const ck = $("#cfg-scholar-cookie").value.trim();
  if ((!s2v || s2v.includes("***")) && (!ck || ck.includes("***"))) return;
  const src = await api.searchSources();
  const list = (src.sources || []).map((s) => ({ ...s }));
  if (s2v && !s2v.includes("***")) {
    const s2 = list.find((s) => s.id === "semanticscholar");
    if (s2) s2.apiKey = s2v;
  }
  if (ck && !ck.includes("***")) {
    const scholar = list.find((s) => s.type === "scholar-mirror");
    if (scholar) scholar.cookie = ck;
  }
  await api.saveSearchSources(list);
  $("#cfg-s2-key").value = "";
  $("#cfg-scholar-cookie").value = "";
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
