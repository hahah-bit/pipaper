import { el, toast, askConfirm } from "./platform/dom.js";
import { state } from "./shell/state.js";
import { labels, button, storageApi } from "./platform/storage-client.js";
import { openSettings } from "./settings.js";
import { subscribeStorageEvents, storageSummary, latestStorageJobs } from "./storageEvents.js";
export { storageApi } from "./platform/storage-client.js";
export { knowledgeModule } from "./features/retrieval/panel.js";

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
