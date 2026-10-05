import { el, toast } from "../../platform/dom.js";
import { state } from "../../shell/state.js";
import { labels, button, storageApi } from "../../platform/storage-client.js";
import DOMPurify from "dompurify";
import katex from "katex";
import { renderMd } from "../../platform/markdown.js";
import { persistence } from "../../persistence.js";
import { formulaIsInline, standaloneEvidence } from "../../../shared/knowledge-content.js";
import { createKnowledgeSelection } from "../../knowledgeSelection.js";
import { renderKnowledgeSnippet } from "../../knowledgeEvidence.js";
import { streamKnowledgeSearch, renderRetrievalAnalysis, retrievalStages, evidenceDate, retrievalRouteName } from "../../knowledgeRetrieval.js";

const attachmentKey = (part, generationId) =>
  part.elementId || part.id
    ? JSON.stringify([generationId, part.versionId, part.elementId || part.id])
    : null;
function renderParts(
  parts,
  container,
  generationId,
  attachments,
  inContext = false,
) {
  for (const part of parts) {
    const key = ["image", "table", "formula", "code"].includes(part.type)
      ? attachmentKey(part, generationId)
      : null;
    if (key && attachments) {
      if (
        attachments.displayed.has(key) ||
        (inContext && attachments.primary.has(key))
      ) {
        const name = {
          image: "原图",
          table: "原表",
          formula: "公式",
          code: "代码",
        }[part.type];
        const link = button(
          `查看${name}${part.page ? ` · 第 ${part.page} 页` : ""}`,
          () => {
            const target = attachments.displayed.get(key);
            if (!target) return;
            for (
              let parent = target.parentElement;
              parent;
              parent = parent.parentElement
            )
              if (parent.tagName === "DETAILS") parent.open = true;
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.focus({ preventScroll: true });
          },
        );
        link.classList.add("knowledge-reference");
        link.title =
          "已在其他结果展示：" +
          (part.description || part.shortDescription || name);
        container.append(link);
        continue;
      }
      const slot = el("div", {
        class: "knowledge-element",
        tabindex: "-1",
        "data-element-id": part.elementId || part.id,
      });
      attachments.displayed.set(key, slot);
      container.append(slot);
      renderParts([part], slot, generationId);
      continue;
    }
    if (part.type === "text")
      container.append(el("span", { class: "knowledge-text" }, part.text));
    else if (part.type === "image" && part.data)
      container.append(
        el(
          "figure",
          {},
          el("img", {
            src: `data:${part.mimeType};base64,${part.data}`,
            alt: part.description || "原图",
          }),
          el("figcaption", {}, part.description || ""),
        ),
      );
    else if (part.type === "table") {
      const table = el("div", { class: "knowledge-table" });
      table.innerHTML = DOMPurify.sanitize(part.html, {
        ALLOWED_TAGS: [
          "table",
          "thead",
          "tbody",
          "tfoot",
          "tr",
          "th",
          "td",
          "caption",
          "sup",
          "sub",
          "br",
        ],
        ALLOWED_ATTR: ["rowspan", "colspan"],
      });
      container.append(table);
    } else if (part.type === "formula") {
      const formula = el("div", { class: "knowledge-formula" });
      if (!formulaIsInline(part)) formula.append(el("small", { class: "res-note" },
        `${part.label ? "公式 " + part.label : "独立公式"}${part.page ? " · 第 " + part.page + " 页" : ""}`));
      const math = el("div", { class: "knowledge-formula-math" });
      math.innerHTML = katex.renderToString(part.latex || "", {
        throwOnError: false,
        trust: false,
        displayMode: !formulaIsInline(part),
      });
      formula.append(math);
      container.append(formula);
    } else if (part.pending) {
      const slot = el("div", { class: "knowledge-attachment" });
      slot.append(
        button("加载附件：" + part.description, async () => {
          const e = await storageApi(
            "rag/elements/" +
              encodeURIComponent(part.elementId) +
              "?generationId=" +
              generationId,
          );
          slot.replaceChildren();
          renderParts([{ ...e, type: e.kind }], slot, generationId);
        }),
      );
      container.append(slot);
    } else container.append(el("pre", {}, part.text || part.description || ""));
  }
}
export function knowledgeModule() {
  let alive = false,
    onProjectChanged,
    controller,
    selection;
  return {
    id: "knowledge",
    name: "知识库检索",
    icon: "📚",
    mount(body) {
      alive = true;
      body.classList.add("storage-panel");
      selection = createKnowledgeSelection(body);
      const query = el("input", {
          placeholder: "检索文献、笔记、研读成果…",
          style: { flex: "1" },
        }),
        source = el(
          "select",
          {},
          ...[
            ["", "所有来源"],
            ["original", "原始文献"],
            ["note", "笔记"],
            ["study", "研读成果"],
            ["topic", "选题报告"],
          ].map(([value, name]) => el("option", { value }, name)),
        ),
        kind = el(
          "select",
          {},
          ...[
            ["", "正文与全部元素"],
            ["image", "图片"],
            ["table", "表格"],
            ["formula", "公式"],
            ["code", "代码 / 算法"],
          ].map(([value, name]) => el("option", { value }, name)),
        ),
        list = el("div", {}),
        project = el("input", { type: "checkbox", checked: false }),
        selfRag = el("input", { type: "checkbox", checked: true }),
        timeMode = el(
          "select",
          { "aria-label": "证据时间策略" },
          ...[
            ["auto", "自动判断时间"],
            ["relevance", "优先相关性"],
            ["latest", "优先近期信息"],
            ["as_of", "截至指定日期"],
            ["range", "指定时间范围"],
            ["compare", "历史变化对比"],
          ].map(([value, label]) => el("option", { value }, label)),
        ),
        timeFrom = el("input", {
          type: "date",
          "aria-label": "起始日期",
          hidden: true,
        }),
        timeTo = el("input", {
          type: "date",
          "aria-label": "截止日期",
          hidden: true,
        });
      let searchSequence = 0,
        selfRagPreference = false;
      try {
        const saved = JSON.parse(
          persistence.getItem("pipaper.workspace.knowledgeFilters") || "{}",
        );
        query.value = saved.query || "";
        source.value = saved.source || "";
        kind.value = saved.kind || "";
        project.checked = !!saved.project;
        selfRagPreference = typeof saved.selfRag === "boolean";
        selfRag.checked = saved.selfRag !== false;
        timeMode.value = saved.timeMode || "auto";
        timeFrom.value = saved.timeFrom || "";
        timeTo.value = saved.timeTo || "";
      } catch {}
      selfRag.addEventListener("change", () => {
        selfRagPreference = true;
      });
      void storageApi("rag/config")
        .then((data) => {
          if (alive && !selfRagPreference)
            selfRag.checked = data.config.retrieval.selfRag;
        })
        .catch(() => {});
      const remember = () =>
        persistence.setItem(
          "pipaper.workspace.knowledgeFilters",
          JSON.stringify({
            query: query.value,
            source: source.value,
            kind: kind.value,
            project: project.checked,
            selfRag: selfRag.checked,
            timeMode: timeMode.value,
            timeFrom: timeFrom.value,
            timeTo: timeTo.value,
          }),
        );
      onProjectChanged = () => {
        project.disabled = !state.projectId;
        if (!state.projectId) project.checked = false;
      };
      onProjectChanged();
      window.addEventListener("pipaper:project-changed", onProjectChanged);
      for (const field of [
        query,
        source,
        kind,
        project,
        selfRag,
        timeMode,
        timeFrom,
        timeTo,
      ])
        field.addEventListener("change", remember);
      const updateDates = () => {
        timeFrom.hidden = timeMode.value !== "range";
        timeTo.hidden = !["range", "as_of"].includes(timeMode.value);
      };
      timeMode.addEventListener("change", updateDates);
      updateDates();
      query.setAttribute("aria-label", "知识库查询");
      source.setAttribute("aria-label", "知识来源");
      kind.setAttribute("aria-label", "检索元素类型");
      const search = async () => {
        if (!query.value.trim()) {
          query.focus();
          return;
        }
        remember();
        const ticket = ++searchSequence;
        selection.reset();
        controller?.abort();
        controller = new AbortController();
        const status = el(
          "p",
          { role: "status", class: "knowledge-progress" },
          "检索中…",
        );
        const cancel = button("停止检索", () => controller?.abort());
        list.replaceChildren(
          el("div", { class: "storage-actions" }, status, cancel),
        );
        try {
          const data = await streamKnowledgeSearch(
            {
              query: query.value,
              sourceType: source.value || undefined,
              elementType: kind.value || undefined,
              projectId: project.checked ? state.projectId : undefined,
              selfRag: selfRag.checked,
              imageBudget: 4 * 1024 * 1024,
              temporal: {
                mode: timeMode.value,
                from:
                  timeMode.value === "range"
                    ? timeFrom.value || undefined
                    : undefined,
                to: ["range", "as_of"].includes(timeMode.value)
                  ? timeTo.value || undefined
                  : undefined,
              },
            },
            {
              signal: controller.signal,
              onProgress: (event) => {
                if (alive && ticket === searchSequence)
                  status.textContent = `${retrievalStages[event.stage] || event.stage}…${event.candidates ? ` ${event.candidates} 个候选` : ""}`;
              },
            },
          );
          if (!alive || ticket !== searchSequence) return;
          list.replaceChildren();
          const evidenceCards = new Map();
          renderRetrievalAnalysis(data, list, (id) => {
            const card = evidenceCards.get(id);
            card?.scrollIntoView({ behavior: "smooth", block: "start" });
            card?.focus({ preventScroll: true });
          });
          const attachments = { displayed: new Map(), primary: new Set() };
          for (const row of data.results)
            for (const part of row.parts || [
              { ...row.element, type: row.element?.kind },
            ]) {
              const key = attachmentKey(part, row.generationId);
              if (key) attachments.primary.add(key);
            }
          if (!data.results.length)
            list.append(
              el(
                "p",
                {},
                "没有已发布证据命中。可从资料 → 资源启动解析并入库。",
              ),
            );
          for (const row of data.results) {
            const card = el(
              "article",
              { class: "storage-card knowledge-result", tabindex: "-1" },
              el("h3", {}, `${row.citationId || ""} · ${row.title}`),
              el(
                "div",
                { class: "res-note" },
                `${row.sectionPath?.join(" > ") || "文档根节点"} · 页 ${row.pages?.join(", ") || "—"} · ${row.sourceType} · 版本 ${row.versionId?.slice(0, 12)}${row.stale ? " · 已过期版本" : ""}${row.coverage?.partial ? " · 部分区域待核对" : ""}`,
              ),
              el(
                "p",
                { class: "res-note" },
                `来源日期：${evidenceDate(row.date)} · ${row.date?.basis === "artifactCreatedAt" ? "成果生成时间" : row.sourceType === "original" ? "文献发表时间" : "内容标注时间"}${row.date?.sourcePublication?.value ? ` · 来源文献 ${evidenceDate(row.date.sourcePublication)}` : ""}`,
              ),
            );
            evidenceCards.set(row.id, card);
            if (row.coverageGaps?.length) card.append(el("p", { class: "knowledge-warning", role: "note" },
              `本页公式 ${[...new Set(row.coverageGaps.map(gap => gap.label || "未编号"))].join("、")} 待核对，当前证据未包含这些公式。可到资料 → 待核对查看原始证据。`));
            const metrics = el(
              "details",
              { class: "knowledge-scores" },
              el("summary", {}, "相关度与召回依据"),
            );
            metrics.append(
              el(
                "p",
                {},
                `融合 ${row.scores?.fusion?.toFixed(3) || "—"} · 重排 ${row.scores?.rerank?.toFixed(3) || "未启用 / 不可用"} · 综合 ${row.score?.toFixed(3) || "—"}`,
              ),
              el(
                "p",
                { class: "res-note" },
                "分数用于本次结果排序，不代表答案正确概率。",
              ),
            );
            if (row.reflection)
              metrics.append(el("p", {}, row.reflection.reason));
            metrics.append(
              el(
                "ul",
                {},
                ...(row.retrieval || []).map((r) =>
                  el(
                    "li",
                    {},
                    `${retrievalRouteName(r.route)} · 第 ${r.rank} 名`,
                  ),
                ),
              ),
            );
            card.append(metrics);
            if (row.parts) {
              const snippet = el("div", { class: "knowledge-snippet" });
              renderKnowledgeSnippet(row.parts, snippet, { ...row, recordId: row.chunkId }, selection,
                part => attachments.displayed.get(attachmentKey(part, row.generationId)));
              card.append(snippet);
              const standalone = standaloneEvidence(row.evidence || []);
              if (standalone.length) {
                const evidence = el(
                  "div",
                  { class: "knowledge-evidence" },
                  el("h4", {}, "对应图、表与公式"),
                );
                renderParts(
                  standalone,
                  evidence,
                  row.generationId,
                  attachments,
                );
                card.append(evidence);
              }
            } else {
              const description = el("div", { class: "knowledge-snippet" });
              renderKnowledgeSnippet([{ type: "text", text: row.element.description || row.element.caption ||
                (row.element.kind === "formula" ? (formulaIsInline(row.element) ? "原文行内表达式" : "原文独立公式") : row.element.shortDescription) || "元素证据" }],
                description, { ...row, recordId: row.element.id }, selection);
              card.append(description);
              const evidence = el(
                "div",
                { class: "knowledge-evidence" },
                el("h4", {}, "对应图、表与公式"),
              );
              renderParts(
                [{ ...row.element, type: row.element.kind }],
                evidence,
                row.generationId,
                attachments,
              );
              card.append(evidence);
              for (const c of row.contexts) {
                const context = el(
                  "details",
                  {},
                  el("summary", {}, "引用正文 · " + c.sectionPath.join(" > ")),
                );
                const prose = el("div", { class: "knowledge-snippet" });
                renderKnowledgeSnippet(c.parts, prose, { ...row, recordId: c.id, sectionPath: c.sectionPath, pages: c.pages }, selection,
                  part => attachments.displayed.get(attachmentKey(part, row.generationId)));
                context.append(prose);
                const extra = standaloneEvidence(c.parts);
                if (extra.length) renderParts(extra, context, row.generationId, attachments, true);
                card.append(context);
              }
            }
            list.append(card);
          }
        } catch (e) {
          if (alive && ticket === searchSequence)
            list.replaceChildren(
              el("p", {}, e.name === "AbortError" ? "检索已停止" : e.message),
            );
        }
      };
      body.append(
        el("h2", {}, "知识库检索"),
        el(
          "div",
          { class: "knowledge-query storage-actions" },
          query,
          button("搜索", search),
        ),
        el(
          "div",
          { class: "knowledge-filters storage-actions" },
          source,
          kind,
          el("label", { class: "knowledge-scope" }, project, "当前项目"),
          el("label", { class: "knowledge-scope" }, selfRag, "Self-RAG 分析"),
          timeMode,
          timeFrom,
          timeTo,
        ),
        list,
      );
      query.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void search();
      });
    },
    unmount() {
      alive = false;
      controller?.abort();
      selection?.dispose();
      window.removeEventListener("pipaper:project-changed", onProjectChanged);
    },
  };
}
