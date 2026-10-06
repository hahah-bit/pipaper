import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";
import { state } from "../../shell/state.js";

// 实验台账（A05）：登记实际执行；导入只解析用户选定文件，
// 不执行任何脚本；重复行先在预览中标注，由用户决定是否登记。

export const RUN_STATUS_LABEL = { succeeded: "成功", failed: "失败", stopped: "中止", incomplete: "不完整" };
export const RUN_RELATION_LABEL = { retry: "重试", resume: "续跑", variant: "变体" };

export function runStatusLabel(status) {
  return RUN_STATUS_LABEL[status] || status || "不完整";
}

// 极简 CSV 解析：支持引号内逗号/换行/双引号转义。
export function parseCsv(text) {
  const table = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) table.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) table.push(row);
  if (!table.length) return { columns: [], rows: [] };
  const columns = table[0].map((c) => c.trim()).filter(Boolean);
  const rows = table.slice(1).map((cells) => Object.fromEntries(columns.map((c, i) => [c, (cells[i] ?? "").trim()])));
  return { columns, rows };
}

export function parseDataFile(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const columns = [...new Set(value.flatMap((item) => Object.keys(item)))];
      const rows = value.map((item) => Object.fromEntries(columns.map((c) => [c, item[c] == null ? "" : String(item[c])])));
      return { columns, rows };
    }
  } catch { /* fall through to CSV */ }
  return parseCsv(text);
}

function metricsFromRow(row, metricColumns, sourceName) {
  return metricColumns.map((column) => ({
    name: column,
    value: Number(row[column]),
    unit: "",
    source: sourceName + ":" + column + " 列",
  })).filter((metric) => Number.isFinite(metric.value));
}

