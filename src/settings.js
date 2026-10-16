import { persistence } from "./persistence.js";
import { api } from "./platform/api.js";
import { state } from "./shell/state.js";
import { $, el, toast } from "./platform/dom.js";
import { updateZoteroFoot } from "./features/library/status.js";
let settingsBindings;

const loadedSections = new Set();
let settingsReturnFocus;
function settingsVisibility() {
  window.dispatchEvent(new Event("pipaper:settings-visibility"));
}
export function closeSettings() {
  $("#modal-backdrop").hidden = true;
  $("#app").inert = false;
  settingsReturnFocus?.focus?.();
  settingsVisibility();
}
async function selectSection(section) {
  const selected = [
    "general",
    "knowledge",
    "resources",
    "diagnostics",
  ].includes(section)
    ? section
    : "general";
  for (const button of $("#settings-tabs").querySelectorAll("button")) {
    const active = button.dataset.section === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    button.setAttribute("aria-controls", "settings-" + button.dataset.section);
  }
  for (const key of ["general", "knowledge", "resources", "diagnostics"])
    $("#settings-" + key).hidden = key !== selected;
  $("#settings-general-foot").hidden = selected !== "general";
  if (selected === "diagnostics") await settingsBindings.refreshDiagnostics();
  if (!loadedSections.has(selected)) {
    if (selected === "resources") await settingsBindings.refreshResources();
    if (selected === "knowledge") await loadKnowledgeSettings();
    loadedSections.add(selected);
  }
}

export function initSettings(bindings) {
  settingsBindings = bindings;
  const backdrop = $("#modal-backdrop");
  $("#btn-settings-close").addEventListener("click", closeSettings);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeSettings();
  });
  $("#btn-settings-save").addEventListener("click", saveSettings);
  $("#btn-zotero-sync").addEventListener("click", syncZotero);
  $("#cfg-font-size").addEventListener("change", () =>
    applyFontSize($("#cfg-font-size").value, true),
  );
  $("#btn-open-setup").addEventListener("click", () =>
    selectSection("diagnostics"),
  );
  for (const button of $("#settings-tabs").querySelectorAll("button"))
    button.onclick = () =>
      selectSection(button.dataset.section).catch((e) =>
        toast(e.message, true),
      );
  // Move the actual controls once; all existing handlers, inputs and scope state survive.
  $("#settings-resources").append(
    el("div", { class: "settings-scope" }, "技能与扩展 ", $("#res-proj-name")),
    $("#resources-backdrop .res-tabs"),
    $("#res-body"),
  );
  $("#settings-diagnostics").append(
    $("#setup-modal .modal-body"),
    $("#setup-modal .modal-foot"),
  );
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !backdrop.hidden &&
      !document.querySelector("dialog[open]")
    )
      closeSettings();
  });
}

// 界面字号四档：立即生效并持久化（boot 早期也会应用一次，见 app.js）
export function applyFontSize(size, persist = false) {
  const valid = ["compact", "cozy", "large", "xlarge"];
  const value = valid.includes(size) ? size : "cozy";
  document.documentElement.dataset.fs = value;
  if (persist) {
    try {
      persistence.setItem("pipaper.fontSize", value);
    } catch {}
    toast(
      "界面字号：" +
        { compact: "紧凑", cozy: "标准", large: "大", xlarge: "特大" }[value],
    );
  }
}

export async function openSettings(section = "general") {
  const backdrop = $("#modal-backdrop");
  const opening = backdrop.hidden;
  if (opening) settingsReturnFocus = document.activeElement;
  backdrop.hidden = false;
  $("#app").inert = true;
  settingsVisibility();
  const selecting = selectSection(section).catch((e) => toast(e.message, true));
  if (!opening) return selecting;
  $("#settings-tabs .active").focus();
  $("#cfg-font-size").value = (() => {
    try {
      return persistence.getItem("pipaper.fontSize") || "cozy";
    } catch {
      return "cozy";
    }
  })();
  try {
    const [cfgRes, srcRes] = await Promise.all([
      api.getConfig(),
      api.searchSources(),
    ]);
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
    const scholar = (srcRes.sources || []).find(
      (s) => s.type === "scholar-mirror",
    );
    $("#cfg-s2-key").value = s2?.apiKey || "";
    $("#cfg-scholar-cookie").value = scholar?.cookie || "";
    $("#zotero-sync-status").textContent = zotero?.syncedAt
      ? `上次同步 ${new Date(zotero.syncedAt).toLocaleString()}（${zotero.papers} 篇）`
      : "尚未同步";
  } catch (e) {
    toast("读取配置失败: " + e.message, true);
  }
  await selecting;
}

