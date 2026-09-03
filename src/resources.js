import { api, state, $, el, toast } from "./app.js";

// Resource manager: visual entry for pi skills / extensions / packages / MCP,
// with per-project skill & extension scoping for sessions bound to a project.

let resData = null;
let activeTab = "skills";

export function initResources() {
  $("#btn-resources").addEventListener("click", openResources);
  $("#btn-resources-close").addEventListener("click", () => ($("#resources-backdrop").hidden = true));
  $("#resources-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "resources-backdrop") e.target.hidden = true;
  });
  document.querySelectorAll(".res-tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".res-tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      activeTab = t.dataset.tab;
      renderRes();
    })
  );
}

async function openResources() {
  $("#resources-backdrop").hidden = false;
  try {
    resData = await api.resources();
  } catch (e) {
    toast("加载资源失败: " + e.message, true);
    resData = { skills: [], extensions: [], packages: [], mcp: [] };
  }
  renderRes();
}

function projName() {
  return state.projectId ? state.projects.find((p) => p.id === state.projectId)?.name : null;
}

function renderRes() {
  $("#res-proj-name").textContent = projName() ? `· 项目「${projName()}」` : "· 全局";
  const body = $("#res-body");
  body.replaceChildren();
  if (activeTab === "skills") renderSkills(body);
  else if (activeTab === "extensions") renderExtensions(body);
  else if (activeTab === "packages") renderPackages(body);
  else renderMcp(body);
}

function currentProject() {
  return state.projects.find((p) => p.id === state.projectId) || null;
}

async function saveResources(resources) {
  const p = currentProject();
  if (!p) {
    p_resources_fallback(resources);
    return;
  }
  p.resources = { ...(p.resources || {}), ...resources };
  await api.updateProject(p.id, { resources: p.resources });
  toast("已保存，绑定该项目的会话生效");
}

function p_resources_fallback() {
  toast("未选择项目 — 请先在侧边栏选择项目（全局资源由 ~/.pi/agent 管理）", true);
}

function renderSkills(body) {
  const proj = currentProject();
  const enabled = proj?.resources?.skillsEnabled || [];
  body.append(
    el("p", { class: "res-note" },
      "分层技能路由（展示层）：基座技能始终可用；", el("b", {}, "论文综合技能组"), "（zotero / nature-* 等）只在会话绑定论文或 Zotero 项目时自动注入，不做强制钩子。")
  );
  // gated 论文综合 group
  const gated = resData.gatedSkills || [];
  body.append(el("div", { class: "dd-group", style: { paddingLeft: 0 } }, `论文综合技能组（按需加载 · ${gated.length} 个）`));
  if (!gated.length) body.append(el("p", { class: "res-note" }, "未发现分层技能。把技能放进 ~/.pi/agent/skills-gated/ 即进入该组（不直接暴露给 pi）。"));
  for (const s of gated) {
    body.append(el("div", { class: "res-row" },
      el("span", { class: "res-name" }, "🔒 " + s.name),
      el("span", { class: "res-desc" }, s.description),
      el("span", { class: "res-src" }, "论文综合")
    ));
  }
  body.append(el("div", { class: "dd-group", style: { paddingLeft: 0 } }, "基座技能（pi 常规发现）"));
  for (const s of resData.skills) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !proj || !enabled.length || enabled.includes(s.name);
    cb.addEventListener("change", async () => {
      const set = new Set(enabled);
      cb.checked ? set.add(s.name) : set.delete(s.name);
      await saveResources({ skillsEnabled: [...set] });
    });
    body.append(
      el("div", { class: "res-row" },
        el("label", { class: "res-check" }, cb, el("span", { class: "res-name" }, s.name)),
        el("span", { class: "res-desc" }, s.description?.slice(0, 90) || ""),
        el("span", { class: "res-src" }, s.source || "")
      )
    );
  }
}

function renderExtensions(body) {
  const proj = currentProject();
  body.append(
    el("p", { class: "res-note" },
      "已加载的扩展（~/.pi/agent/extensions、.pi/extensions 与 settings.json packages）。扩展为全局加载；项目可在下方追加项目专属扩展路径。")
  );
  if (!resData.extensions.length) body.append(el("p", { class: "res-note" }, "未发现已加载扩展。"));
  for (const e of resData.extensions) {
    body.append(el("div", { class: "res-row" },
      el("span", { class: "res-name" }, e.name),
      el("span", { class: "res-desc" }, e.path || ""),
      el("span", { class: "res-src" }, e.source || "")
    ));
  }
  body.append(el("div", { class: "dd-group", style: { paddingLeft: 0 } }, "已安装插件（本地）"));
  if (!resData.plugins?.length) body.append(el("p", { class: "res-note" }, "尚无插件 — 插件放在 ~/.pi/agent/skills/<插件名>/.codex-plugin/plugin.json 即会被识别。"));
  for (const p of resData.plugins || []) {
    body.append(el("div", { class: "res-row" },
      el("span", { class: "res-name" }, "🧩 " + p.name + (p.version ? " v" + p.version : "")),
      el("span", { class: "res-desc" }, p.description),
      el("span", { class: "res-src" }, p.category || "")
    ));
  }
  const input = el("input", { type: "text", placeholder: "扩展文件/目录绝对路径，如 D:\\my-ext.ts" });
  const addBtn = el("button", { class: "tool-btn", onclick: async () => {
    const p = currentProject();
    if (!p) return toast("先选择项目再添加项目级扩展", true);
    const v = input.value.trim();
    if (!v) return;
    const list = [...(p.resources?.extensions || []), v];
    await saveResources({ extensions: list });
    input.value = "";
    renderExtExtra(list);
  } }, "添加到当前项目");
  body.append(el("div", { class: "res-row", style: { marginTop: "10px" } }, input, addBtn));
  const extraBox = el("div", {});
  body.append(extraBox);
  const renderExtExtra = (list) => {
    extraBox.replaceChildren();
    for (const path of list || []) {
      extraBox.append(el("div", { class: "res-row" },
        el("span", { class: "res-name" }, "🧩 " + path),
        el("button", { class: "icon-btn", onclick: async () => {
          const rest = list.filter((x) => x !== path);
          await saveResources({ extensions: rest });
          renderExtExtra(rest);
        } }, "移除")
      ));
    }
  };
  renderExtExtra(proj?.resources?.extensions || []);
}

