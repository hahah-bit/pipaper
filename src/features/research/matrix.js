import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";
import { state } from "../../shell/state.js";
import { selectPaper } from "../../sidebar.js";

// 文献对比表（A02.3—A02.6）：单元格值必须能区分零值、未报告、未核对与不适用，
// 并可附来源；导出为 Markdown 时保留这些标记，方便进入稿件或假设记录。

export const CELL_STATUS_LABEL = {
  value: "值",
  zero: "零值",
  "not-reported": "未报告",
  unverified: "未核对",
  "not-applicable": "不适用",
};

export const cellKey = (paperId, columnId) => paperId + "|" + columnId;

const escapeCell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function toMarkdown(matrix, titleOf = (id) => id) {
  const head = ["论文", ...matrix.columns.map((c) => c.name)];
  const lines = [
    "## " + matrix.title,
    ...(matrix.conditions ? ["", "> 比较条件说明：" + matrix.conditions] : []),
    "",
    "| " + head.map(escapeCell).join(" | ") + " |",
    "| " + head.map(() => "---").join(" | ") + " |",
  ];
  for (const paperId of matrix.paperIds) {
    const row = [titleOf(paperId)];
    for (const column of matrix.columns) {
      const cell = matrix.cells?.[cellKey(paperId, column.id)] || {};
      const status = CELL_STATUS_LABEL[cell.status] || "";
      const parts = [];
      if (cell.value) parts.push(cell.value);
      if (cell.status && cell.status !== "value") parts.push("（" + status + "）");
      if (cell.aiCandidate) parts.push("[AI 候选]");
      if (cell.sourceLabel) parts.push("[" + cell.sourceLabel + (cell.page ? " 第" + cell.page + "页" : "") + "]");
      row.push(parts.join(" "));
    }
    lines.push("| " + row.map(escapeCell).join(" | ") + " |");
  }
  return lines.join("\n");
}