async function loadKnowledgeSettings() {
  const container = $("#settings-knowledge");
  const response = await fetch("/api/rag/config"),
    data = await response.json();
  if (!response.ok) throw new Error(data.error);
  const [application, available] = await Promise.all([api.getConfig(), api.models()]);
  const translationModel = application.config.translate.model;
  const translationChoice = el("select", { "aria-label": "选区翻译模型" });
  const choices = available.models.map(model => ({ provider: model.provider, id: model.id }));
  if (!choices.some(model => model.provider === translationModel.provider && model.id === translationModel.id)) choices.unshift(translationModel);
  translationChoice.append(...choices.map(model => el("option", { value: JSON.stringify(model) }, `${model.id} · ${model.provider}`)));
  translationChoice.value = JSON.stringify({ provider: translationModel.provider, id: translationModel.id });
  const config = data.config,
    fields = {};
  const field = (label, key, value, type = "text") => {
    const input = el("input", { type, "aria-label": label });
    input.value = value;
    fields[key] = input;
    return el("label", {}, label, input);
  };
  const expansion = el("input", {
    type: "checkbox",
    checked: config.expansion,
  });
  const rerankEnabled = el("input", {
    type: "checkbox",
    checked: config.rerank.enabled,
  });
  const selfRagEnabled = el("input", {
    type: "checkbox",
    checked: config.retrieval.selfRag,
  });
  const advanced = el("textarea", {
    rows: 9,
    "aria-label": "知识库高级配置",
    spellcheck: "false",
  });
  advanced.value = JSON.stringify(
    {
      vision: config.vision,
      expansionModel: config.expansionModel,
      chunk: config.chunk,
      retrieval: config.retrieval,
    },
    null,
    2,
  );
  const status = el("p", { class: "res-note", role: "status" });
  const save = el(
    "button",
    {
      class: "tool-btn primary",
      onclick: async () => {
        save.disabled = true;
        try {
          const next = {
            ...config,
            ...JSON.parse(advanced.value),
            expansion: expansion.checked,
            retrieval: {
              ...config.retrieval,
              ...JSON.parse(advanced.value).retrieval,
              selfRag: selfRagEnabled.checked,
            },
            rerank: {
              ...config.rerank,
              enabled: rerankEnabled.checked,
              model: fields.rerankModel.value.trim(),
              url: fields.rerankUrl.value.trim(),
            },
            embedding: {
              ...config.embedding,
              url: fields.url.value.trim(),
              model: fields.model.value.trim(),
              dimension: Number(fields.dimension.value),
            },
            milvus: {
              ...config.milvus,
              address: fields.address.value.trim(),
              collectionPrefix: fields.prefix.value.trim(),
            },
          };
          const result = await fetch("/api/rag/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next),
          });
          const saved = await result.json();
          if (!result.ok) throw new Error(saved.error);
          await api.saveConfig({ translate: { model: JSON.parse(translationChoice.value) } });
          status.textContent =
            "已保存。检索设置立即用于下一次查询；解析与索引配置变化将标记受影响的证据。";
        } catch (error) {
          status.textContent = "保存失败：" + error.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    "保存知识库设置",
  );
  container.replaceChildren(
    el("h4", {}, "Embedding"),
    el(
      "p",
      { class: "res-note" },
      data.embeddingConfigured
        ? "服务端凭据已配置"
        : "服务端尚未配置 Embedding 凭据",
    ),
    field("模型", "model", config.embedding.model),
    field("向量维度", "dimension", config.embedding.dimension, "number"),
    field("接口地址", "url", config.embedding.url),
    el("h4", {}, "向量库"),
    field("Milvus 地址", "address", config.milvus.address),
    field("集合前缀", "prefix", config.milvus.collectionPrefix),
    el("label", { class: "settings-check" }, expansion, "启用背景与问题扩写"),
    el("h4", {}, "检索与重排"),
    el(
      "label",
      { class: "settings-check" },
      selfRagEnabled,
      "默认启用 Self-RAG 分析",
    ),
    el("label", { class: "settings-check" }, rerankEnabled, "启用百炼重排"),
    field("重排模型", "rerankModel", config.rerank.model),
    field(
      "重排地址（留空沿用百炼地域与业务空间）",
      "rerankUrl",
      config.rerank.url,
    ),
    el(
      "p",
      { class: "res-note" },
      "重排使用服务端百炼凭据。时间与引用分析通过 Pi 模型运行时执行。",
    ),
    el(
      "details",
      {},
      el("summary", {}, "高级配置：模型、分块与检索预算"),
      advanced,
    ),
    el("h4", {}, "选区翻译"),
    el("label", {}, "模型（默认 GLM）", translationChoice),
    el("p", { class: "res-note" }, "选择正文后点击“翻译”，仅翻译选区并在其下方展开。模型使用服务端 Pi 凭据。"),
    status,
    save,
  );
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
    await api.saveConfig({
      zotero: { dataDir: $("#cfg-zotero-dir").value.trim() },
    });
    await settingsBindings.reloadLibrary(true);
    msg.textContent = `同步完成 ✓ ${state.zotero?.papers || 0} 篇`;
    toast("Zotero 库已同步");
  } catch (e) {
    msg.textContent = "同步失败: " + e.message;
    toast("Zotero 同步失败: " + e.message, true);
  }
}
