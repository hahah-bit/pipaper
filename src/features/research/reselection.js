import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";

// 二次选题（A09）：从已有成果出发整理下一轮方向；
// 输入快照固定当时的记录摘要，新方向必须注明依据，回写只创建新草稿。

export const RESELECTION_CHOICE_LABEL = {
  continue: "继续原方向",
  shrink: "收缩范围",
  pivot: "转向新方向",
  stop: "停止研究",
};

export const OPEN_QUESTION_CATEGORY_LABEL = {
  open: "未解",
  failed: "失败相关",
  "insufficient-evidence": "证据不足",
  new: "新出现",
};

export function reselectionSection({ projectId }) {
  const container = el("div", { class: "research-reselection" });
  let current = null;
  let sources = { hypotheses: [], conclusions: [], runs: [], matrices: [], protocols: [], comparisons: [] };

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function loadSources() {
    const [h, c, r, m, p, cmp] = await Promise.all([
      requestJson(base() + "/hypotheses").catch(() => ({ hypotheses: [] })),
      requestJson(base() + "/conclusions").catch(() => ({ conclusions: [] })),
      requestJson(base() + "/runs").catch(() => ({ runs: [] })),
      requestJson(base() + "/matrices").catch(() => ({ matrices: [] })),
      requestJson(base() + "/protocols").catch(() => ({ protocols: [] })),
      requestJson(base() + "/comparisons").catch(() => ({ comparisons: [] })),
    ]);
    sources = {
      hypotheses: h.hypotheses || [],
      conclusions: c.conclusions || [],
      runs: r.runs || [],
      matrices: m.matrices || [],
      protocols: p.protocols || [],
      comparisons: cmp.comparisons || [],
    };
  }

  const sourceOptions = () => [
    ...sources.hypotheses.map((x) => ({ kind: "hypothesis", id: x.id, label: "假设 · " + (x.title || "").slice(0, 30) })),
    ...sources.conclusions.map((x) => ({ kind: "conclusion", id: x.id, label: "结论 · " + (x.statement || "").slice(0, 30) })),
    ...sources.runs.map((x) => ({ kind: "run", id: x.id, label: "运行 · " + x.label + "（" + x.status + "）" })),
    ...sources.matrices.map((x) => ({ kind: "matrix", id: x.id, label: "对比表 · " + (x.title || "").slice(0, 26) })),
    ...sources.protocols.map((x) => ({ kind: "protocol", id: x.id, label: "方案 · " + (x.title || "").slice(0, 28) })),
    ...sources.comparisons.map((x) => ({ kind: "comparison", id: x.id, label: "比较 · " + (x.title || "").slice(0, 28) })),
  ];

  async function refreshList() {
    current = null;
    let records = [];
    try {
      records = (await requestJson(base() + "/reselections")).reselections || [];
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "二次选题加载失败：" + e.message));
      return;
    }
    const titleInput = el("input", { type: "text", placeholder: "新一轮方向分析标题" });
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const title = titleInput.value.trim();
        if (!title) return toast("请填写标题", true);
        try {
          const data = await requestJson(base() + "/reselections", { method: "POST", body: { title } });
          toast("二次选题已创建，先选择本轮分析的已有成果");
          await openRecord(data.reselection.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "开始二次选题");
    container.replaceChildren(
      el("div", { class: "research-add-row" }, titleInput, createBtn),
      el("div", { class: "research-muted" }, "与初次选题独立：从已有结论、失败实验与对比差距出发整理下一轮方向；原选题报告与默认规则不变。"),
      ...(records.length ? records.map((record) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-content" }, "🧭 " + record.title),
        el("span", { class: "research-muted" },
          (RESELECTION_CHOICE_LABEL[record.decision?.choice] || "未决定") + " · 候选 " + (record.candidates || []).length),
        el("button", { class: "tool-btn", onclick: () => void openRecord(record.id) }, "打开"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            const ok = await askConfirm({ title: "删除二次选题记录", message: "删除「" + record.title + "」？（进入回收站，可恢复；已建立的草稿不受影响）", okText: "删除", danger: true });
            if (!ok) return;
            try {
              await requestJson(base() + "/reselections/" + record.id, { method: "DELETE" });
              void refreshList();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "还没有二次选题记录。")]),
    );
  }

  // F10：新添加的候选只有前端数组、尚无服务端 ID；交接动作先保存整份记录
  // 取得 ID 再建草稿，避免「候选方向不存在」；失败时保留当前编辑状态。
  let busySaving = false;
  async function saveAndDraft(candidateIndex, target) {
    if (busySaving) return;
    busySaving = true;
    renderEditor();
    try {
      const saved = await requestJson(base() + "/reselections/" + current.id, {
        method: "PUT",
        body: {
          title: current.title,
          note: current.note || "",
          contextRefs: current.contextRefs,
          openQuestions: current.openQuestions,
          candidates: current.candidates,
          decision: current.decision,
          revision: current.revision,
        },
      });
      current = saved.reselection;
      const candidate = current.candidates[candidateIndex];
      if (!candidate) throw new Error("候选保存后丢失，请重试");
      await requestJson(base() + "/reselections/" + current.id + "/draft", {
        method: "POST",
        body: { candidateId: candidate.id, target },
      });
      toast(target === "protocol" ? "已从候选建立方案草稿（在「研究方案」中查看）" : "已从候选建立假设草稿（在「想法与假设」中查看）");
      await openRecord(current.id);
    } catch (e) {
      toast(e.message, true);
    } finally {
      busySaving = false;
      renderEditor();
    }
  }

  function renderEditor() {
    const addContextRow = () => {
      const options = sourceOptions().filter((o) => !current.contextRefs.some((ref) => ref.kind === o.kind && ref.id === o.id));
      const select = el("select", { class: "research-status-select" },
        el("option", { value: "" }, "选择已有成果…"),
        options.map((o) => el("option", { value: o.kind + ":" + o.id }, o.label)));
      const addBtn = el("button", {
        class: "tool-btn",
        onclick: () => {
          if (!select.value) return;
          const [kind, id] = select.value.split(/:(.+)/);
          current.contextRefs.push({ kind, id });
          renderEditor();
        },
      }, "加入输入");
      return el("div", { class: "research-add-row" }, select, addBtn);
    };

    const contextList = el("div", { class: "research-hypothesis-evidence" },
      ...(current.contextRefs || []).map((ref, index) => {
        const snapshot = (current.contextSnapshot || []).find((s) => s.kind === ref.kind && s.id === ref.id);
        const title = snapshot
          ? (snapshot.summary.title || snapshot.summary.label || snapshot.summary.statement || "").slice(0, 40)
          : ref.kind + " " + ref.id;
        return el("span", { class: "research-evidence-type" }, ({ hypothesis: "假设", conclusion: "结论", run: "运行", matrix: "对比表", protocol: "方案", comparison: "比较" }[ref.kind]) + " · " + title,
          el("button", {
            class: "research-cell-remove",
            onclick: () => { current.contextRefs.splice(index, 1); renderEditor(); },
          }, "×"));
      }),
      ...(current.contextRefs || []).length ? [] : [el("span", { class: "research-muted" }, "尚未选择输入")]);

    const questionInput = el("input", { type: "text", placeholder: "未解问题…" });
    const questionCategory = el("select", { class: "research-status-select" },
      Object.entries(OPEN_QUESTION_CATEGORY_LABEL).map(([value, label]) => el("option", { value }, label)));
    const addQuestion = el("button", {
      class: "tool-btn",
      onclick: () => {
        const text = questionInput.value.trim();
        if (!text) return;
        current.openQuestions = [...(current.openQuestions || []), { text, category: questionCategory.value }];
        questionInput.value = "";
        renderEditor();
      },
    }, "添加问题");
    const questionList = el("div", {},
      ...(current.openQuestions || []).map((question, index) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-type" }, OPEN_QUESTION_CATEGORY_LABEL[question.category] || question.category),
        el("span", { class: "research-evidence-content" }, question.text),
        el("button", {
          class: "research-cell-remove",
          onclick: () => { current.openQuestions.splice(index, 1); renderEditor(); },
        }, "×"))));

    const candidateText = el("input", { type: "text", placeholder: "候选方向…" });
    const candidateRationale = el("input", { type: "text", placeholder: "与旧工作的关系（依据）" });
    const candidateVerification = el("input", { type: "text", placeholder: "验证动作" });
    const addCandidate = el("button", {
      class: "tool-btn",
      onclick: () => {
        const text = candidateText.value.trim();
        if (!text) return toast("候选方向不能为空", true);
        current.candidates = [...(current.candidates || []), {
          text,
          rationale: candidateRationale.value.trim(),
          verification: candidateVerification.value.trim(),
          basedOn: current.contextRefs.slice(0, 10),
        }];
        candidateText.value = candidateRationale.value = candidateVerification.value = "";
        renderEditor();
      },
    }, "添加候选");
    const candidateList = el("div", {},
      ...(current.candidates || []).map((candidate, index) => el("div", { class: "research-card" },
        el("div", { class: "research-outcome-item" },
          el("span", { class: "research-evidence-content", title: candidate.rationale }, candidate.text),
          el("button", {
            class: "research-cell-remove",
            onclick: () => { current.candidates.splice(index, 1); renderEditor(); },
          }, "×")),
        candidate.rationale ? el("div", { class: "research-muted" }, "依据：" + candidate.rationale) : null,
        candidate.verification ? el("div", { class: "research-muted" }, "验证：" + candidate.verification) : null,
        el("div", { class: "research-add-row" },
          candidate.createdHypothesisId || candidate.createdProtocolId
            ? el("span", { class: "research-evidence-type" },
                candidate.createdHypothesisId ? "已建假设草稿 " + candidate.createdHypothesisId : "已建方案草稿 " + candidate.createdProtocolId)
            : el("button", {
                class: "tool-btn",
                disabled: busySaving ? true : null,
                onclick: async () => { await saveAndDraft(index, "hypothesis"); },
              }, "建立假设草稿"),
          !candidate.createdHypothesisId && !candidate.createdProtocolId
            ? el("button", {
                class: "tool-btn",
                disabled: busySaving ? true : null,
                onclick: async () => { await saveAndDraft(index, "protocol"); },
              }, "建立方案草稿")
            : null))));

    const choiceSelect = el("select", { class: "research-status-select" },
      Object.entries(RESELECTION_CHOICE_LABEL).map(([value, label]) => el("option", { value }, label)));
    const reasonInput = el("input", { type: "text", placeholder: "决定理由" });
    const decideBtn = el("button", {
      class: "tool-btn",
      onclick: () => {
        current.decision = { choice: choiceSelect.value, reason: reasonInput.value.trim() };
        renderEditor();
      },
    }, "记录决定");

    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const data = await requestJson(base() + "/reselections/" + current.id, {
            method: "PUT",
            body: {
              title: current.title,
              note: current.note || "",
              contextRefs: current.contextRefs,
              openQuestions: current.openQuestions,
              candidates: current.candidates,
              decision: current.decision,
              revision: current.revision,
            },
          });
          current = data.reselection;
          toast("二次选题已保存");
          renderEditor();
        } catch (e) {
          toast(e.message, true);
        } finally { saveBtn.disabled = false; }
      },
    }, "保存");

    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        el("input", { type: "text", class: "research-matrix-title", value: current.title, onchange: (e) => { current.title = e.target.value.trim() || current.title; } }),
        saveBtn),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          el("h4", {}, "本轮输入（保存时固定为快照摘要）"),
          contextList,
          addContextRow()),
        el("div", { class: "research-card" },
          el("h4", {}, "未解问题"),
          el("div", { class: "research-add-row" }, questionCategory, questionInput, addQuestion),
          questionList)),
      el("div", { class: "research-card" },
        el("h4", {}, "候选方向（须注明依据；可回写为新草稿）"),
        candidateList,
        el("div", { class: "research-add-row" }, candidateText),
        el("div", { class: "research-add-row" }, candidateRationale),
        el("div", { class: "research-add-row" }, candidateVerification, addCandidate)),
      el("div", { class: "research-card" },
        el("h4", {}, "研究决定"),
        current.decision ? el("div", { class: "research-muted" },
          (RESELECTION_CHOICE_LABEL[current.decision.choice] || current.decision.choice) + (current.decision.reason ? " — " + current.decision.reason : "")) : null,
        el("div", { class: "research-add-row" }, choiceSelect, reasonInput, decideBtn)),
    );
  }

  async function openRecord(id) {
    try {
      await loadSources();
      current = (await requestJson(base() + "/reselections/" + id)).reselection;
      renderEditor();
    } catch (e) {
      toast(e.message, true);
    }
  }

  void refreshList();
  return { container, refresh: refreshList };
}
