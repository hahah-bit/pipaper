import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";
import { state } from "../../shell/state.js";

// 研究方案与基线对齐（A04）：接住研读计划或手写方案；
// 冻结后产生可引用版本，修改不清除历史快照。

export const BASELINE_STATUS_LABEL = {
  aligned: "已对齐",
  partial: "部分对齐",
  unaligned: "未对齐",
  na: "不适用",
};

export const protocolStatusLabel = (status) => (status === "frozen" ? "已冻结" : "草稿");

export function baselineGapCount(protocol) {
  return (protocol?.baselines || []).filter((row) => row.status === "unaligned" || row.status === "partial").length;
}

export function protocolSection({ projectId }) {
  const container = el("div", { class: "research-protocol" });
  let current = null;

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function refreshList() {
    current = null;
    let protocols = [];
    try {
      protocols = (await requestJson(base() + "/protocols")).protocols || [];
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "研究方案加载失败：" + e.message));
      return;
    }
    const titleInput = el("input", { type: "text", placeholder: "新方案标题，如：基线对齐与改进验证" });
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const title = titleInput.value.trim();
        if (!title) return toast("请填写方案标题", true);
        try {
          const data = await requestJson(base() + "/protocols", { method: "POST", body: { title } });
          toast("方案草稿已创建");
          await openEditor(data.protocol.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "新建方案");
    container.replaceChildren(
      el("div", { class: "research-add-row" }, titleInput, createBtn),
      ...(protocols.length ? protocols.map((p) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-content", title: p.objective || "" }, "📋 " + p.title),
        el("span", { class: "research-muted" }, protocolStatusLabel(p.status) + " · 基线 " + (p.baselines || []).length + " 行"),
        el("button", { class: "tool-btn", onclick: () => void openEditor(p.id) }, "打开"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            const ok = await askConfirm({ title: "删除方案", message: "删除「" + p.title + "」？（进入回收站，可恢复；已冻结版本随方案一起保存）", okText: "删除", danger: true });
            if (!ok) return;
            try {
              await requestJson(base() + "/protocols/" + p.id, { method: "DELETE" });
              void refreshList();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "还没有研究方案。可以从研读计划复制内容，或直接手写。")]),
    );
  }

  function renderEditor() {
    const field = (label, node) => el("label", { class: "research-field" }, label, node);
    const titleInput = el("input", { type: "text", class: "research-matrix-title", value: current.title, onchange: (e) => { current.title = e.target.value.trim() || current.title; } });
    const sourceInput = el("input", { type: "text", value: current.sourceNote || "", placeholder: "方案来源（研读计划 / 手写 / 选题报告）" });
    const objectiveInput = el("textarea", { rows: "2", placeholder: "验证目标：主要问题、预期与失败判据" }, current.objective || "");
    const datasetsInput = el("textarea", { rows: "2", placeholder: "数据版本、划分与预处理（未确认的保持未确认）" }, current.datasets || "");
    const metricsInput = el("textarea", { rows: "2", placeholder: "指标定义：公式、单位、聚合与阈值来源" }, current.metrics || "");
    const budgetInput = el("input", { type: "text", value: current.budget || "", placeholder: "预算与停止条件" });

    const baselineRows = el("div", { class: "research-baseline-rows" });
    const renderBaselines = () => {
      baselineRows.replaceChildren(
        ...(current.baselines || []).map((row, index) => el("div", { class: "research-baseline-row" },
          el("input", { type: "text", value: row.name, placeholder: "基线名称", onchange: (e) => { row.name = e.target.value.trim(); } }),
          el("input", { type: "text", value: row.paperSetup, placeholder: "论文设置", onchange: (e) => { row.paperSetup = e.target.value.trim(); } }),
          el("input", { type: "text", value: row.repoSetup, placeholder: "仓库配置", onchange: (e) => { row.repoSetup = e.target.value.trim(); } }),
          el("input", { type: "text", value: row.actualSetup, placeholder: "实际条件", onchange: (e) => { row.actualSetup = e.target.value.trim(); } }),
          el("select", { class: "research-status-select", onchange: (e) => { row.status = e.target.value; } },
            Object.entries(BASELINE_STATUS_LABEL).map(([value, label]) => el("option", { value, selected: value === row.status }, label))),
          el("input", { type: "text", value: row.note, placeholder: "差异说明", onchange: (e) => { row.note = e.target.value.trim(); } }),
          el("button", { class: "research-cell-remove", title: "删除行", onclick: () => { current.baselines.splice(index, 1); renderBaselines(); } }, "×"))),
        ...(current.baselines || []).length ? [] : [el("div", { class: "research-muted" }, "还没有基线对齐行。没有基线的研究可以不填。")],
      );
    };
    renderBaselines();
    const addBaselineBtn = el("button", {
      class: "tool-btn",
      onclick: () => {
        current.baselines = [...(current.baselines || []), { name: "", paperSetup: "", repoSetup: "", actualSetup: "", status: "unaligned", note: "" }];
        renderBaselines();
      },
    }, "加基线行");

    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const data = await requestJson(base() + "/protocols/" + current.id, {
            method: "PUT",
            body: {
              title: current.title,
              sourceNote: sourceInput.value.trim(),
              objective: objectiveInput.value.trim(),
              datasets: datasetsInput.value.trim(),
              metrics: metricsInput.value.trim(),
              budget: budgetInput.value.trim(),
              baselines: current.baselines,
              status: "draft",
              revision: current.revision,
            },
          });
          current = data.protocol;
          toast("方案已保存为草稿" + (baselineGapCount(current) ? "；存在未解决基线差异" : ""));
          renderEditor();
        } catch (e) {
          toast(e.message, true);
        } finally { saveBtn.disabled = false; }
      },
    }, "保存草稿");

    const createExpBtn = el("button", {
      class: "tool-btn",
      title: "在实验台账建立关联本方案的实验",
      onclick: async () => {
        try {
          await requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/experiments", {
            method: "POST",
            body: { title: current.title, purpose: current.objective || "", protocolId: current.id },
          });
          toast("实验已创建并关联本方案（revision " + current.revision + "）");
        } catch (e) { toast(e.message, true); }
      },
    }, "创建关联实验");
    const freezeReason = el("input", { type: "text", placeholder: "冻结理由（本轮为什么执行这个版本）" });
    const freezeBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        try {
          // 冻结前先落盘当前草稿，保证快照与页面一致。
          const saved = await requestJson(base() + "/protocols/" + current.id, {
            method: "PUT",
            body: {
              title: current.title,
              sourceNote: sourceInput.value.trim(),
              objective: objectiveInput.value.trim(),
              datasets: datasetsInput.value.trim(),
              metrics: metricsInput.value.trim(),
              budget: budgetInput.value.trim(),
              baselines: current.baselines,
              status: "draft",
              revision: current.revision,
            },
          });
          current = saved.protocol;
          const data = await requestJson(base() + "/protocols/" + current.id + "/freeze", {
            method: "POST",
            body: { reason: freezeReason.value.trim() },
          });
          current = data.protocol;
          freezeReason.value = "";
          toast("方案已冻结为版本 " + current.versions.length);
          renderEditor();
        } catch (e) { toast(e.message, true); }
      },
    }, "冻结为版本");

    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        titleInput,
        el("span", { class: "research-evidence-type" }, protocolStatusLabel(current.status)),
        saveBtn),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          field("验证目标", objectiveInput),
          field("数据与划分", datasetsInput),
          field("指标定义", metricsInput),
          field("预算与停止条件", budgetInput),
          field("方案来源", sourceInput)),
        el("div", { class: "research-card" },
          el("h4", {}, "基线对齐表（论文设置 / 仓库配置 / 实际条件）"),
          baselineRows,
          el("div", { class: "research-add-row" }, addBaselineBtn),
          el("div", { class: "research-add-row" }, freezeReason, freezeBtn),
          el("div", { class: "research-add-row" }, createExpBtn))),
      el("div", { class: "research-card" },
        el("h4", {}, "方案版本（冻结后的快照不会被后续修改改写）"),
        ...(current.versions || []).map((v) => el("div", { class: "research-timeline-item" },
          el("span", { class: "research-timeline-at" }, (v.frozenAt || "").slice(0, 16).replace("T", " ")),
          el("span", {}, "版本 " + v.index + "（revision " + v.revision + "）：" + v.reason))),
        ...(current.versions || []).length ? [] : [el("div", { class: "research-muted" }, "还没有冻结版本。执行前冻结一次，实验将引用这个快照。")]),
    );
  }

  async function openEditor(id) {
    try {
      current = (await requestJson(base() + "/protocols/" + id)).protocol;
      renderEditor();
    } catch (e) {
      toast(e.message, true);
    }
  }

  void refreshList();
  return { container, refresh: refreshList };
}