export function labSection({ projectId }) {
  const container = el("div", { class: "research-lab" });
  let current = null; // 当前实验
  let runs = [];

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function refreshList() {
    current = null;
    let experiments = [];
    try {
      experiments = (await requestJson(base() + "/experiments")).experiments || [];
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "实验加载失败：" + e.message));
      return;
    }
    const titleInput = el("input", { type: "text", placeholder: "新实验标题，如：掩码修正对比" });
    const purposeInput = el("input", { type: "text", placeholder: "实验目的（可选）" });
    const createBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        const title = titleInput.value.trim();
        if (!title) return toast("请填写实验标题", true);
        try {
          const data = await requestJson(base() + "/experiments", { method: "POST", body: { title, purpose: purposeInput.value.trim() } });
          toast("实验已创建；支持直接导入，不要求先完成研究方案");
          await openExperiment(data.experiment.id);
        } catch (e) { toast(e.message, true); }
      },
    }, "建立实验");
    container.replaceChildren(
      el("div", { class: "research-add-row" }, titleInput, purposeInput, createBtn),
      ...(experiments.length ? experiments.map((exp) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-content", title: exp.purpose || "" }, "🧪 " + exp.title),
        el("button", { class: "tool-btn", onclick: () => void openExperiment(exp.id) }, "打开"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            const ok = await askConfirm({ title: "删除实验", message: "删除「" + exp.title + "」？（只删实验本身，运行记录保留在台账中）", okText: "删除", danger: true });
            if (!ok) return;
            try {
              await requestJson(base() + "/experiments/" + exp.id, { method: "DELETE" });
              void refreshList();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "还没有实验。在原有环境跑完的实验可以在这里登记或导入结果。")]),
    );
  }

  async function refreshRuns() {
    try {
      runs = (await requestJson(base() + "/runs?experimentId=" + current.id)).runs || [];
    } catch { runs = []; }
  }

  function openRunDialog(existingRun) {
    const statusSelect = el("select", { class: "research-status-select" },
      Object.entries(RUN_STATUS_LABEL).map(([value, label]) => el("option", { value, selected: value === (existingRun?.status || "succeeded") }, label)));
    const labelInput = el("input", { type: "text", value: existingRun?.label || "", placeholder: "运行标识，如：尝试2-续跑" });
    const metricRows = el("div", { class: "research-metric-rows" });
    const addMetricRow = (metric = { name: "", value: "", unit: "", source: "" }) => {
      const name = el("input", { type: "text", value: metric.name, placeholder: "指标名" });
      const value = el("input", { type: "text", value: metric.value, placeholder: "数值" });
      const unit = el("input", { type: "text", value: metric.unit, placeholder: "单位" });
      const source = el("input", { type: "text", value: metric.source, placeholder: "来源（列名 / 位置）" });
      const row = el("div", { class: "research-metric-row" }, name, value, unit, source,
        el("button", { class: "research-cell-remove", onclick: () => row.remove() }, "×"));
      metricRows.append(row);
    };
    (existingRun?.metrics?.length ? existingRun.metrics : [{ name: "", value: "", unit: "", source: "" }]).forEach(addMetricRow);
    const errorInput = el("textarea", { rows: "2", placeholder: "失败 / 中止原因（成功可不填）" }, existingRun?.error || "");
    const configRow = (key, placeholder) => el("input", { type: "text", value: existingRun?.config?.[key] || "", placeholder, datasetKey: key });
    const relationType = el("select", { class: "research-status-select" },
      el("option", { value: "" }, "无关系"),
      ...Object.entries(RUN_RELATION_LABEL).map(([value, label]) => el("option", { value, selected: value === existingRun?.relation?.type }, label)));
    const relationRun = el("select", { class: "research-status-select" },
      el("option", { value: "" }, "选择关联运行…"),
      ...runs.filter((r) => r.id !== existingRun?.id).map((r) => el("option", { value: r.id, selected: r.id === existingRun?.relation?.ofRunId }, r.label)));
    const dlg = el("dialog", { class: "native-dialog ask-dialog research-run-dialog" },
      el("header", {}, el("strong", {}, existingRun ? "编辑运行" : "登记运行")),
      el("div", { class: "native-dialog-body" },
        el("div", { class: "research-add-row" }, labelInput, statusSelect),
        el("div", { class: "research-muted" }, "配置（未记录的保持空白，不会猜测）"),
        configRow("code", "代码版本 / commit"), configRow("data", "数据与划分"),
        configRow("environment", "环境（GPU / 依赖）"), configRow("seed", "随机种子"), configRow("notes", "备注"),
        el("div", { class: "research-muted" }, "指标"),
        metricRows,
        el("button", { class: "tool-btn", onclick: () => addMetricRow() }, "加指标"),
        el("div", { class: "research-muted" }, "失败与关系"),
        errorInput,
        el("div", { class: "research-add-row" }, relationType, relationRun)),
      el("div", { class: "dlg-btnrow" },
        el("button", { class: "tool-btn", onclick: () => dlg.close() }, "取消"),
        el("button", {
          class: "tool-btn primary",
          onclick: async () => {
            const metrics = [...metricRows.querySelectorAll(".research-metric-row")]
              .map((row) => {
                const inputs = row.querySelectorAll("input");
                return { name: inputs[0].value.trim(), value: Number(inputs[1].value), unit: inputs[2].value.trim(), source: inputs[3].value.trim() };
              })
              .filter((metric) => metric.name && Number.isFinite(metric.value));
            const config = {};
            for (const input of dlg.querySelectorAll("input[datasetKey]")) config[input.datasetKey || input.getAttribute("datasetKey")] = input.value.trim();
            try {
              const body = {
                label: labelInput.value.trim(),
                experimentId: current.id,
                status: statusSelect.value,
                config,
                metrics,
                error: errorInput.value.trim(),
                relation: relationType.value ? { type: relationType.value, ofRunId: relationRun.value } : undefined,
                revision: existingRun?.revision,
              };
              if (existingRun) await requestJson(base() + "/runs/" + existingRun.id, { method: "PUT", body });
              else await requestJson(base() + "/runs", { method: "POST", body });
              dlg.close();
              await refreshRuns();
              renderExperiment();
            } catch (e) { toast(e.message, true); }
          },
        }, "保存运行")),
    );
    document.body.append(dlg);
    dlg.showModal();
  }

  function openImportDialog() {
    let parsed = null;
    const existingLabels = new Set(runs.map((r) => r.label));
    const fileInput = el("input", {
      type: "file", accept: ".csv,.json,text/csv,application/json",
      onchange: async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
          parsed = { name: file.name, ...parseDataFile(await file.text()) };
          renderPreview();
        } catch (e) {
          previewBox.replaceChildren(el("div", { class: "research-muted" }, "文件解析失败：" + e.message));
        }
      },
    });
    const previewBox = el("div", { class: "research-muted" }, "选择 CSV 或 JSON 文件（每行一次运行；只读取该文件，不执行任何脚本）");
    const controls = el("div");
    const mapping = { label: "", status: "", metrics: new Set() };
    const confirmBtn = el("button", {
      class: "tool-btn primary", disabled: true,
      onclick: async () => {
        if (!parsed) return;
        const rows = parsed.rows.map((row, index) => ({
          index,
          label: mapping.label ? row[mapping.label] : "导入-" + (index + 1),
          status: mapping.status ? (RUN_STATUS_LABEL[row[mapping.status]] ? { 成功: "succeeded", 失败: "failed", 中止: "stopped", 不完整: "incomplete" }[row[mapping.status]] : String(row[mapping.status] || "").toLowerCase()) : "succeeded",
          metrics: metricsFromRow(row, [...mapping.metrics], parsed.name),
          duplicate: mapping.label && existingLabels.has(row[mapping.label]),
        }));
        confirmBtn.disabled = true;
        let createdCount = 0;
        const failures = [];
        for (const item of rows) {
          if (!item.label) continue;
          try {
            await requestJson(base() + "/runs", {
              method: "POST",
              body: { label: item.label, experimentId: current.id, status: item.status, imported: true, metrics: item.metrics },
            });
            createdCount++;
          } catch (e) {
            failures.push(item.label + "：" + e.message);
          }
        }
        dlg.close();
        await refreshRuns();
        renderExperiment();
        toast("导入完成：" + createdCount + " 条运行" + (failures.length ? "；失败 " + failures.length + " 条（见控制台）" : ""));
        for (const message of failures) console.warn("[research-import]", message);
      },
    }, "确认导入");
    const renderPreview = () => {
      if (!parsed) return;
      const columns = parsed.columns;
      const checkbox = (column) => el("label", { class: "research-field" },
        el("span", {}, column), el("input", {
          type: "checkbox",
          onchange: (e) => {
            if (e.target.checked) mapping.metrics.add(column);
            else mapping.metrics.delete(column);
            confirmBtn.disabled = false;
          },
        }));
      controls.replaceChildren(
        el("div", { class: "research-add-row" },
          el("label", { class: "research-field" }, "运行标识列",
            el("select", { class: "research-status-select", onchange: (e) => { mapping.label = e.target.value; confirmBtn.disabled = false; } },
              el("option", { value: "" }, "自动编号"),
              columns.map((c) => el("option", { value: c }, c)))),
          el("label", { class: "research-field" }, "状态列（成功/失败…）",
            el("select", { class: "research-status-select", onchange: (e) => { mapping.status = e.target.value; } },
              el("option", { value: "" }, "全部记为成功"),
              columns.map((c) => el("option", { value: c }, c)))),
          el("div", { class: "research-field" }, "指标列", el("div", { class: "research-hypothesis-evidence" }, columns.map(checkbox)))),
        el("div", { class: "research-muted" },
          "共 " + parsed.rows.length + " 行。已存在的运行标识：" + ([...existingLabels].join("、") || "无") + "；重复行会按原样再登记一条，可在确认前改用其他标识列。"),
      );
      previewBox.replaceChildren(el("table", { class: "research-matrix-table" },
        el("thead", {}, el("tr", {}, columns.map((c) => el("th", {}, c)))),
        el("tbody", {}, parsed.rows.slice(0, 5).map((row) => el("tr", {}, columns.map((c) => el("td", {}, row[c] ?? "")))))));
    };
    const dlg = el("dialog", { class: "native-dialog ask-dialog research-run-dialog" },
      el("header", {}, el("strong", {}, "从 CSV / JSON 导入运行")),
      el("div", { class: "native-dialog-body" },
        fileInput, previewBox, controls),
      el("div", { class: "dlg-btnrow" },
        el("button", { class: "tool-btn", onclick: () => dlg.close() }, "取消"),
        confirmBtn),
    );
    document.body.append(dlg);
    dlg.showModal();
  }

  function renderExperiment() {
    const runsBox = el("div");
    runsBox.replaceChildren(
      ...(runs.length ? runs.map((run) => el("div", { class: "research-outcome-item" },
        el("span", { class: "research-evidence-type research-run-status-" + run.status }, runStatusLabel(run.status)),
        el("span", { class: "research-evidence-content", title: run.label }, run.label
          + (run.relation ? "（" + (RUN_RELATION_LABEL[run.relation.type] || run.relation.type) + "）" : "")),
        el("span", { class: "research-muted", title: (run.metrics || []).map((m) => m.name + "=" + m.value + (m.source ? " (" + m.source + ")" : "")).join("\n") },
          (run.metrics || []).slice(0, 3).map((m) => m.name + "=" + m.value).join(" · ")
          + ((run.metrics || []).length > 3 ? " …" : "")
          + (run.error ? " ⚠ " + run.error.slice(0, 30) : "")),
        el("button", { class: "tool-btn", onclick: () => openRunDialog(run) }, "编辑"),
        el("button", {
          class: "tool-btn danger",
          onclick: async () => {
            try {
              await requestJson(base() + "/runs/" + run.id, { method: "DELETE" });
              await refreshRuns();
              renderExperiment();
            } catch (e) { toast(e.message, true); }
          },
        }, "删除")))
      : [el("div", { class: "research-muted" }, "该实验还没有运行记录。手动登记或从 CSV / JSON 导入。")]),
    );
    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        el("strong", {}, current.title),
        el("button", { class: "tool-btn primary", onclick: () => openRunDialog(null) }, "登记运行"),
        el("button", { class: "tool-btn", onclick: () => openImportDialog() }, "导入 CSV / JSON")),
      current.purpose ? el("div", { class: "research-muted" }, "目的：" + current.purpose) : null,
      runsBox,
    );
  }

  async function openExperiment(id) {
    try {
      current = (await requestJson(base() + "/experiments/" + id)).experiment;
      await refreshRuns();
      renderExperiment();
    } catch (e) {
      toast(e.message, true);
    }
  }

  void refreshList();
  return { container, refresh: refreshList };
}
