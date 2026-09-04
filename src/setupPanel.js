// 环境检查 / 首次使用引导：拉取 /api/setup/status 渲染能力清单，
// 未就绪项给出安装链接与命令；首启自动弹出（config.setup.onboardedAt 为空且有未就绪项时）。
import { api, $, el, toast } from "./app.js";
import { openSettings } from "./settings.js";

const GROUPS = [
  { id: "core", name: "必选 · 内置" },
  { id: "docker", name: "可选增强 · Docker 服务（docker compose up -d）" },
  { id: "download", name: "可选 · 本地安装应用" },
  { id: "keys", name: "可选 · 密钥凭证" },
];
const STATUS_TEXT = { ok: "就绪", todo: "待配置", down: "不可达", off: "未启用" };

export function initSetupPanel() {
  $("#btn-setup-close").addEventListener("click", () => ($("#setup-backdrop").hidden = true));
  $("#setup-backdrop").addEventListener("click", (e) => {
    if (e.target === $("#setup-backdrop")) $("#setup-backdrop").hidden = true;
  });
  $("#btn-setup-recheck").addEventListener("click", () => refreshSetup());
  $("#btn-setup-dismiss").addEventListener("click", dismissSetup);
  void autoOpen();
}

async function autoOpen() {
  try {
    const st = await api.setupStatus();
    if (!st.onboardedAt && (st.summary.todo > 0 || st.summary.down > 0)) openSetup();
  } catch {}
}

export function openSetup() {
  $("#setup-backdrop").hidden = false;
  void refreshSetup();
}

async function refreshSetup() {
  const list = $("#setup-list");
  list.replaceChildren(el("p", { class: "res-note" }, "检测中…"));
  let st;
  try {
    st = await api.setupStatus();
  } catch (e) {
    list.replaceChildren(el("p", { class: "res-note" }, "检测失败：" + (e.message || e)));
    return;
  }
  list.replaceChildren(
    ...GROUPS.flatMap((g) => {
      const items = st.items.filter((i) => i.group === g.id);
      if (!items.length) return [];
      return [el("div", { class: "setup-group" }, g.name), ...items.map(renderItem)];
    })
  );
  $("#setup-summary").textContent = `就绪 ${st.summary.ok} · 待配置 ${st.summary.todo}${st.summary.down ? " · 异常 " + st.summary.down : ""}${st.summary.off ? " · 未启用 " + st.summary.off : ""}`;
}

function renderItem(item) {
  const actions = [];
  if (item.setup?.command) {
    actions.push(
      el("span", {
        class: "setup-cmd",
        title: "点击复制命令",
        onclick: () => {
          navigator.clipboard.writeText(item.setup.command).then(() => toast("命令已复制"), () => toast("复制失败", true));
        },
      }, "$ " + item.setup.command)
    );
  }
  for (const l of item.setup?.links || []) {
    actions.push(el("a", { class: "setup-link", href: l.url, target: "_blank", rel: "noopener" }, l.label + " ↗"));
  }
  actions.push(el("button", { class: "tool-btn setup-test-btn", onclick: () => testItem(item.id) }, "测试"));
  if (item.group !== "core") {
    actions.push(el("button", { class: "tool-btn setup-test-btn", onclick: () => openSettings() }, "去配置"));
  }
  return el("div", { class: "setup-item" },
    el("span", { class: "setup-dot " + item.status, title: STATUS_TEXT[item.status] }),
    el("div", { class: "setup-main" },
      el("div", { class: "setup-name" }, item.label, el("span", { class: "setup-state s-" + item.status }, STATUS_TEXT[item.status])),
      el("div", { class: "setup-why" }, item.why),
      item.detail ? el("div", { class: "setup-detail" }, item.detail) : null,
      el("div", { class: "setup-actions" }, ...actions)
    )
  );
}

async function testItem(id) {
  toast("测试中…");
  try {
    const r = await api.setupTest(id);
    toast(`${r.ok ? "✓ " : "✕ "}${r.detail || (r.ok ? "通过" : "未通过")}`, !r.ok);
  } catch (e) {
    toast("测试失败：" + (e.message || e), true);
  }
  void refreshSetup();
}

async function dismissSetup() {
  try {
    await api.saveConfig({ setup: { onboardedAt: new Date().toISOString() } });
    $("#setup-backdrop").hidden = true;
    toast("已关闭首启引导（⚙ 可随时再次打开环境检查）");
  } catch (e) {
    toast("保存失败：" + (e.message || e), true);
  }
}
