import { api, state, $, el, toast, askConfirm } from "./app.js";

// Resource manager: visual entry for pi skills / extensions / packages / MCP,
// with per-project skill & extension scoping for sessions bound to a project.

let resData = null;
let activeTab = "skills";
let saving = false;

export function initResources() {
  window.addEventListener("pi:resources", () => { if (!$("#resources-backdrop").hidden) loadResources(); });
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
  return currentProject()?.name || null;
}

function renderRes() {
  $("#res-proj-name").textContent = projName() ? `· 项目「${projName()}」` : "· 全局";
  const body = $("#res-body");
  body.replaceChildren();
  if (resData.resources) body.append(el("p", { class: "res-note" }, ({ applied: "当前会话资源已生效", pending: "当前任务结束后更新资源", failed: "加载失败，当前会话保留原配置" })[resData.resources.status] + (resData.resources.error ? "：" + resData.resources.error : "")));
  if (activeTab === "skills") renderSkills(body);
  else if (activeTab === "extensions") renderExtensions(body);
  else if (activeTab === "packages") renderPackages(body);
  else renderMcp(body);
}

function currentProject() {
  const id = resData?.sessionId ? resData.projectId : state.projectId;
  return state.projects.find((p) => p.id === id) || null;
}

async function saveResources(resources) {
  if (saving) return;
  const p = currentProject();
  if (!p) {
    p_resources_fallback(resources);
    return;
  }
  saving = true;
  for (const input of $("#res-body").querySelectorAll("input,button,select")) input.disabled = true;
  try {
    const updated = await api.updateProject(p.id, { resources }); p.resources = updated.resources;
    toast("已保存；空闲会话更新，运行中的会话等待任务结束"); await loadResources();
  } finally { saving = false; renderRes(); }
}

function p_resources_fallback() {
  toast("未选择项目 — 请先在侧边栏选择项目（全局资源由 ~/.pi/agent 管理）", true);
}

function renderSkills(body) {
  const project = currentProject();
  const resources = project?.resources || resData.selection || {};
  body.append(el("p", { class: "res-note" }, "技能来源（pi 原生）：① 安装技能包（npm / Git / 本地路径，包可携带技能，下方安装）；② 把技能文件夹放入 ~/.pi/agent/skills（全局）或应用目录 .pi/skills；③ 项目包安装后技能自动进入候选列表。"));
  // 新增技能：与 Packages 页共用 pi 原生 DefaultPackageManager
  const spec = el("input", { type: "text", placeholder: "新增技能：npm:包名 / npm:@scope/pkg@版本 / Git / 本地绝对路径", style: { flex: "1" } });
  const scope = el("select", {},
    el("option", { value: "project" }, "装到当前项目"),
    el("option", { value: "global" }, "全局（~/.pi/agent）"),
  );
  scope.disabled = !project;
  const installLog = el("pre", { class: "parse-log", style: { maxHeight: "110px", marginTop: "6px", display: "none" } });
  const installBtn = el("button", {
    class: "tool-btn primary", onclick: async () => {
      const v = spec.value.trim();
      if (!v) return toast("请填写包来源", true);
      if (scope.value === "project" && !project) return toast("先在侧边栏选择项目", true);
      installBtn.disabled = true;
      installLog.style.display = "block";
      installLog.textContent = "安装中…（npm/Git 来源需要网络）";
      try {
        const r = await api.pkgInstall(v, scope.value, project?.id);
        installLog.textContent = (r.ok ? "✓ 成功\n" : "✕ 失败\n") + (r.output || "") + (r.entries?.length ? "\n入口:\n" + r.entries.join("\n") : "");
        if (r.ok) {
          if (r.project && project) project.resources = r.project.resources;
          spec.value = "";
          toast("已安装；技能将出现在下方列表（空闲会话自动更新）");
          await loadResources();
        }
      } catch (e) {
        installLog.textContent = "✕ " + e.message;
      }
      installBtn.disabled = false;
    }
  }, "安装");
  body.append(el("div", { class: "res-row", style: { marginTop: "4px" } }, spec, scope, installBtn), installLog);
  const mode = el("select", {}, el("option", { value: "inherit" }, "继承默认技能"), el("option", { value: "selected" }, "只启用勾选技能"));
  mode.value = resources.skillsMode || "inherit"; mode.disabled = !project;
  mode.onchange = async () => { try { await saveResources({ skillsMode: mode.value, legacyGated: false, skillsEnabled: resData.skills.filter(s => s.enabled).map(s => s.name) }); } catch(e) { toast(e.message,true); } };
  body.append(el("p", { class: "res-note" }, "这里显示当前会话的候选技能和实际启用状态。论文技能按绑定进入候选列表；指定清单可以全部关闭。"), mode);
  body.append(el("button", { class: "tool-btn", disabled: !project, onclick: async () => { try { await saveResources({ skillsMode: "selected", legacyGated: false, skillsEnabled: [] }); } catch(e) { toast(e.message,true); } } }, "全部关闭"));
  for (const s of resData.skills || []) {
    const cb = el("input", { type: "checkbox" }); cb.checked = resources.skillsMode === "selected" && !resources.legacyGated ? (resources.skillsEnabled || []).includes(s.name) : !!s.enabled; cb.disabled = !project;
    cb.onchange = async () => {
      const selection = new Set(resources.skillsMode === "selected" && !resources.legacyGated ? resources.skillsEnabled : resData.skills.filter(s => s.enabled).map(s => s.name));
      cb.checked ? selection.add(s.name) : selection.delete(s.name);
      cb.disabled = true;
      try { await saveResources({ skillsMode: "selected", legacyGated: false, skillsEnabled: [...selection] }); }
      catch(e) { toast(e.message,true); cb.disabled = false; }
    };
    body.append(el("div", { class: "res-row" }, el("label", { class: "res-check" }, cb, el("span", { class: "res-name" }, s.name)), el("span", { class: "res-desc" }, s.description || ""), el("span", { class: "res-src" }, s.source || "")));
  }
}

function renderExtensions(body) {
  const proj = currentProject();
  body.append(
    el("p", { class: "res-note" },
      "已加载的扩展（~/.pi/agent/extensions、.pi/extensions 与 settings.json packages）。每个会话独立加载；项目可在下方追加项目专属扩展路径。")
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
      "（由 Pi 原生包管理器安装）。全局配置由 Pi 管理；项目包安装在独立管理目录，仅供该项目使用。")
  );
  // install form
  const spec = el("input", { type: "text", placeholder: "npm:包名、npm:@scope/pkg@版本、Git 来源或绝对路径", style: { flex: "1" } });
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
        const r = await api.pkgInstall(spec.value.trim(), scope.value, currentProject()?.id);
        log.textContent = (r.ok ? "✓ 成功\n" : "✕ 失败\n") + (r.output || "") + (r.entries?.length ? "\n入口: \n" + r.entries.join("\n") : "");
        if (r.ok) { if (r.project && currentProject()) currentProject().resources = r.project.resources; spec.value = ""; loadResources(); }
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
      el("span", { class: "res-name" }, typeof p === "string" ? p : p.source),
      el("button", {
        class: "icon-btn", onclick: async () => {
          if (!(await askConfirm({ title: "移除全局包", message: `移除全局包 ${p}？（执行 pi remove）`, okText: "移除", danger: true }))) return;
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
      el("span", { class: "res-name" }, typeof p === "string" ? p : p.source),
      el("button", {
        class: "icon-btn", onclick: async () => {
          try { const result = await api.pkgRemoveProject(p, proj.id); if (result.project) proj.resources = result.project.resources; await loadResources(); } catch(e) { toast(e.message,true); }
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