function downloadMarkdown(matrix, titleOf) {
  const blob = new Blob([toMarkdown(matrix, titleOf)], { type: "text/markdown;charset=utf-8" });
  const link = el("a", { href: URL.createObjectURL(blob), download: matrix.title.replace(/[\\/:*?"<>|]/g, "_") + ".md" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

function openCellDialog(matrix, paperId, columnId, onDone) {
  const key = cellKey(paperId, columnId);
  const cell = { value: "", status: "value", note: "", sourceLabel: "", page: null, aiCandidate: false, ...(matrix.cells[key] || {}) };
  const valueInput = el("textarea", { rows: "2", placeholder: "该单元格的值或说明" }, cell.value || "");
  const statusSelect = el("select", {},
    Object.entries(CELL_STATUS_LABEL).map(([value, label]) => el("option", { value, selected: value === cell.status }, label)));
  const sourceInput = el("input", { type: "text", value: cell.sourceLabel || "", placeholder: "来源（如：表2 / 第5节）" });
  const pageInput = el("input", { type: "number", min: "1", value: cell.page || "", placeholder: "页码" });
  const noteInput = el("input", { type: "text", value: cell.note || "", placeholder: "差异或补充说明" });
  const dlg = el("dialog", { class: "native-dialog ask-dialog" },
    el("header", {}, el("strong", {}, "编辑单元格")),
    el("div", { class: "native-dialog-body" },
      el("label", { class: "research-field" }, "值", valueInput),
      el("label", { class: "research-field" }, "状态（零值 / 未报告等不能与普通值混淆）", statusSelect),
      el("label", { class: "research-field" }, "来源", sourceInput),
      el("label", { class: "research-field" }, "页码", pageInput),
      el("label", { class: "research-field" }, "备注", noteInput)),
    el("div", { class: "dlg-btnrow" },
      el("button", { class: "tool-btn", onclick: () => dlg.close() }, "取消"),
      el("button", {
        class: "tool-btn primary",
        onclick: () => {
          matrix.cells[key] = {
            value: valueInput.value.trim(),
            status: statusSelect.value,
            note: noteInput.value.trim(),
            sourceLabel: sourceInput.value.trim(),
            page: pageInput.value ? Number(pageInput.value) : null,
            aiCandidate: cell.aiCandidate,
          };
          dlg.close();
          onDone();
        },
      }, "保存单元格")),
  );
  document.body.append(dlg);
  dlg.showModal();
}

export function matrixSection({ projectId, onChanged }) {
  // 列表视图与编辑视图共用一个容器；编辑时整体替换内容。
  const container = el("div", { class: "research-matrix" });
  let current = null; // 打开中的矩阵（本地编辑副本）

  const projectPapers = () => {
    const project = state.projects.find((p) => p.id === projectId);
    const ids = new Set(project?.paperIds || []);
    return state.papers.filter((p) => ids.has(p.id));
  };
  const titleOf = (paperId) => state.papers.find((p) => p.id === paperId)?.title || paperId;

  async function refreshList() {
    current = null;
    let matrices = [];
    try {
      matrices = (await requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/matrices")).matrices || [];
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "对比表加载失败：" + e.message));
      return;
    }
    const titleInput = el("input", { type: "text", placeholder: "新对比表标题，如：失败模式对比" });
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const title = titleInput.value.trim();
        if (!title) return toast("请填写对比表标题", true);
        try {
          const data = await requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/matrices", {
            method: "POST",
            body: { title, paperIds: [], columns: [], cells: {} },
          });
          toast("对比表已创建");
          openEditor(data.matrix);
        } catch (e) { toast(e.message, true); }
      },
    }, "新建对比表");
    container.replaceChildren(
      el("div", { class: "research-add-row" }, titleInput, createBtn),
      ...(matrices.length ? matrices.map((m) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-content", title: m.title }, "📋 " + m.title),
        el("span", { class: "research-muted" }, m.paperIds.length + " 篇 · " + m.columns.length + " 列"),
        el("button", { class: "tool-btn", onclick: () => openEditor(m) }, "打开"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            const ok = await askConfirm({ title: "删除对比表", message: "删除「" + m.title + "」？（进入回收站，可恢复）", okText: "删除", danger: true });
            if (!ok) return;
            try {
              await requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/matrices/" + m.id, { method: "DELETE" });
              void refreshList();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "还没有对比表。选择本项目论文，比较方法、数据与指标。")]),
    );
  }

  function renderEditor() {
    const papers = projectPapers();
    const paperSelect = el("select", { class: "research-project-select" },
      el("option", { value: "" }, "加入本项目论文…"),
      papers.filter((p) => !current.paperIds.includes(p.id)).map((p) => el("option", { value: p.id }, p.title || p.id)));
    const addPaperBtn = el("button", {
      class: "tool-btn",
      onclick: () => {
        if (!paperSelect.value || current.paperIds.includes(paperSelect.value)) return;
        current.paperIds.push(paperSelect.value);
        renderEditor();
      },
    }, "加入");
    const columnInput = el("input", { type: "text", placeholder: "新对比列，如：数据集 / 指标 / 条件" });
    const addColumnBtn = el("button", {
      class: "tool-btn",
      onclick: () => {
        const name = columnInput.value.trim();
        if (!name) return;
        current.columns.push({ id: "col_" + Date.now().toString(36), name });
        columnInput.value = "";
        renderEditor();
      },
    }, "加列");
    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          const data = await requestJson("/api/research/projects/" + encodeURIComponent(projectId) + "/matrices/" + current.id, {
            method: "PUT",
            body: {
              title: current.title,
              conditions: current.conditions,
              paperIds: current.paperIds,
              columns: current.columns,
              cells: current.cells,
              revision: current.revision,
            },
          });
          current = data.matrix;
          toast("对比表已保存");
          renderEditor();
          onChanged?.();
        } catch (e) {
          toast(e.message, true);
        } finally { saveBtn.disabled = false; }
      },
    }, "保存对比表");

    const table = el("table", { class: "research-matrix-table" },
      el("thead", {}, el("tr", {},
        el("th", {}, "论文"),
        ...current.columns.map((c) => el("th", {},
          el("span", {}, c.name),
          el("button", {
            class: "research-cell-remove",
            title: "删除列",
            onclick: () => {
              current.columns = current.columns.filter((x) => x.id !== c.id);
              renderEditor();
            },
          }, "×"))))),
      el("tbody", {},
        ...current.paperIds.map((paperId) => el("tr", {},
          el("th", { class: "research-matrix-paper" },
            el("span", { title: titleOf(paperId) }, titleOf(paperId)),
            el("span", { class: "research-matrix-paper-actions" },
              el("button", { class: "research-cell-remove", title: "查看原文", onclick: () => {
                const paper = state.papers.find((p) => p.id === paperId);
                if (paper) selectPaper(paper); else toast("论文不在当前文献列表中", true);
              } }, "原文"),
              el("button", { class: "research-cell-remove", title: "移出对比", onclick: () => {
                current.paperIds = current.paperIds.filter((x) => x !== paperId);
                renderEditor();
              } }, "×"))),
          ...current.columns.map((column) => {
            const cell = current.cells[cellKey(paperId, column.id)] || {};
            const text = cell.value || CELL_STATUS_LABEL[cell.status] || "";
            return el("td", {
              class: "research-matrix-cell research-cell-" + (cell.status || "empty"),
              title: [cell.value, cell.sourceLabel ? "来源：" + cell.sourceLabel : null, cell.note].filter(Boolean).join("\n"),
              onclick: () => openCellDialog(current, paperId, column.id, renderEditor),
            },
              text || el("span", { class: "research-muted" }, "点击填写"),
              cell.aiCandidate ? el("span", { class: "research-ai-mark", title: "AI 建议候选，可人工修改" }, "✦") : null);
          })))),
    );

    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        el("input", { type: "text", class: "research-matrix-title", value: current.title, onchange: (e) => { current.title = e.target.value.trim() || current.title; } }),
        saveBtn,
        el("button", { class: "tool-btn", onclick: () => downloadMarkdown(current, titleOf) }, "导出 Markdown")),
      el("input", {
        type: "text", class: "research-matrix-conditions", value: current.conditions || "",
        placeholder: "比较条件说明（数据划分、指标口径等不可比差异，会随导出保留）",
        onchange: (e) => { current.conditions = e.target.value.trim(); },
      }),
      el("div", { class: "research-add-row" }, paperSelect, addPaperBtn, columnInput, addColumnBtn),
      current.paperIds.length && current.columns.length ? table : el("div", { class: "research-muted" }, "先加入论文与对比列，再点击单元格填写带来源的值。"),
    );
  }

  function openEditor(matrix) {
    current = structuredClone(matrix);
    renderEditor();
  }

  void refreshList();
  return {
    container,
    refresh: refreshList,
  };
}
