import { el, toast, askConfirm } from "../../platform/dom.js";
import { requestJson } from "../../platform/http.js";

// 写作引用助手（A07）：稿件登记、文献引用与结论关联；
// 编辑器仍按原方式打开文件，这里只管理引用与研究材料的对应关系。

export function citationStyleLabel(kind) {
  return kind === "latex" ? "\\cite{key}" : "[@key]";
}

export function writingSection({ projectId }) {
  const container = el("div", { class: "research-writing" });
  let current = null;
  let conclusions = [];

  const base = () => "/api/research/projects/" + encodeURIComponent(projectId);

  async function refreshList() {
    current = null;
    try {
      const [ms, con] = await Promise.all([
        requestJson(base() + "/manuscripts"),
        requestJson(base() + "/conclusions"),
      ]);
      conclusions = con.conclusions || [];
      const manuscripts = ms.manuscripts || [];
      const titleInput = el("input", { type: "text", placeholder: "稿件标题，如：CFM 失败模式分析" });
      const pathInput = el("input", { type: "text", placeholder: "写作区文件路径，如 papers/draft.md（原文件不动）" });
      const kindSelect = el("select", { class: "research-status-select" },
        el("option", { value: "markdown" }, "Markdown"),
        el("option", { value: "latex" }, "LaTeX"));
      const createBtn = el("button", {
        class: "tool-btn",
        onclick: async () => {
          const title = titleInput.value.trim();
          if (!title) return toast("请填写稿件标题", true);
          try {
            const data = await requestJson(base() + "/manuscripts", {
              method: "POST",
              body: { title, filePath: pathInput.value.trim(), fileKind: kindSelect.value },
            });
            toast("稿件已登记；文件仍按原方式编辑");
            await openManuscript(data.manuscript.id);
          } catch (e) { toast(e.message, true); }
        },
      }, "登记稿件");
      container.replaceChildren(
        el("div", { class: "research-add-row" }, titleInput, pathInput, kindSelect, createBtn),
        ...(manuscripts.length ? manuscripts.map((m) => el("div", { class: "research-outcome-item" },
          el("span", { class: "research-evidence-content", title: m.filePath || "" }, "📝 " + m.title),
          el("span", { class: "research-muted" }, (m.citations || []).length + " 条引用 · " + (m.snapshots || []).length + " 次快照"),
          el("button", { class: "tool-btn", onclick: () => void openManuscript(m.id) }, "打开"),
          el("button", {
            class: "tool-btn danger",
            onclick: async () => {
              const ok = await askConfirm({ title: "删除稿件记录", message: "删除「" + m.title + "」？（只删除登记记录，进入回收站可恢复；原文件不受影响）", okText: "删除", danger: true });
              if (!ok) return;
              try {
                await requestJson(base() + "/manuscripts/" + m.id, { method: "DELETE" });
                void refreshList();
              } catch (e) { toast(e.message, true); }
            },
          }, "删除")))
        : [el("div", { class: "research-muted" }, "还没有稿件记录。登记写作区文件后，可从这里选文献、导出书目并关联结论。")]),
      );
    } catch (e) {
      container.replaceChildren(el("div", { class: "research-muted" }, "稿件加载失败：" + e.message));
    }
  }

  async function refreshChecks(manuscriptId, box) {
    try {
      const checks = await (await requestJson(base() + "/manuscripts/" + manuscriptId + "/checks"));
      const problems = [
        ...checks.missing.map((key) => "缺失论文：" + key),
        ...checks.duplicates.map((key) => "重复引用键：" + key),
        ...checks.missingConclusions.map((id) => "失效结论关联：" + id),
      ];
      box.replaceChildren(
        problems.length
          ? problems.map((p) => el("div", { class: "research-timeline-item" }, el("span", { class: "research-run-status-failed" }, p)))
          : el("div", { class: "research-muted" }, "检查通过：" + checks.total + " 条引用无缺失、无重复键。"),
      );
    } catch (e) {
      box.replaceChildren(el("div", { class: "research-muted" }, "检查失败：" + e.message));
    }
  }

  async function openManuscript(id) {
    try {
      current = (await requestJson(base() + "/manuscripts/" + id)).manuscript;
      renderManuscript();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderManuscript() {
    const citeHint = el("div", { class: "research-muted" }, "正文引用格式：" + citationStyleLabel(current.fileKind) + "（复制后粘贴到稿件）");
    const citationList = el("div", { class: "research-hypothesis-evidence" },
      ...(current.citations || []).map((c) => el("span", { class: "research-evidence-type", title: c.title },
        c.key + " · " + (c.title || "").slice(0, 24),
        el("button", {
          class: "research-cell-remove", title: "复制引用标记",
          onclick: async () => {
            const marker = current.fileKind === "latex" ? "\\cite{" + c.key + "}" : "[@" + c.key + "]";
            try {
              await navigator.clipboard.writeText(marker);
              toast("已复制 " + marker);
            } catch { toast("复制失败，请手动复制：" + marker, true); }
          },
        }, "复制"),
        el("button", {
          class: "research-cell-remove", title: "移除引用",
          onclick: async () => {
            try {
              current = (await requestJson(base() + "/manuscripts/" + current.id + "/citations/" + encodeURIComponent(c.key), { method: "DELETE" })).manuscript;
              renderManuscript();
            } catch (e) { toast(e.message, true); }
          },
        }, "×"))),
      ...(current.citations || []).length ? [] : [el("span", { class: "research-muted" }, "还没有引用条目")]);

    const conclusionList = el("div", { class: "research-hypothesis-evidence" },
      ...(current.linkedConclusions || []).map((cid) => {
        const con = conclusions.find((c) => c.id === cid);
        return el("span", { class: "research-evidence-type", title: con?.statement || "" },
          "结论 · " + (con?.statement || cid).slice(0, 26),
          el("button", {
            class: "research-cell-remove",
            onclick: async () => {
              try {
                current = (await requestJson(base() + "/manuscripts/" + current.id + "/conclusion-links", {
                  method: "POST", body: { conclusionId: cid, remove: true },
                })).manuscript;
                renderManuscript();
              } catch (e) { toast(e.message, true); }
            },
          }, "×"));
      }),
      ...(current.linkedConclusions || []).length ? [] : [el("span", { class: "research-muted" }, "还没有关联结论")]);

    const conSelect = el("select", { class: "research-status-select" },
      el("option", { value: "" }, "关联结论…"),
      ...conclusions.filter((c) => !(current.linkedConclusions || []).includes(c.id))
        .map((c) => el("option", { value: c.id }, (c.statement || "").slice(0, 30))));
    const addConBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        if (!conSelect.value) return;
        try {
          current = (await requestJson(base() + "/manuscripts/" + current.id + "/conclusion-links", {
            method: "POST", body: { conclusionId: conSelect.value },
          })).manuscript;
          renderManuscript();
        } catch (e) { toast(e.message, true); }
      },
    }, "关联");

    const checksBox = el("div");
    const snapshotList = el("div", {},
      ...(current.snapshots || []).slice().reverse().map((s) => el("div", { class: "research-timeline-item" },
        el("span", { class: "research-timeline-at" }, (s.at || "").slice(0, 16).replace("T", " ")),
        el("span", {}, "快照：" + s.citations.length + " 条引用，含 .bib 与结论关联"))));

    const paperIdInput = el("input", { type: "text", placeholder: "文献库论文 ID（或从下方选择）", datasetRole: "paper-id" });
    const paperPicker = el("select", { class: "research-status-select", datasetRole: "paper-picker" },
      el("option", { value: "" }, "从文献库选择…"));
    void (async () => {
      try {
        const papers = (await requestJson("/api/papers")).papers || [];
        paperPicker.append(...papers.map((p) => el("option", { value: p.id }, (p.title || p.id).slice(0, 40))));
      } catch { /* 选择器保持为空 */ }
    })();
    paperPicker.addEventListener("change", () => { if (paperPicker.value) paperIdInput.value = paperPicker.value; });
    const addCiteBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        if (!paperIdInput.value.trim()) return toast("先选择或填写论文 ID", true);
        try {
          current = (await requestJson(base() + "/manuscripts/" + current.id + "/citations", {
            method: "POST", body: { paperId: paperIdInput.value.trim() },
          })).manuscript;
          paperIdInput.value = "";
          paperPicker.value = "";
          renderManuscript();
        } catch (e) { toast(e.message, true); }
      },
    }, "添加引用");
    const bibBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        try {
          const data = await requestJson(base() + "/manuscripts/" + current.id + "/bib");
          const blob = new Blob([data.bib], { type: "text/x-bibtex;charset=utf-8" });
          const link = el("a", { href: URL.createObjectURL(blob), download: current.title.replace(/[\\/:*?"<>|]/g, "_") + ".bib" });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(link.href), 5000);
          toast("已导出 " + data.count + " 条书目");
        } catch (e) { toast(e.message, true); }
      },
    }, "导出 .bib");
    const checkBtn = el("button", { class: "tool-btn", onclick: () => void refreshChecks(current.id, checksBox) }, "运行检查");
    const snapBtn = el("button", {
      class: "tool-btn",
      onclick: async () => {
        try {
          current = (await requestJson(base() + "/manuscripts/" + current.id + "/snapshot", { method: "POST" })).manuscript;
          toast("稿件快照已保存");
          renderManuscript();
        } catch (e) { toast(e.message, true); }
      },
    }, "保存快照");

    container.replaceChildren(
      el("div", { class: "research-add-row" },
        el("button", { class: "tool-btn", onclick: () => void refreshList() }, "← 返回列表"),
        el("strong", {}, current.title),
        current.filePath ? el("span", { class: "research-muted" }, current.filePath) : null),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          el("h4", {}, "文献引用"),
          citationList,
          citeHint,
          el("div", { class: "research-add-row" }, paperPicker, addCiteBtn),
          el("div", { class: "research-add-row" }, paperIdInput, addCiteBtn, bibBtn)),
        el("div", { class: "research-card" },
          el("h4", {}, "关联研究结论"),
          conclusionList,
          el("div", { class: "research-add-row" }, conSelect, addConBtn))),
      el("div", { class: "research-columns" },
        el("div", { class: "research-card" },
          el("h4", {}, "引用检查"),
          el("div", { class: "research-add-row" }, checkBtn),
          checksBox),
        el("div", { class: "research-card" },
          el("h4", {}, "稿件快照（正文之外的书目与关联，只追加不改写）"),
          el("div", { class: "research-add-row" }, snapBtn),
          snapshotList)),
    );
  }

  void refreshList();
  return { container, refresh: refreshList };
}
