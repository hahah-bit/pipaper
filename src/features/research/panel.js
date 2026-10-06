import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";
import { state } from "../../shell/state.js";
import { selectPaper } from "../../sidebar.js";
import { actionStatusLabel, buildTimeline, openActions } from "./overview.js";

// 研究面板（加法开发 A01）：可选的项目研究档案。
// 不选中项目时只显示空状态；面板加载失败只影响本面板，随时可以关闭返回原工作区。

const profileUrl = (projectId) => "/api/research/projects/" + encodeURIComponent(projectId) + "/profile";
const STATUS_OPTIONS = ["todo", "doing", "done", "blocked"];
const KIND_ICON = { paper: "📄" };

export function researchModule() {
  let alive = false;
  let root = null;
  let projectId = null;
  let profile = null;
  let onProjectChanged = null;

  async function fetchProfile() {
    const data = await requestJson(profileUrl(projectId));
    profile = data.profile;
  }

  async function saveProfile(patch) {
    const data = await requestJson(profileUrl(projectId), {
      method: "PUT",
      body: { ...patch, revision: profile?.revision },
    });
    profile = data.profile;
  }

  function projectPapers() {
    const project = state.projects.find((p) => p.id === projectId);
    const ids = new Set(project?.paperIds || []);
    return state.papers.filter((p) => ids.has(p.id));
  }

  function render(container) {
    const head = el("div", { class: "research-head" },
      el("strong", {}, "研究概览"),
      el("span", { class: "research-head-note" }, "可选：为当前项目附加研究档案，不使用时一切照旧"),
    );
    const select = el("select", {
      class: "research-project-select",
      onchange: () => { projectId = select.value || null; profile = null; void refresh(bodyArea); },
    },
      el("option", { value: "" }, "选择项目…"),
      state.projects.map((p) => el("option", { value: p.id, selected: p.id === projectId }, p.name)),
    );
    head.append(select);
    const bodyArea = el("div", { class: "research-body" });
    container.replaceChildren(head, bodyArea);
    void refresh(bodyArea);
    return bodyArea;
  }

  async function refresh(bodyArea) {
    if (!projectId) {
      bodyArea.replaceChildren(el("div", { class: "empty-hint" },
        el("h3", {}, "尚未选择项目"),
        "在顶部选择或新建一个项目后，可以在这里启用研究档案，记录问题、成果关联与下一步。"));
      return;
    }
    bodyArea.replaceChildren(el("div", { class: "empty-hint" }, "正在加载研究档案…"));
    try {
      await fetchProfile();
    } catch (e) {
      // 错误局限在新面板：提供重试，不影响其他工作区。
      bodyArea.replaceChildren(el("div", { class: "empty-hint" },
        el("h3", {}, "研究档案加载失败"),
        e.message || "未知错误",
        el("div", {}, el("button", { class: "tool-btn", onclick: () => void refresh(bodyArea) }, "重试"))));
      return;
    }
    if (!profile) {
      const enable = el("button", {
        class: "tool-btn primary",
        onclick: async () => {
          try {
            await saveProfile({});
            renderProfile(bodyArea);
          } catch (e) { toast(e.message, true); }
        },
      }, "启用研究档案");
      bodyArea.replaceChildren(el("div", { class: "empty-hint" },
        el("h3", {}, "该项目还没有研究档案"),
        "启用后可记录研究问题、目标、成果关联与下一步行动；原始文献与对话不受影响。",
        el("div", {}, enable)));
      return;
    }
    renderProfile(bodyArea);
  }

  function renderProfile(bodyArea) {
    const questionInput = el("textarea", { rows: "2", placeholder: "当前要回答的研究问题（可留空）" }, profile.question || "");
    const scopeInput = el("input", { type: "text", value: profile.scope || "", placeholder: "范围（对象、条件、边界）" });
    const goalInput = el("input", { type: "text", value: profile.goal || "", placeholder: "阶段目标" });
    const constraintsInput = el("textarea", { rows: "2", placeholder: "现实约束：时间、硬件、数据访问等（未知项保持未知）" }, profile.constraints || "");
    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          await saveProfile({
            question: questionInput.value,
            scope: scopeInput.value,
            goal: goalInput.value,
            constraints: constraintsInput.value,
            outcomes: profile.outcomes,
            actions: profile.actions,
          });
          toast("研究档案已保存");
          renderProfile(bodyArea);
        } catch (e) {
          toast(e.message, true);
        } finally { saveBtn.disabled = false; }
      },
    }, "保存档案");

    const outcomeList = el("div", { class: "research-outcome-list" });
    const renderOutcomes = () => {
      outcomeList.replaceChildren(
        ...(profile.outcomes || []).map((o, index) => el("div", { class: "research-outcome-item" },
          el("span", {}, (KIND_ICON[o.kind] || "🔗") + " " + (o.title || o.refId)),
          el("button", {
            class: "tool-btn",
            title: "打开原文",
            onclick: () => {
              if (!o.refId.startsWith("paper:")) return toast("该成果类型暂不支持直接打开", true);
              const paper = state.papers.find((p) => p.id === o.refId.slice("paper:".length));
              if (!paper) return toast("论文不在当前文献列表中", true);
              selectPaper(paper);
            },
          }, "查看"),
          el("button", {
            class: "tool-btn danger",
            title: "解除关联（不会删除原件）",
            onclick: async () => {
              profile.outcomes = profile.outcomes.filter((_, i) => i !== index);
              try {
                await saveProfile({ outcomes: profile.outcomes, actions: profile.actions });
                renderOutcomes();
              } catch (e) { toast(e.message, true); }
            },
          }, "移除"),
        )),
        ...(profile.outcomes || []).length ? [] : [el("div", { class: "research-muted" }, "还没有关联成果。可以关联本项目中的论文、笔记或报告，原文件不会被移动。")],
      );
    };
    renderOutcomes();

    const paperSelect = el("select", { class: "research-project-select" },
      el("option", { value: "" }, "选择本项目论文…"),
      projectPapers().map((p) => el("option", { value: "paper:" + p.id }, p.title || p.id)));
    const addPaperBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        if (!paperSelect.value) return;
        if ((profile.outcomes || []).some((o) => o.refId === paperSelect.value)) {
          paperSelect.value = "";
          return toast("该成果已关联");
        }
        try {
          await saveProfile({ outcomes: [...(profile.outcomes || []), { refId: paperSelect.value }], actions: profile.actions });
          renderOutcomes();
          paperSelect.value = "";
        } catch (e) { toast(e.message, true); }
      },
    }, "关联成果");

    const actionList = el("div", { class: "research-action-list" });
    const renderActions = () => {
      actionList.replaceChildren(
        ...(profile.actions || []).map((a) => el("div", { class: "research-action-item research-status-" + a.status },
          el("span", { class: "research-action-text" }, a.text),
          a.status === "blocked" && a.blockedReason ? el("span", { class: "research-muted" }, "阻塞：" + a.blockedReason) : null,
          el("select", {
            class: "research-status-select",
            onchange: async (event) => {
              a.status = event.target.value;
              try {
                await saveProfile({ outcomes: profile.outcomes, actions: profile.actions });
                renderActions();
                renderTimeline();
              } catch (e) { toast(e.message, true); }
            },
          }, STATUS_OPTIONS.map((s) => el("option", { value: s, selected: s === a.status }, actionStatusLabel(s)))),
          el("button", {
            class: "tool-btn danger",
            title: "删除行动项",
            onclick: async () => {
              profile.actions = profile.actions.filter((x) => x.id !== a.id);
              try {
                await saveProfile({ outcomes: profile.outcomes, actions: profile.actions });
                renderActions();
                renderTimeline();
              } catch (e) { toast(e.message, true); }
            },
          }, "删除"),
        )),
        ...(profile.actions || []).length ? [] : [el("div", { class: "research-muted" }, "还没有下一步行动。")],
      );
    };
    const statusSelect = el("select", { class: "research-status-select" },
      STATUS_OPTIONS.map((s) => el("option", { value: s }, actionStatusLabel(s))));
    const actionInput = el("input", { type: "text", placeholder: "添加下一步行动或阻塞项…" });
    const addAction = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const text = actionInput.value.trim();
        if (!text) return;
        try {
          await saveProfile({ outcomes: profile.outcomes, actions: [...(profile.actions || []), { text, status: statusSelect.value }] });
          actionInput.value = "";
          renderActions();
          renderTimeline();
        } catch (e) { toast(e.message, true); }
      },
    }, "添加");
    renderActions();

    const timeline = el("div", { class: "research-timeline" });
    const renderTimeline = () => {
      timeline.replaceChildren(
        el("h4", {}, "最近更新"),
        ...buildTimeline(profile).map((event) => el("div", { class: "research-timeline-item" },
          el("span", { class: "research-timeline-at" }, event.at.slice(0, 16).replace("T", " ")),
          el("span", {}, event.label))),
        ...buildTimeline(profile).length ? [] : [el("div", { class: "research-muted" }, "暂无更新记录。")],
      );
    };
    renderTimeline();

    const deleteBtn = el("button", {
      class: "tool-btn danger",
      onclick: async () => {
        const ok = await askConfirm({
          title: "删除研究档案",
          message: "只删除研究档案与其关联记录（进入回收站，可恢复）；项目文献与对话不受影响。",
          okText: "删除",
          danger: true,
        });
        if (!ok) return;
        try {
          await requestJson(profileUrl(projectId), { method: "DELETE" });
          profile = null;
          void refresh(bodyArea);
        } catch (e) { toast(e.message, true); }
      },
    }, "删除档案");

    bodyArea.replaceChildren(
      el("div", { class: "research-card" },
        el("h4", {}, "研究问题与目标"),
        el("label", { class: "research-field" }, "研究问题", questionInput),
        el("label", { class: "research-field" }, "范围", scopeInput),
        el("label", { class: "research-field" }, "阶段目标", goalInput),
        el("label", { class: "research-field" }, "现实约束", constraintsInput),
        el("div", { class: "research-card-foot" },
          el("span", { class: "research-muted" }, "最近保存：" + (profile.updatedAt || "").replace("T", " ").slice(0, 16) || ""),
          saveBtn)),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          el("h4", {}, "成果关联（" + (profile.outcomes || []).length + "）"),
          outcomeList,
          el("div", { class: "research-add-row" }, paperSelect, addPaperBtn)),
        el("div", { class: "research-card" },
          el("h4", {}, "下一步与阻塞（" + openActions(profile).length + " 项未完成）"),
          actionList,
          el("div", { class: "research-add-row" }, statusSelect, actionInput, addAction))),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" }, timeline),
        el("div", { class: "research-card" },
          el("h4", {}, "继续工作"),
          el("div", { class: "research-muted" }, "阅读请回到左侧文献列表选择论文；新功能不会改变原有入口。"),
          el("div", { class: "research-add-row" },
            el("button", {
              class: "tool-btn",
              onclick: () => window.dispatchEvent(new CustomEvent("pipaper:workspace-open", { detail: { moduleId: "mdedit" } })),
            }, "打开写作"),
            el("button", {
              class: "tool-btn",
              onclick: () => window.dispatchEvent(new CustomEvent("pipaper:workspace-open", { detail: { moduleId: "knowledge" } })),
            }, "打开知识检索"))),
      ),
      el("div", { class: "research-foot" }, deleteBtn),
    );
  }

  return {
    id: "research",
    mount(body) {
      alive = true;
      projectId = state.projectId || null;
      root = el("div", { class: "research-panel" });
      render(root);
      body.replaceChildren(root);
      onProjectChanged = () => {
        if (!alive) return;
        const next = state.projectId || null;
        if (next === projectId) return;
        projectId = next;
        profile = null;
        render(root);
      };
      window.addEventListener("pipaper:project-changed", onProjectChanged);
    },
    unmount() {
      alive = false;
      if (onProjectChanged) window.removeEventListener("pipaper:project-changed", onProjectChanged);
      onProjectChanged = null;
      root = null;
    },
  };
}
