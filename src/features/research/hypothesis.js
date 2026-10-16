import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";
import { state } from "../../shell/state.js";

// 想法与假设（A03）：一条假设可查看来源、当时选择和后续结果；
// 未支持的假设正常保留，AI 不自动改写研究判断。

export const DECISION_STATUS_LABEL = {
  exploring: "探索中",
  continue: "继续验证",
  hold: "搁置",
  revise: "修改方向",
  stop: "停止",
};

export const decisionLabel = (status) => DECISION_STATUS_LABEL[status] || status || "探索中";

export function decisionTimeline(hypothesis) {
  return (hypothesis?.decisionHistory || []).map((entry) => ({
    at: entry.at,
    label: decisionLabel(entry.status) + (entry.reason ? "：" + entry.reason : ""),
  }));
}

export function hypothesisSection({ projectId }) {
  const container = el("div", { class: "research-hypothesis" });
  let current = null;
  let evidenceCache = null;

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function loadEvidence() {
    if (!evidenceCache) {
      try {
        evidenceCache = (await requestJson(base() + "/evidence")).evidence || [];
      } catch {
        evidenceCache = [];
      }
    }
    return evidenceCache;
  }

  const evidenceTitle = (id) => {
    const item = (evidenceCache || []).find((e) => e.id === id);
    return item ? (item.content || "").slice(0, 40) : id;
  };

  async function refreshList() {
    current = null;
    let hypotheses = [];
    try {
      hypotheses = (await requestJson(base() + "/hypotheses")).hypotheses || [];
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "假设加载失败：" + e.message));
      return;
    }
    const titleInput = el("input", { type: "text", placeholder: "新假设标题，如：掩码修正解释了指标差异" });
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const title = titleInput.value.trim();
        if (!title) return toast("请填写假设标题", true);
        try {
          const data = await requestJson(base() + "/hypotheses", {
            method: "POST",
            body: { title, statement: titleInput.value.trim() },
          });
          toast("假设草稿已创建，可以继续补充可验证内容");
          await openEditor(data.hypothesis.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "登记想法");
    container.replaceChildren(
      el("div", { class: "research-add-row" }, titleInput, createBtn),
      ...(hypotheses.length ? hypotheses.map((h) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-content", title: h.statement }, "💡 " + h.title),
        el("span", { class: "research-muted" }, decisionLabel(h.decision?.status)),
        el("button", { class: "tool-btn", onclick: () => void openEditor(h.id) }, "打开"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            const ok = await askConfirm({ title: "删除假设", message: "删除「" + h.title + "」？（进入回收站，可恢复；未支持的假设也可以直接保留）", okText: "删除", danger: true });
            if (!ok) return;
            try {
              await requestJson(base() + "/hypotheses/" + h.id, { method: "DELETE" });
              void refreshList();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "还没有假设记录。登记研究想法、反例与取舍理由，避免只记得结论。")]),
    );
  }

  // F05 修复：局部动作（记录决策、关联证据）触发重绘前，先把输入框中
  // 尚未保存的内容收集进 current，避免整区重绘丢掉正在输入的正文。
  const draftInputs = {};
  function collectDraft() {
    if (!draftInputs.statement) return;
    current.statement = draftInputs.statement.value;
    current.prediction = draftInputs.prediction.value;
    current.scope = draftInputs.scope.value;
    current.counterExamples = draftInputs.counterExamples.value;
    current.unknowns = draftInputs.unknowns.value;
    current.sourceNote = draftInputs.source.value;
  }

  function renderEditor() {
    collectDraft();
    const field = (label, node) => el("label", { class: "research-field" }, label, node);
    const titleInput = el("input", { type: "text", value: current.title, onchange: (e) => { current.title = e.target.value.trim() || current.title; } });
    const statementInput = el("textarea", { rows: "3", placeholder: "这个方向的想法与依据（可从报告复制选定部分）" }, current.statement || "");
    const predictionInput = el("textarea", { rows: "2", placeholder: "如果成立，应该观察到什么？（可验证预测）" }, current.prediction || "");
    const scopeInput = el("input", { type: "text", value: current.scope || "", placeholder: "作用范围与前提" });
    const counterInput = el("textarea", { rows: "2", placeholder: "反例、替代解释或已知相反结果" }, current.counterExamples || "");
    const unknownsInput = el("input", { type: "text", value: current.unknowns || "", placeholder: "尚未确认的部分" });
    const sourceInput = el("input", { type: "text", value: current.sourceNote || "", placeholder: "想法来源（选题报告 / 对话 / 笔记）" });
    draftInputs.statement = statementInput;
    draftInputs.prediction = predictionInput;
    draftInputs.scope = scopeInput;
    draftInputs.counterExamples = counterInput;
    draftInputs.unknowns = unknownsInput;
    draftInputs.source = sourceInput;

    const evidenceRow = (fieldKey, label) => {
      const list = el("div", { class: "research-hypothesis-evidence" },
        ...(current[fieldKey] || []).map((id) => el("span", { class: "research-evidence-type", title: evidenceTitle(id) },
          (fieldKey === "support" ? "支持 · " : "反对 · ") + evidenceTitle(id),
          el("button", {
            class: "research-cell-remove",
            onclick: () => { current[fieldKey] = current[fieldKey].filter((x) => x !== id); renderEditor(); },
          }, "×"))),
        ...(current[fieldKey] || []).length ? [] : [el("span", { class: "research-muted" }, "暂无" + label + "证据")],
      );
      const select = el("select", { class: "research-status-select" },
        el("option", { value: "" }, "选择证据卡…"),
        ...(evidenceCache || []).filter((e) => !(current[fieldKey] || []).includes(e.id))
          .map((e) => el("option", { value: e.id }, (e.content || "").slice(0, 30))));
      const addBtn = el("button", {
        class: "tool-btn",
        onclick: () => {
          if (!select.value) return;
          current[fieldKey] = [...(current[fieldKey] || []), select.value];
          renderEditor();
        },
      }, "关联");
      return el("div", { class: "research-field" }, label, list, el("div", { class: "research-add-row" }, select, addBtn));
    };

    const decisionSelect = el("select", { class: "research-status-select" },
      Object.entries(DECISION_STATUS_LABEL).map(([value, label]) => el("option", { value, selected: value === (current.decision?.status || "exploring") }, label)));
    const decisionReason = el("input", { type: "text", value: current.decision?.reason || "", placeholder: "选择理由（为什么继续 / 搁置 / 停止）" });
    const decideBtn = el("button", {
      class: "tool-btn",
      onclick: () => {
        current.decision = { status: decisionSelect.value, reason: decisionReason.value.trim() };
        renderEditor();
      },
    }, "记录决策");

    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const data = await requestJson(base() + "/hypotheses/" + current.id, {
            method: "PUT",
            body: {
              title: current.title,
              statement: statementInput.value.trim(),
              prediction: predictionInput.value.trim(),
              scope: scopeInput.value.trim(),
              counterExamples: counterInput.value.trim(),
              unknowns: unknownsInput.value.trim(),
              sourceNote: sourceInput.value.trim(),
              support: current.support,
              oppose: current.oppose,
              decision: current.decision,
              revision: current.revision,
            },
          });
          current = data.hypothesis;
          toast("假设已保存");
          renderEditor();
        } catch (e) {
          toast(e.message, true);
        } finally { saveBtn.disabled = false; }
      },
    }, "保存假设");

    const timeline = decisionTimeline(current);
    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        titleInput,
        saveBtn),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          field("假设内容", statementInput),
          field("可验证预测", predictionInput),
          field("作用范围与前提", scopeInput)),
        el("div", { class: "research-card" },
          field("反例与替代解释", counterInput),
          field("未知项", unknownsInput),
          field("想法来源", sourceInput))),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" }, evidenceRow("support", "支持"), evidenceRow("oppose", "反对")),
        el("div", { class: "research-card" },
          el("h4", {}, "研究决策"),
          el("div", { class: "research-add-row" }, decisionSelect, decisionReason, decideBtn),
          current.decision ? el("div", { class: "research-muted" },
            "当前：" + decisionLabel(current.decision.status) + (current.decision.reason ? " — " + current.decision.reason : "")) : null,
          ...timeline.map((entry) => el("div", { class: "research-timeline-item" },
            el("span", { class: "research-timeline-at" }, entry.at.slice(0, 16).replace("T", " ")),
            el("span", {}, entry.label))),
          ...timeline.length ? [] : [el("div", { class: "research-muted" }, "还没有决策记录；保存后状态变化会自动留下历史。")]),
      ),
    );
  }

  async function openEditor(id) {
    await loadEvidence();
    try {
      current = (await requestJson(base() + "/hypotheses/" + id)).hypothesis;
      for (const key of Object.keys(draftInputs)) draftInputs[key] = null; // 切换对象：不回填旧输入
      renderEditor();
    } catch (e) {
      toast(e.message, true);
    }
  }

  void refreshList();
  return { container, refresh: refreshList };
}
