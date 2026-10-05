import { el, toast, state, askConfirm } from "./app.js";
import DOMPurify from "dompurify";
import katex from "katex";
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
export function storageModule() {
  let body, events;
  const show = async () => {
    const lifecycle = body.querySelector("[name=lifecycle]").value,
      q = body.querySelector("[name=q]").value;
    const data = await storageApi(
      "storage/resources?lifecycle=" +
        lifecycle +
        "&q=" +
        encodeURIComponent(q) +
        "&kind=" +
        encodeURIComponent(body.querySelector("[name=kind]").value) +
        "&limit=500",
    );
    const jobs = await storageApi("ingestion/jobs");
    const ops = await storageApi("storage/operations");
    const reviews = await storageApi("rag/reviews");
    const list = body.querySelector(".storage-list");
    list.replaceChildren();
    for (const r of data.resources) {
      const pending = jobs.jobs.find((j) => j.resourceId === r.id),
        row = el(
          "article",
          { class: "storage-card" },
          el(
            "strong",
            {},
            r.title || r.location?.split(/[\\/]/).at(-1) || r.id,
          ),
          el(
            "div",
            { class: "res-note" },
            `${labels[r.kind] || r.kind} · ${labels[r.lifecycle]} · ${labels[r.availability] || r.availability} · 修订 ${r.revision}${r.indexStale ? " · 索引已过期" : ""}`,
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
    for (const review of reviews.reviews.slice(0, 100))
      reviewList.append(
        el(
          "div",
          { class: "storage-card" },
          el(
            "span",
            {},
            `第 ${review.page || "?"} 页 · ${review.issues?.join("、")}`,
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
    name: "存储管理",
    icon: "🗄",
    mount(container) {
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
        el("h2", {}, "存储管理"),
        el(
          "div",
          { class: "storage-actions" },
          filter,
          types,
          input,
          button("刷新", show),
          button("连接配置", async () => {
            const data = await storageApi("rag/config"),
              editor = el("textarea", {
                rows: 16,
                value: JSON.stringify(data.config, null, 2),
              }),
              dlg = el(
                "dialog",
                { class: "storage-dialog" },
                el("h3", {}, "知识库连接配置"),
                el(
                  "p",
                  {},
                  data.embeddingConfigured
                    ? "已读取服务端 Embedding 凭据"
                    : "未配置 Embedding 凭据，请在服务端设置 DASHSCOPE_API_KEY 或本地 credentials/embedding.json",
                ),
                editor,
                button("保存", async () => {
                  await storageApi(
                    "rag/config",
                    JSON.parse(editor.value),
                    "PUT",
                  );
                  dlg.close();
                }),
                button("关闭", () => dlg.close()),
              );
            document.body.append(dlg);
            dlg.addEventListener("close", () => dlg.remove());
            editor.value = JSON.stringify(data.config, null, 2);
            editor.removeAttribute("value");
            dlg.showModal();
          }),
        ),
        el("div", { class: "storage-list" }),
        el("section", { class: "storage-operations" }),
        el("section", { class: "storage-reviews" }),
      );
      void show().catch((e) => toast(e.message, true));
      events = new EventSource("/api/storage/events");
      let refresh;
      events.onmessage = () => {
        clearTimeout(refresh);
        refresh = setTimeout(() => {
          if (body) void show().catch(() => {});
        }, 500);
      };
    },
    unmount() {
      events?.close();
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
  return {
    id: "knowledge",
    name: "知识库检索",
    icon: "📚",
    mount(body) {
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
        project = el("input", { type: "checkbox", checked: false });
      const search = async () => {
        list.replaceChildren(el("p", {}, "检索中…"));
        try {
          const data = await storageApi("rag/search", {
            query: query.value,
            sourceType: source.value || undefined,
            elementType: kind.value || undefined,
            projectId: project.checked ? state.projectId : undefined,
          });
          list.replaceChildren();
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
              el("p", {}, "没有已发布证据命中。可从存储管理启动解析并入库。"),
            );
          for (const row of data.results) {
            const card = el(
              "article",
              { class: "storage-card" },
              el("h3", {}, row.title),
              el(
                "div",
                { class: "res-note" },
                `${row.sectionPath?.join(" > ") || "文档根节点"} · 页 ${row.pages?.join(", ") || "—"} · ${row.sourceType} · 版本 ${row.versionId?.slice(0, 12)}${row.stale ? " · 已过期版本" : ""}${row.coverage?.partial ? " · 部分区域待核对" : ""}`,
              ),
            );
            if (row.parts)
              renderParts(row.parts, card, row.generationId, attachments);
            else {
              renderParts(
                [{ ...row.element, type: row.element.kind }],
                card,
                row.generationId,
                attachments,
              );
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
          list.replaceChildren(el("p", {}, e.message));
        }
      };
      body.append(
        el("h2", {}, "知识库检索"),
        el(
          "div",
          { class: "storage-actions" },
          query,
          source,
          kind,
          el("label", {}, project, " 当前项目"),
          button("搜索", search),
        ),
        list,
      );
      query.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void search();
      });
    },
    unmount() {},
  };
}