function renderPackages(body) {
  body.append(
    el("p", { class: "res-note" },
      "pi 扩展包商店：",
      el("a", { href: "https://pi.dev/packages", target: "_blank", style: { color: "var(--accent)" } }, "pi.dev/packages"),
      "（安装即调用本地 pi CLI）。全局安装写入 ~/.pi/agent/settings.json；项目安装通过 npm 装到本工作区，仅对绑定该项目的会话生效。")
  );
  // install form
  const spec = el("input", { type: "text", placeholder: "包名，如 npm:pi-web-access 或 @scope/pkg", style: { flex: "1" } });
  const scope = el("select", {},
    el("option", { value: "global" }, "全局（~/.pi/agent）"),
    el("option", { value: "project" }, "当前项目"),
  );
  const log = el("pre", { class: "parse-log", style: { maxHeight: "120px", marginTop: "8px", display: "none" } });
  const btn = el("button", {
    class: "tool-btn primary", onclick: async () => {
      btn.disabled = true;
      log.style.display = "block";
      log.textContent = "安装中…";
      try {
        const r = await api.pkgInstall(spec.value.trim(), scope.value, state.projectId);
        log.textContent = (r.ok ? "✓ 成功\n" : "✕ 失败\n") + (r.output || "") + (r.entries?.length ? "\n入口: \n" + r.entries.join("\n") : "");
        if (r.ok) { spec.value = ""; loadResources(); }
      } catch (e) {
        log.textContent = "✕ " + e.message;
      }
      btn.disabled = false;
    }
  }, "安装");
  body.append(el("div", { class: "res-row", style: { marginTop: "6px" } }, spec, scope, btn), log);

  // global packages
  body.append(el("div", { class: "dd-group", style: { paddingLeft: 0 } }, "全局已安装"));
  if (!resData.packages.length) body.append(el("p", { class: "res-note" }, "未安装包。"));
  for (const p of resData.packages) {
    body.append(el("div", { class: "res-row" },
      el("span", { class: "res-name" }, p),
      el("button", {
        class: "icon-btn", onclick: async () => {
          if (!confirm(`移除全局包 ${p}？（执行 pi remove）`)) return;
          const r = await api.pkgRemove(p);
          toast(r.ok ? "已移除" : "移除失败: " + (r.output || "").slice(0, 120), !r.ok);
          loadResources();
        }
      }, "移除")
    ));
  }
  // project packages
  const proj = currentProject();
  body.append(el("div", { class: "dd-group", style: { paddingLeft: 0 } }, "当前项目已安装"));
  const list = proj?.resources?.packages || [];
  if (!proj) body.append(el("p", { class: "res-note" }, "未选择项目 — 选择后可把包装到项目里（仅该项目会话生效）。"));
  else if (!list.length) body.append(el("p", { class: "res-note" }, "该项目尚未安装包。"));
  for (const p of list) {
    body.append(el("div", { class: "res-row" },
      el("span", { class: "res-name" }, p),
      el("button", {
        class: "icon-btn", onclick: async () => {
          const rest = list.filter((x) => x !== p);
          proj.resources.packages = rest;
          await api.updateProject(proj.id, { resources: { packages: rest } });
          loadResources();
        }
      }, "移除")
    ));
  }
}

async function loadResources() {
  try {
    resData = await api.resources();
  } catch {}
  renderRes();
}

function renderMcp(body) {
  body.append(
    el("p", { class: "res-note" },
      "pi 官方设计不内置 MCP（\"intentionally does not include built-in MCP\"）—— 工作流扩展走 extensions/skills/packages。", el("br"),
      "以下是只读扫描到的常见 MCP 配置（供参考；桥接 MCP 工具为 pi 扩展属于后续规划）。"
    )
  );
  if (!resData.mcp.length) body.append(el("p", { class: "res-note" }, "未扫描到 MCP 配置文件。"));
  for (const m of resData.mcp) {
    body.append(el("div", { class: "res-row" },
      el("span", { class: "res-name" }, m.name),
      el("span", { class: "res-desc" }, [m.command, ...m.args].join(" ").slice(0, 80)),
      el("span", { class: "res-src" }, m.config.split(/[\\/]/).slice(-2).join("/"))
    ));
  }
}
