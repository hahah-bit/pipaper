import { el, toast, askConfirm, askText } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";

// 投稿与修订台账（A10）：轮次、意见拆解与逐条处置；
// 只整理与登记材料，不自动登录投稿网站或发送任何回复。

export const SUBMISSION_STATUS_LABEL = {
  preparing: "准备中",
  submitted: "已提交",
  "under-review": "审稿中",
  revision: "修订中",
  accepted: "已录用",
  rejected: "已拒稿",
  withdrawn: "已撤稿",
};

export const COMMENT_CATEGORY_LABEL = {
  explain: "需解释",
  revise: "需修改",
  experiment: "补实验",
  other: "其他",
};

export const DISPOSITION_STATUS_LABEL = {
  pending: "待处理",
  done: "已处理",
  declined: "不采纳（有理由）",
};

export function submissionSection({ projectId }) {
  const container = el("div", { class: "research-submission" });
  let current = null;
  let manuscripts = [];
  // F11：处置引用对象缓存（运行/结论），标题用于可读显示。
  const refIndex = { runs: [], conclusions: [] };
  const refTitle = (kind, id) => {
    if (kind === "manuscript") return (manuscripts.find((m) => m.id === id) || {}).title;
    if (kind === "run") return (refIndex.runs.find((r) => r.id === id) || {}).label;
    if (kind === "conclusion") return ((refIndex.conclusions.find((c) => c.id === id) || {}).statement || "").slice(0, 30);
    return "";
  };
  async function loadRefIndex() {
    try {
      const [runs, conclusions] = await Promise.all([
        requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/runs"),
        requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/conclusions"),
      ]);
      refIndex.runs = runs.runs || [];
      refIndex.conclusions = conclusions.conclusions || [];
    } catch { /* 失败时对象选择器显示加载失败，不影响其他操作 */ }
  }
  async function dispositionRefOptions(kind) {
    if (!refIndex.runs.length && !refIndex.conclusions.length) await loadRefIndex();
    if (kind === "run")
      return refIndex.runs.map((r) => el("option", { value: r.id }, r.label + "（" + r.status + "）"));
    if (kind === "conclusion")
      return refIndex.conclusions.map((c) => el("option", { value: c.id }, (c.statement || "").slice(0, 34)));
    if (kind === "manuscript")
      return manuscripts.map((m) => el("option", { value: m.id }, m.title.slice(0, 34)));
    return [];
  }

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function refreshList() {
    current = null;
    let submissions = [];
    try {
      const [subs, ms] = await Promise.all([
        requestJson(base() + "/submissions"),
        requestJson(base() + "/manuscripts"),
      ]);
      submissions = subs.submissions || [];
      manuscripts = ms.manuscripts || [];
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "投稿记录加载失败：" + e.message));
      return;
    }
    const targetInput = el("input", { type: "text", placeholder: "投稿目标（期刊 / 会议）" });
    const manuscriptSelect = el("select", { class: "research-status-select" },
      el("option", { value: "" }, "关联稿件记录（可选）"),
      manuscripts.map((m) => el("option", { value: m.id }, m.title.slice(0, 30))));
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        if (!targetInput.value.trim()) return toast("请填写投稿目标", true);
        const maxRound = submissions.reduce((max, s) => Math.max(max, s.round || 1), 0);
        try {
          const data = await requestJson(base() + "/submissions", {
            method: "POST",
            body: { target: targetInput.value.trim(), manuscriptId: manuscriptSelect.value, round: maxRound + 1 },
          });
          toast("第 " + data.submission.round + " 轮投稿已登记（改投会新建轮次，不覆盖上一轮）");
          await openRound(data.submission.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "登记投稿轮次");
    container.replaceChildren(
      el("div", { class: "research-add-row" }, targetInput, manuscriptSelect, createBtn),
      el("div", { class: "research-muted" }, "平台只整理材料与记录处置；提交动作由你在投稿网站完成，回执日期手动登记。"),
      ...(submissions.length ? submissions.map((s) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-type" }, "第 " + s.round + " 轮"),
        el("span", { class: "research-evidence-content" }, s.target),
        el("span", { class: "research-muted" }, SUBMISSION_STATUS_LABEL[s.status] || s.status
          + (s.comments.length ? " · 意见 " + s.comments.length + " 条（待处理 " + s.comments.filter((c) => c.disposition.status === "pending").length + "）" : "")),
        el("button", { class: "tool-btn", onclick: () => void openRound(s.id) }, "打开"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            const ok = await askConfirm({ title: "删除投稿轮次", message: "删除「" + s.target + " 第 " + s.round + " 轮」？（进入回收站，可恢复）", okText: "删除", danger: true });
            if (!ok) return;
            try {
              await requestJson(base() + "/submissions/" + s.id, { method: "DELETE" });
              void refreshList();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "还没有投稿记录。")]),
    );
  }

  function renderEditor() {
    const statusSelect = el("select", { class: "research-status-select" },
      Object.entries(SUBMISSION_STATUS_LABEL).map(([value, label]) => el("option", { value, selected: value === current.status }, label)));
    const outcomeNote = el("input", { type: "text", value: current.outcomeNote || "", placeholder: "本轮结局说明（录用/拒稿/改投去向…）" });
    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const data = await requestJson(base() + "/submissions/" + current.id, {
            method: "PUT",
            body: {
              ...current,
              status: statusSelect.value,
              outcomeNote: outcomeNote.value.trim(),
              revision: current.revision,
            },
          });
          current = data.submission;
          toast("投稿轮次已保存");
          renderEditor();
        } catch (e) {
          toast(e.message, true);
        } finally { saveBtn.disabled = false; }
      },
    }, "保存轮次");

    const pasteBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const text = await askText({ title: "粘贴审稿意见", message: "按空行分段；每段拆解为一条待分类意见。只创建草稿，不会发送任何回复。", okText: "拆解导入" });
        if (!text) return;
        try {
          const data = await requestJson(base() + "/submissions/" + current.id + "/comments", { method: "POST", body: { text } });
          current = data.submission;
          toast("已拆解 " + data.submission.comments.length + " 条意见草稿");
          renderEditor();
        } catch (e) { toast(e.message, true); }
      },
    }, "粘贴拆解审稿意见");

    const commentList = el("div", {},
      ...(current.comments || []).map((comment, index) => {
        const categorySelect = el("select", { class: "research-status-select", onchange: (e) => { comment.category = e.target.value; } },
          Object.entries(COMMENT_CATEGORY_LABEL).map(([value, label]) => el("option", { value, selected: value === comment.category }, label)));
        const dispositionSelect = el("select", { class: "research-status-select", onchange: (e) => { comment.disposition.status = e.target.value; } },
          Object.entries(DISPOSITION_STATUS_LABEL).map(([value, label]) => el("option", { value, selected: value === comment.disposition.status }, label)));
        const noteInput = el("input", { type: "text", value: comment.disposition.note || "", placeholder: "处置说明（回复要点 / 修改位置 / 补实验）", onchange: (e) => { comment.disposition.note = e.target.value.trim(); } });
        const kindLabel = { run: "运行", conclusion: "结论", manuscript: "稿件" };
        const refBadges = comment.disposition.refs.map((ref, refIndex2) => el("span", { class: "research-evidence-type" },
          (kindLabel[ref.kind] || ref.kind) + " · " + (refTitle(ref.kind, ref.id) || ref.id.slice(0, 12)),
          el("button", {
            class: "research-cell-remove",
            onclick: () => { comment.disposition.refs.splice(refIndex2, 1); renderEditor(); },
          }, "×")));
        // F11：处置引用选择器——直接从项目内选择补实验运行、结论或稿件记录。
        const refKindSelect = el("select", { class: "research-status-select" },
          el("option", { value: "run" }, "补实验运行"),
          el("option", { value: "conclusion" }, "结论"),
          el("option", { value: "manuscript" }, "稿件"));
        const refObjectSelect = el("select", { class: "research-status-select" }, el("option", { value: "" }, "先选类型…"));
        refKindSelect.addEventListener("change", async () => {
          refObjectSelect.replaceChildren(el("option", { value: "" }, "加载中…"));
          try {
            const options = await dispositionRefOptions(refKindSelect.value);
            refObjectSelect.replaceChildren(el("option", { value: "" }, "选择对象…"), ...options);
          } catch {
            refObjectSelect.replaceChildren(el("option", { value: "" }, "加载失败"));
          }
        });
        const addRefBtn = el("button", {
          class: "tool-btn",
          onclick: () => {
            if (!refObjectSelect.value) return toast("先选择要引用的对象", true);
            if (comment.disposition.refs.some((r) => r.kind === refKindSelect.value && r.id === refObjectSelect.value))
              return toast("该引用已存在");
            comment.disposition.refs = [...comment.disposition.refs, { kind: refKindSelect.value, id: refObjectSelect.value }];
            renderEditor();
          },
        }, "关联处置成果");
        return el("div", { class: "research-card" },
          el("div", { class: "research-outcome-item" },
            el("span", { class: "research-evidence-content", title: comment.text }, comment.text.slice(0, 120)),
            categorySelect, dispositionSelect,
            el("button", {
              class: "research-cell-remove",
              onclick: () => { current.comments.splice(index, 1); renderEditor(); },
            }, "×")),
          el("div", { class: "research-add-row" }, noteInput),
          refBadges.length ? el("div", { class: "research-hypothesis-evidence" }, refBadges) : null,
          el("div", { class: "research-add-row" }, refKindSelect, refObjectSelect, addRefBtn));
      }),
      ...(current.comments || []).length ? [] : [el("div", { class: "research-muted" }, "还没有意见记录。收到审稿意见后粘贴拆解。")]);

    const materialsList = el("div", {},
      ...(current.materials || []).map((material, index) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-type" }, material.kind === "submitted" ? "已提交" : "准备中"),
        el("span", { class: "research-evidence-content" }, material.label + (material.note ? "（" + material.note + "）" : "")),
        el("button", {
          class: "research-cell-remove",
          title: "切换准备/已提交",
          onclick: () => { current.materials[index].kind = material.kind === "submitted" ? "prepared" : "submitted"; renderEditor(); },
        }, material.kind === "submitted" ? "↩" : "✓"),
        el("button", {
          class: "research-cell-remove",
          onclick: () => { current.materials.splice(index, 1); renderEditor(); },
        }, "×"))));
    const materialInput = el("input", { type: "text", placeholder: "材料名称，如：正文 PDF / 回复信" });
    const addMaterial = el("button", {
      class: "tool-btn",
      onclick: () => {
        if (!materialInput.value.trim()) return;
        current.materials = [...(current.materials || []), { label: materialInput.value.trim(), kind: "prepared", note: "" }];
        materialInput.value = "";
        renderEditor();
      },
    }, "添加材料");

    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        el("strong", {}, current.target + " · 第 " + current.round + " 轮"),
        statusSelect,
        saveBtn),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          el("h4", {}, "提交材料（准备完成与已提交分列）"),
          materialsList,
          el("div", { class: "research-add-row" }, materialInput, addMaterial)),
        el("div", { class: "research-card" },
          el("h4", {}, "时间与结局"),
          el("label", { class: "research-field" }, "准备完成",
            el("input", { type: "date", value: (current.dates.preparedAt || "").slice(0, 10), onchange: (e) => { current.dates.preparedAt = e.target.value; } })),
          el("label", { class: "research-field" }, "实际提交（回执日期）",
            el("input", { type: "date", value: (current.dates.submittedAt || "").slice(0, 10), onchange: (e) => { current.dates.submittedAt = e.target.value; } })),
          el("label", { class: "research-field" }, "收到结果",
            el("input", { type: "date", value: (current.dates.decisionAt || "").slice(0, 10), onchange: (e) => { current.dates.decisionAt = e.target.value; } })),
          outcomeNote)),
      el("div", { class: "research-card" },
        el("h4", {}, "审稿意见（" + current.comments.filter((c) => c.disposition.status === "pending").length + " 条待处理）"),
        el("div", { class: "research-add-row" }, pasteBtn),
        commentList),
    );
  }

  async function openRound(id) {
    try {
      current = (await requestJson(base() + "/submissions/" + id)).submission;
      renderEditor();
    } catch (e) {
      toast(e.message, true);
    }
  }

  void refreshList();
  return { container, refresh: refreshList };
}
