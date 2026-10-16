import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";

// 比较与结论（A06）：从已登记运行组织可比较的结果并记录判断；
// 无法直接比较时并排保留并标注差异，不自动排行。

export const CONCLUSION_KIND_LABEL = {
  observation: "观察",
  exploratory: "探索性",
  supported: "得到支持",
  negative: "负结果",
};

export const CONCLUSION_KIND_CLASS = {
  observation: "research-cell-not-reported",
  exploratory: "research-cell-unverified",
  supported: "research-run-status-succeeded",
  negative: "research-run-status-failed",
};

export function comparisonSummary(comparison) {
  const values = (comparison?.rows || []).filter((row) => row.status === "value").map((row) => row.value);
  if (!values.length) return "无可比较值";
  return comparison.metricName + "：" + values.map((v) => String(v)).join(" / ");
}

export function findingsSection({ projectId }) {
  const container = el("div", { class: "research-findings" });
  let comparisons = [];
  let conclusions = [];
  let runs = [];

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function refreshAll() {
    try {
      const [cmp, con, runList] = await Promise.all([
        requestJson(base() + "/comparisons"),
        requestJson(base() + "/conclusions"),
        requestJson(base() + "/runs"),
      ]);
      comparisons = cmp.comparisons || [];
      conclusions = con.conclusions || [];
      runs = runList.runs || [];
      renderList();
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "比较与结论加载失败：" + e.message));
    }
  }

  const runOptions = (selected) => runs.map((run) =>
    el("option", { value: run.id, selected: selected.includes(run.id) }, run.label + "（" + run.status + "）"));

  function renderList() {
    const titleInput = el("input", { type: "text", placeholder: "新比较标题，如：基线 vs 修正 IoU" });
    const metricInput = el("input", { type: "text", placeholder: "比较指标名，如：iou" });
    const runSelect = el("select", { multiple: true, class: "research-run-multi" }, runOptions([]));
    const noteInput = el("input", { type: "text", placeholder: "纳入/排除理由与口径差异（可选）" });
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const runIds = [...runSelect.selectedOptions].map((o) => o.value);
        try {
          const data = await requestJson(base() + "/comparisons", {
            method: "POST",
            body: { title: titleInput.value.trim(), metricName: metricInput.value.trim(), runIds, inclusionNote: noteInput.value.trim() },
          });
          toast("比较快照已保存（值固定，不随后续运行变化）");
          await refreshAll();
          openComparison(data.comparison.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "保存比较快照");

    const conInput = el("input", { type: "text", placeholder: "新结论表述…" });
    const conKind = el("select", { class: "research-status-select" },
      Object.entries(CONCLUSION_KIND_LABEL).map(([value, label]) => el("option", { value }, label)));
    const conCreate = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const statement = conInput.value.trim();
        if (!statement) return toast("请填写结论表述", true);
        try {
          const data = await requestJson(base() + "/conclusions", { method: "POST", body: { statement, kind: conKind.value } });
          toast("结论卡已创建，可继续补充依据");
          await refreshAll();
          openConclusion(data.conclusion.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "登记结论");

    container.replaceChildren(
      el("div", { class: "research-card" },
        el("h4", {}, "比较选中运行（快照）"),
        el("div", { class: "research-add-row" }, titleInput, metricInput),
        el("div", { class: "research-add-row" }, runSelect, noteInput, createBtn),
        ...(comparisons.length ? comparisons.map((c) => el("div", { class: "research-outcome-item" },
          el("span", { class: "research-evidence-content", title: comparisonSummary(c) }, "📊 " + c.title),
          el("span", { class: "research-muted" }, comparisonSummary(c)),
          el("button", { class: "tool-btn", onclick: () => openComparison(c.id) }, "打开"),
          el("button", {
            class: "tool-btn danger",
            onclick: async () => {
              const ok = await askConfirm({ title: "删除比较", message: "删除「" + c.title + "」？（进入回收站，可恢复；结论中的引用保留原始 ID）", okText: "删除", danger: true });
              if (!ok) return;
              try {
                await requestJson(base() + "/comparisons/" + c.id, { method: "DELETE" });
                void refreshAll();
              } catch (e) { toast(e.message, true); }
            },
          }, "删除")))
        : [el("div", { class: "research-muted" }, runs.length ? "选择运行与指标保存比较快照；无法直接比较时在说明里标注差异。" : "先在实验台账登记或导入运行，再组织比较。")]),
        comparisons.length ? el("div", { class: "research-muted" }, "比较值是保存时刻的快照；运行更新不会改写，需要新结果请新建比较。") : null),
      el("div", { class: "research-card" },
        el("h4", {}, "结论与成果"),
        el("div", { class: "research-add-row" }, conKind, conInput, conCreate),
        ...(conclusions.length ? conclusions.map((item) => el("div", { class: "research-outcome-item" },
          el("span", { class: "research-evidence-type " + (CONCLUSION_KIND_CLASS[item.kind] || "") }, CONCLUSION_KIND_LABEL[item.kind] || item.kind),
          el("span", { class: "research-evidence-content", title: item.statement }, item.statement),
          el("span", { class: "research-muted" }, item.checked ? "已核对" : "未核对"),
          el("button", { class: "tool-btn", onclick: () => openConclusion(item.id) }, "打开"),
          el("button", {
            class: "tool-btn danger",
            onclick: async () => {
              const ok = await askConfirm({ title: "删除结论", message: "删除该结论卡？（进入回收站，可恢复）", okText: "删除", danger: true });
              if (!ok) return;
              try {
                await requestJson(base() + "/conclusions/" + item.id, { method: "DELETE" });
                void refreshAll();
              } catch (e) { toast(e.message, true); }
            },
          }, "删除")))
        : [el("div", { class: "research-muted" }, "还没有结论卡。负结果与探索性观察同样是研究成果，可以在此登记。")]),
      ),
    );
  }

  function openComparison(id) {
    const current = comparisons.find((c) => c.id === id);
    if (!current) return;
    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshAll() }, "← 返回"),
        el("strong", {}, current.title),
        el("span", { class: "research-muted" }, "指标：" + current.metricName)),
      current.inclusionNote || current.comparabilityNote
        ? el("div", { class: "research-muted" },
          (current.inclusionNote ? "纳入口径：" + current.inclusionNote + " " : "")
          + (current.comparabilityNote ? "口径差异：" + current.comparabilityNote : ""))
        : null,
      el("table", { class: "research-matrix-table" },
        el("thead", {}, el("tr", {}, ["运行", "状态", current.metricName, "来源", "快照时间"].map((h) => el("th", {}, h)))),
        el("tbody", {}, current.rows.map((row) => el("tr", {},
          el("td", {}, row.label),
          el("td", {}, row.runStatus),
          el("td", { class: "research-cell-" + (row.status === "value" ? "value" : "not-reported") },
            row.status === "value" ? String(row.value) + (row.unit || "") : "缺该指标"),
          el("td", {}, row.source || "—"),
          el("td", {}, (row.snapshottedAt || "").slice(0, 16).replace("T", " ")))))),
      el("div", { class: "research-muted" }, "快照时间 " + (current.rows[0]?.snapshottedAt || "").slice(0, 16).replace("T", " ") + "；需要新结果请另建比较。"),
    );
  }

  function openConclusion(id) {
    const current = conclusions.find((c) => c.id === id);
    if (!current) return;
    const statementInput = el("textarea", { rows: "2" }, current.statement || "");
    const kindSelect = el("select", { class: "research-status-select" },
      Object.entries(CONCLUSION_KIND_LABEL).map(([value, label]) => el("option", { value, selected: value === current.kind }, label)));
    const scopeInput = el("input", { type: "text", value: current.scope || "", placeholder: "适用范围" });
    const limitsInput = el("input", { type: "text", value: current.limits || "", placeholder: "限制与未确认部分" });
    const checkedBox = el("input", { type: "checkbox", checked: current.checked ? true : null });
    const supportList = el("div", { class: "research-hypothesis-evidence" },
      ...(current.support || []).map((ref, index) => el("span", { class: "research-evidence-type" },
        ({ run: "运行", comparison: "比较", evidence: "证据", hypothesis: "假设", matrix: "对比表", protocol: "方案" }[ref.kind] || ref.kind) + " · " + ref.id,
        el("button", {
          class: "research-cell-remove",
          onclick: () => { current.support.splice(index, 1); openConclusion(id); },
        }, "×"))),
      ...(current.support || []).length ? [] : [el("span", { class: "research-muted" }, "暂无依据引用")]);
    const kindSelectForAdd = el("select", { class: "research-status-select" },
      el("option", { value: "run" }, "运行"),
      el("option", { value: "comparison" }, "比较"),
      el("option", { value: "evidence" }, "证据"),
      el("option", { value: "hypothesis" }, "假设"),
      el("option", { value: "matrix" }, "对比表"),
      el("option", { value: "protocol" }, "方案"));
    const supportOptions = {
      run: () => runs.map((r) => el("option", { value: r.id }, r.label)),
      comparison: () => comparisons.map((c) => el("option", { value: c.id }, c.title)),
      evidence: async () => (await requestJson(base() + "/evidence")).evidence.map((e) => el("option", { value: e.id }, (e.content || "").slice(0, 24))),
      hypothesis: async () => (await requestJson(base() + "/hypotheses")).hypotheses.map((h) => el("option", { value: h.id }, h.title)),
      matrix: async () => (await requestJson(base() + "/matrices")).matrices.map((m) => el("option", { value: m.id }, m.title)),
      protocol: async () => (await requestJson(base() + "/protocols")).protocols.map((p) => el("option", { value: p.id }, p.title)),
    };
    const refIdSelect = el("select", { class: "research-status-select" }, el("option", { value: "" }, "先选类型"));
    kindSelectForAdd.addEventListener("change", async () => {
      const loader = supportOptions[kindSelectForAdd.value];
      refIdSelect.replaceChildren(el("option", { value: "" }, "加载中…"));
      try {
        refIdSelect.replaceChildren(el("option", { value: "" }, "选择对象…"), ...(loader ? await loader() : []));
      } catch {
        refIdSelect.replaceChildren(el("option", { value: "" }, "加载失败"));
      }
    });
    const addRefBtn = el("button", {
      class: "tool-btn",
      onclick: () => {
        if (!refIdSelect.value) return;
        current.support = [...(current.support || []), { kind: kindSelectForAdd.value, id: refIdSelect.value }];
        openConclusion(id);
      },
    }, "关联依据");
    const saveBtn = el("button", {
      class: "tool-btn primary",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          await requestJson(base() + "/conclusions/" + current.id, {
            method: "PUT",
            body: {
              statement: statementInput.value.trim(),
              kind: kindSelect.value,
              scope: scopeInput.value.trim(),
              limits: limitsInput.value.trim(),
              support: current.support,
              checked: checkedBox.checked,
              revision: current.revision,
            },
          });
          toast("结论已保存");
          await refreshAll();
        } catch (e) {
          toast(e.message, true);
          saveBtn.disabled = false;
        }
      },
    }, "保存结论");
    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshAll() }, "← 返回"),
        kindSelect,
        el("label", { class: "research-muted" }, "人工已核对 ", checkedBox),
        saveBtn),
      el("div", { class: "research-card" },
        el("div", { class: "research-field" }, "结论表述（区分观察、探索性与正式判断）", statementInput),
        el("div", { class: "research-field" }, "适用范围", scopeInput),
        el("div", { class: "research-field" }, "限制", limitsInput)),
      el("div", { class: "research-card" },
        el("h4", {}, "依据引用"),
        supportList,
        el("div", { class: "research-add-row" }, kindSelectForAdd, refIdSelect, addRefBtn)),
    );
  }

  void refreshAll();
  return { container, refresh: refreshAll };
}
