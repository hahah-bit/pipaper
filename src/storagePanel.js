import { el, toast, state, askConfirm } from "./app.js";
import DOMPurify from "dompurify";
import katex from "katex";
import { renderMd } from "./chat.js";
import { persistence } from "./persistence.js";
import { openSettings } from "./settings.js";
import {
  streamKnowledgeSearch,
  renderRetrievalAnalysis,
  retrievalStages,
  evidenceDate,
  retrievalRouteName,
} from "./knowledgeRetrieval.js";
import {
  subscribeStorageEvents,
  storageSummary,
  latestStorageJobs,
} from "./storageEvents.js";
const labels = {
  active: "正常",
  trashed: "回收站",
  purging: "清理中",
  deleted: "已清理",
  ready: "可用",
  damaged: "损坏",
  missing: "缺失",
  stale: "过期",
  needs_review: "待核对",
  queued: "排队",
  running: "运行",
  paused: "暂停",
  blocked: "等待配置",
  interrupted: "中断",
  succeeded: "成功",
  failed: "失败",
  cancelled: "取消",
  configuration: "连接检查",
  parse: "结构化解析",
  repair: "视觉补全",
  normalize: "清洗与关联",
  chunk: "标题分块",
  expand: "语义扩写",
  embed: "生成向量",
  index: "写入索引",
  publish: "发布索引",
  original: "原始文献",
  knowledge: "知识成果",
};
export async function storageApi(url, body, method) {
  const response = await fetch("/api/" + url, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
const button = (name, action) =>
  el(
    "button",
    {
      class: "tool-btn",
      onclick: async () => {
        try {
          await action();
        } catch (e) {
          toast(e.message, true);
        }
      },
    },
    name,
  );
function resourceTitle(resource) {
  const paper = state.papers.find((p) => p.id === resource.sourcePaperId);
  const filename =
    resource.location?.split(/[\\/]/).at(-1) || resource.title || resource.id;
  if (paper) return `${paper.title} · ${filename}`;
  if (resource.sourceType === "topic" && /^[\da-f-]{36}\.md$/i.test(filename))
    return "选题报告 · " + new Date(resource.updatedAt).toLocaleString();
  return resource.title || filename;
}
export function storageModule() {
  let body,
    unsubscribe,
    onContextChanged,
    sequence = 0;
  let currentView = "resources";
  const sections = [
    ["resources", "资源"],
    ["notes", "笔记与成果"],
    ["jobs", "处理任务"],
    ["reviews", "待核对"],
    ["trash", "回收站"],
  ];
  const inScope = (r) => {
    const scope = body.querySelector("[name=scope]").value;
    if (scope === "all") return true;
    const paperId =
      r.paperId ||
      r.sourcePaperId ||
      r.metadata?.paperId ||
      (r.kind === "original" ? r.metadata?.id : null);
    if (scope === "paper")
      return !!state.currentPaper && paperId === state.currentPaper.id;
    const project = state.projects.find((p) => p.id === state.projectId);
    return (
      !!project &&
      (r.projectId === project.id ||
        r.metadata?.projectId === project.id ||
        project.paperIds.includes(paperId))
    );
  };
  function selectView(view) {
    currentView = sections.some(([id]) => id === view) ? view : "resources";
    persistence.setItem("pipaper.workspace.libraryView", currentView);
    for (const tab of body.querySelectorAll(".library-tab")) {
      const active = tab.dataset.view === currentView;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    body.querySelector("[name=lifecycle]").value =
      currentView === "trash" ? "trashed" : "active";
    body.querySelector("[name=lifecycle]").hidden = currentView !== "trash";
    body.querySelector("[name=kind]").hidden = !["resources", "trash"].includes(
      currentView,
    );
    body.querySelector(".storage-list").hidden = ![
      "resources",
      "notes",
      "trash",
    ].includes(currentView);
    body.querySelector(".storage-jobs").hidden = currentView !== "jobs";
    body.querySelector(".storage-history").hidden = currentView !== "jobs";
    body.querySelector(".storage-operations").hidden = currentView !== "jobs";
    body.querySelector(".storage-reviews").hidden = currentView !== "reviews";
    void show().catch((e) => toast(e.message, true));
  }
  const show = async () => {
    if (!body) return;
    const host = body,
      ticket = ++sequence;
    const lifecycle = body.querySelector("[name=lifecycle]").value,
      q = body.querySelector("[name=q]").value;
    const [data, jobs, ops, reviews] = await Promise.all([
      storageApi(
        "storage/resources?lifecycle=" +
          lifecycle +
          "&q=" +
          encodeURIComponent(q) +
          "&kind=" +
          encodeURIComponent(
            currentView === "notes"
              ? "knowledge"
              : ["resources", "trash"].includes(currentView)
                ? body.querySelector("[name=kind]").value
                : "",
          ) +
          "&limit=10000",
      ),
      storageApi("ingestion/jobs"),
      storageApi("storage/operations"),
      storageApi("rag/reviews"),
    ]);
    if (host !== body || ticket !== sequence) return;
    const allReviews = reviews.reviews;
    data.resources = data.resources
      .filter(inScope)
      .filter(
        (r) =>
          currentView !== "notes" ||
          (!r.directory && /\.md$/i.test(r.location || "")),
      );
    const summary = storageSummary(jobs.jobs, allReviews);
    const badges = {
      jobs: summary.running + summary.failed,
      reviews: summary.reviews,
    };
    for (const [id, title] of sections)
      body.querySelector(`[data-view=${id}]`).textContent =
        title + (badges[id] ? ` (${badges[id]})` : "");
    const list = body.querySelector(".storage-list");
    list.replaceChildren();
    for (const r of ["resources", "notes", "trash"].includes(currentView)
      ? data.resources
      : []) {
      const pending = jobs.jobs.find((j) => j.resourceId === r.id),
        row = el(
          "article",
          { class: "storage-card" },
          el("strong", {}, resourceTitle(r)),
          el(
            "div",
            { class: "res-note" },
            `${labels[r.kind] || r.kind} · ${labels[r.lifecycle]} · ${labels[r.availability] || r.availability} · 修订 ${r.revision}${r.publishedGeneration ? (r.indexStale ? " · 索引待更新" : " · 已入库") : r.indexStale ? " · 索引已过期" : ""}${r.coverage?.partial ? " · 部分区域待核对" : ""}`,
          ),
        );
      if (pending) {
        row.append(
          el(
            "div",
            {},
            `${labels[pending.status]} · ${labels[pending.stage] || pending.stage} · ${pending.progress || 0}% ${pending.detail || ""}`,
          ),
          el("progress", { max: 100, value: pending.progress || 0 }),
        );
        if (pending.error)
          row.append(el("div", { class: "res-note" }, pending.error));
      }
      const controls = el("div", { class: "storage-actions" });
      if (
        r.lifecycle === "active" &&
        !r.directory &&
        /\.md$/i.test(r.location || "")
      ) {
        controls.append(
          button("预览", async () => {
            const response = await fetch(
              "/api/storage/resources/" +
                encodeURIComponent(r.id) +
                "/content?revision=" +
                r.revision,
            );
            if (!response.ok) throw new Error("该版本内容不可用，请刷新后重试");
            const doc = el("div", { class: "paper-doc" });
            renderMd(await response.text(), doc);
            const dialog = el(
              "dialog",
              { class: "storage-dialog" },
              el("h3", {}, r.title),
              doc,
              button("关闭", () => dialog.close()),
            );
            document.body.append(dialog);
            dialog.addEventListener("close", () => dialog.remove());
            dialog.showModal();
          }),
        );
        const relative = r.location
          .replace(/\\/g, "/")
          .split("/knowledge/")
          .at(1);
        if (relative)
          controls.append(
            button("编辑", () =>
              window.dispatchEvent(
                new CustomEvent("pipaper:workspace-open", {
                  detail: { moduleId: "mdedit", path: relative },
                }),
              ),
            ),
          );
      }
      if (r.lifecycle === "active") {
        if (
          r.availability === "missing" &&
          r.objectPath &&
          r.owned !== false &&
          !r.directory
        )
          controls.append(
            button("恢复受管文件", async () => {
              await storageApi(
                "storage/resources/" + encodeURIComponent(r.id) + "/repair",
                { revision: r.revision },
              );
              await show();
            }),
          );
        if (
          r.kind === "original" &&
          !r.paperId &&
          /\.pdf$/i.test(r.location || "")
        )
          controls.append(
            button("登记为文献", async () => {
              await storageApi(
                "storage/resources/" + encodeURIComponent(r.id) + "/adopt",
                {},
              );
              await show();
              window.dispatchEvent(new Event("pipaper:storage-changed"));
            }),
          );
        else if (
          ["original", "knowledge", "report"].includes(r.kind) &&
          !r.directory
        )
          controls.append(
            button(
              r.publishedGeneration ? "重新入库" : "解析并入库",
              async () => {
                await storageApi("ingestion/jobs", { resourceId: r.id });
                await show();
              },
            ),
          );
        controls.append(
          button("移入回收站", async () => {
            if (
              await askConfirm({
                title: "移入回收站",
                message: "资源立即停止检索，可在 30 天内恢复。",
                okText: "移入回收站",
              })
            ) {
              await storageApi(
                "storage/resources/" + encodeURIComponent(r.id),
                null,
                "DELETE",
              );
              await show();
              window.dispatchEvent(new Event("pipaper:storage-changed"));
            }
          }),
        );
      } else if (r.lifecycle === "trashed" || r.lifecycle === "purging") {
        if (r.lifecycle === "trashed")
          controls.append(
            button("恢复", async () => {
              await storageApi(
                "storage/resources/" +
                  encodeURIComponent(r.trashGroup || r.id) +
                  "/restore",
                {},
              );
              await show();
              window.dispatchEvent(new Event("pipaper:storage-changed"));
            }),
          );
        controls.append(
          button("永久清理", async () => {
            if (
              await askConfirm({
                title: "永久清理",
                message: "永久清理文件和检索索引，此操作无法恢复。",
                okText: "永久清理",
                danger: true,
              })
            ) {
              await storageApi(
                "storage/resources/" +
                  encodeURIComponent(r.trashGroup || r.id) +
                  "/purge",
                {},
              );
              await show();
            }
          }),
        );
      }
      controls.append(
        button("版本与依赖", async () => {
          const details = await storageApi(
            "storage/resources/" + encodeURIComponent(r.id),
          );
          const panel = el(
            "details",
            { open: true },
            el("summary", {}, "历史版本与依赖"),
            el(
              "pre",
              {},
              JSON.stringify(
                {
                  versions: details.versions.map((v) => ({
                    revision: v.revision,
                    hash: v.hash,
                    updatedAt: v.updatedAt,
                  })),
                  dependencies: details.dependencies,
                },
                null,
                2,
              ),
            ),
          );
          for (const v of details.versions)
            if (v.objectPath)
              panel.append(
                el(
                  "a",
                  {
                    href:
                      "/api/storage/resources/" +
                      encodeURIComponent(r.id) +
                      "/content?revision=" +
                      v.revision,
                    target: "_blank",
                  },
                  "查看修订 " + v.revision + " ",
                ),
              );
          row.append(panel);
        }),
      );
      if (pending)
        for (const action of pending.status === "running" ||
        pending.status === "queued"
          ? ["pause", "cancel"]
          : ["paused", "blocked", "interrupted", "failed"].includes(
                pending.status,
              )
            ? ["resume", "cancel"]
            : [])
          controls.append(
            button(
              { pause: "暂停", cancel: "取消", resume: "继续 / 重试" }[action],
              async () => {
                await storageApi(`ingestion/jobs/${pending.id}/${action}`, {});
                await show();
              },
            ),
          );
      row.append(controls);
      list.append(row);
    }
    if (!data.resources.length)
      list.append(
        el(
          "p",
          { class: "res-note" },
          "当前范围没有匹配资料，可切换范围或资源类型。",
        ),
      );
    const taskList = body.querySelector(".storage-jobs");
    taskList.replaceChildren();
    const displayedJobs = body.querySelector('[name="history"]').checked
      ? jobs.jobs
      : latestStorageJobs(jobs.jobs);
    const visibleJobs = displayedJobs.filter((job) => {
      const r = data.resources.find((r) => r.id === job.resourceId);
      return (
        r &&
        (!q ||
          (r.title || job.resourceId).toLowerCase().includes(q.toLowerCase()))
      );
    });
    for (const job of currentView === "jobs" ? visibleJobs : []) {
      const r = data.resources.find((r) => r.id === job.resourceId);
      const row = el(
        "article",
        { class: "storage-card" },
        el("strong", {}, r ? resourceTitle(r) : job.resourceId),
        el(
          "div",
          { class: "res-note" },
          `${labels[job.status]} · ${labels[job.stage] || job.stage || "等待开始"} · ${job.progress || 0}%`,
        ),
        el("progress", { max: 100, value: job.progress || 0 }),
        el("p", {}, job.error || job.detail || ""),
      );
      const actions = ["running", "queued"].includes(job.status)
        ? ["pause", "cancel"]
        : ["paused", "blocked", "interrupted", "failed"].includes(job.status)
          ? ["resume", "cancel"]
          : [];
      for (const action of actions)
        row.append(
          button(
            { pause: "暂停", cancel: "取消", resume: "继续 / 重试" }[action],
            async () => {
              await storageApi(`ingestion/jobs/${job.id}/${action}`, {});
              await show();
            },
          ),
        );
      taskList.append(row);
    }
    if (!visibleJobs.length)
      taskList.append(
        el(
          "p",
          { class: "res-note" },
          "当前范围没有处理任务。选择资源的“解析并入库”即可开始。",
        ),
      );
    const opList = body.querySelector(".storage-operations");
    opList.replaceChildren(el("h3", {}, "未完成的存储操作"));
    for (const op of ops.operations
      .filter((o) => o.status === "failed" || o.status === "pending")
      .slice(0, 50))
      opList.append(
        el(
          "div",
          { class: "storage-card" },
          el(
            "span",
            {},
            `${op.type} · ${op.status} · ${op.error || "等待恢复"}`,
          ),
          button("重试操作", async () => {
            await storageApi(`storage/operations/${op.id}/retry`, {});
            await show();
          }),
        ),
      );
    const reviewList = body.querySelector(".storage-reviews");
    reviewList.replaceChildren(
      el("h3", {}, `待核对（${reviews.reviews.length}）`),
    );
    for (const review of currentView === "reviews"
      ? reviews.reviews
          .filter((review) =>
            data.resources.some((r) => r.id === review.resourceId),
          )
          .slice(0, 100)
      : [])
      reviewList.append(
        el(
          "div",
          { class: "storage-card" },
          el(
            "span",
            {},
            `${resourceTitle(data.resources.find((r) => r.id === review.resourceId))} · 第 ${review.page || "?"} 页 · ${review.issues?.join("、")}`,
          ),
          button("核对证据", async () => {
            const evidence = await storageApi(
                "rag/reviews/" + encodeURIComponent(review.id) + "/evidence",
              ),
              r =
                data.resources.find((r) => r.id === review.resourceId) ||
                (
                  await storageApi(
                    "storage/resources/" +
                      encodeURIComponent(review.resourceId),
                  )
                ).resource;
            const editor = el("textarea", {
                rows: 10,
                value: JSON.stringify(
                  review.candidate || {
                    kind: evidence.target?.kind || "text",
                    text: evidence.target?.text || "",
                    shortDescription: evidence.target?.shortDescription || "",
                    uncertain: false,
                  },
                  null,
                  2,
                ),
              }),
              dlg = el(
                "dialog",
                { class: "storage-dialog" },
                el("h3", {}, "核对原文与候选结果"),
                evidence.image
                  ? el("img", {
                      src: `data:${evidence.image.mimeType};base64,${evidence.image.data}`,
                      alt: "来源区域",
                    })
                  : el("p", {}, "没有区域图片，请结合源文档定位核对。"),
                editor,
                button("采用修订", async () => {
                  await storageApi(
                    "rag/reviews/" + encodeURIComponent(review.id),
                    {
                      revision: r.revision,
                      candidate: JSON.parse(editor.value),
                    },
                    "PUT",
                  );
                  dlg.close();
                  await show();
                }),
                button("丢弃冗余区域", async () => {
                  await storageApi(
                    "rag/reviews/" + encodeURIComponent(review.id),
                    { revision: r.revision, decision: "discard" },
                    "PUT",
                  );
                  dlg.close();
                  await show();
                }),
                button("关闭", () => dlg.close()),
              );
            document.body.append(dlg);
            dlg.addEventListener("close", () => dlg.remove());
            editor.value = editor.getAttribute("value") || "";
            editor.removeAttribute("value");
            dlg.showModal();
          }),
        ),
      );
  };
  return {
    id: "storage",
    name: "资料",
    icon: "🗄",
    mount(container, ctx) {
      body = container;
      body.classList.add("storage-panel");
      const filter = el(
        "select",
        {
          name: "lifecycle",
          onchange: () => show().catch((e) => toast(e.message, true)),
        },
        ...["active", "trashed", "purging", "deleted"].map((v) =>
          el("option", { value: v }, labels[v]),
        ),
      );
      const input = el("input", {
        name: "q",
        placeholder: "搜索资源名称或路径",
      });
      const scope = el(
        "select",
        {
          name: "scope",
          "aria-label": "资料范围",
          onchange: () => show().catch((e) => toast(e.message, true)),
        },
        el("option", { value: "all" }, "全部资料"),
        el(
          "option",
          { value: "paper", disabled: !state.currentPaper },
          "当前论文",
        ),
        el(
          "option",
          { value: "project", disabled: !state.projectId },
          "当前项目",
        ),
      );
      const tabs = el(
        "div",
        {
          class: "library-tabs workspace-tabs",
          role: "tablist",
          "aria-label": "资料分类",
        },
        ...sections.map(([id, title]) =>
          el(
            "button",
            {
              class: "library-tab workspace-tab",
              role: "tab",
              "data-view": id,
              onclick: () => selectView(id),
            },
            title,
          ),
        ),
      );
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter")
          void show().catch((e) => toast(e.message, true));
      });
      const types = el(
        "select",
        {
          name: "kind",
          title: "存储单元",
          onchange: () => show().catch((e) => toast(e.message, true)),
        },
        ...[
          ["original", "原始文献"],
          ["knowledge", "知识成果"],
          ["study", "研读任务"],
          ["topic", "选题资源"],
          ["session", "Pi 会话"],
          ["project", "项目"],
          ["parsed", "解析文件"],
          ["parse-root", "解析目录"],
          ["element-asset", "元素图片"],
          ["rag-checkpoint", "RAG 检查点"],
          ["temporary", "暂存文件"],
          ["log", "运行日志"],
          ["backup", "备份"],
          ["", "全部资源"],
        ].map(([value, name]) => el("option", { value }, name)),
      );
      body.append(
        el("h2", {}, "资料"),
        tabs,
        el(
          "div",
          { class: "storage-actions" },
          filter,
          scope,
          types,
          input,
          el(
            "label",
            { class: "storage-history knowledge-scope" },
            el("input", {
              type: "checkbox",
              name: "history",
              onchange: () => show().catch((e) => toast(e.message, true)),
            }),
            "包含历史任务",
          ),
          button("刷新", show),
          button("知识库设置", () => openSettings("knowledge")),
        ),
        el("div", { class: "storage-list" }),
        el("section", { class: "storage-jobs" }),
        el("section", { class: "storage-operations" }),
        el("section", { class: "storage-reviews" }),
      );
      selectView(
        ctx?.initial?.libraryView ||
          persistence.getItem("pipaper.workspace.libraryView"),
      );
      onContextChanged = () => {
        scope.querySelector('[value="paper"]').disabled = !state.currentPaper;
        scope.querySelector('[value="project"]').disabled = !state.projectId;
        if (
          (scope.value === "paper" && !state.currentPaper) ||
          (scope.value === "project" && !state.projectId)
        )
          scope.value = "all";
        void show().catch(() => {});
      };
      window.addEventListener("pipaper:paper-changed", onContextChanged);
      window.addEventListener("pipaper:project-changed", onContextChanged);
      unsubscribe = subscribeStorageEvents(() => {
        if (body) void show().catch(() => {});
      });
    },
    activate(payload) {
      if (payload?.libraryView) selectView(payload.libraryView);
    },
    unmount() {
      unsubscribe?.();
      sequence++;
      window.removeEventListener("pipaper:paper-changed", onContextChanged);
      window.removeEventListener("pipaper:project-changed", onContextChanged);
      body = null;
    },
  };
}
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
      const formula = el("div", {});
      formula.innerHTML = katex.renderToString(part.latex || "", {
        throwOnError: false,
        trust: false,
        displayMode: true,
      });
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
    controller;
  return {
    id: "knowledge",
    name: "知识库检索",
    icon: "📚",
    mount(body) {
      alive = true;
      body.classList.add("storage-panel");
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
              for (const part of row.parts)
                if (part.type === "text")
                  renderParts([part], snippet, row.generationId);
                else
                  snippet.append(
                    el(
                      "span",
                      { class: "knowledge-placeholder" },
                      `［${{ image: "图", table: "表", formula: "公式", code: "算法" }[part.type] || "附件"}证据见下］`,
                    ),
                  );
              card.append(snippet);
              if (row.evidence?.length) {
                const evidence = el(
                  "div",
                  { class: "knowledge-evidence" },
                  el("h4", {}, "对应图、表与公式"),
                );
                renderParts(
                  row.evidence,
                  evidence,
                  row.generationId,
                  attachments,
                );
                card.append(evidence);
              }
            } else {
              card.append(
                el(
                  "p",
                  { class: "knowledge-snippet" },
                  row.element.description ||
                    row.element.shortDescription ||
                    row.element.caption ||
                    "元素证据",
                ),
              );
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
                renderParts(
                  c.parts,
                  context,
                  row.generationId,
                  attachments,
                  true,
                );
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
      window.removeEventListener("pipaper:project-changed", onProjectChanged);
    },
  };
}
