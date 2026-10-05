import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { digest } from "../storage/catalog.js";
import { searchKnowledge, getKnowledgeElement } from "./search.js";

function result(value) {
  const images = [];
  const imageIds = new Map();
  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") {
      if (item.data && item.mimeType) {
        const key = digest([item.mimeType, item.data]);
        if (!imageIds.has(key)) {
          imageIds.set(key, images.length);
          images.push({
            type: "image",
            data: item.data,
            mimeType: item.mimeType,
          });
        }
        return { ...item, data: undefined, imageIndex: imageIds.get(key) };
      }
      return Object.fromEntries(
        Object.entries(item).map(([k, v]) => [k, scrub(v)]),
      );
    }
    return item;
  };
  const cleaned = scrub(value);
  return {
    content: [{ type: "text", text: JSON.stringify(cleaned) }, ...images],
    details: cleaned,
  };
}
export function knowledgeTools() {
  return [
    defineTool({
      name: "search_knowledge",
      label: "知识库检索",
      description:
        "Self-RAG 检索文献与成果：问题改写、多路召回、重排、证据反思与引用核对。返回原文、图表公式、带证据引用的分析和时间冲突警告。新旧判断只覆盖本地资料。",
      parameters: Type.Object({
        query: Type.String(),
        resource_ids: Type.Optional(Type.Array(Type.String())),
        project_id: Type.Optional(Type.String()),
        source_type: Type.Optional(Type.String()),
        element_type: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        self_rag: Type.Optional(Type.Boolean()),
        temporal: Type.Optional(
          Type.Object({
            mode: Type.Optional(
              Type.Union([
                Type.Literal("auto"),
                Type.Literal("relevance"),
                Type.Literal("latest"),
                Type.Literal("as_of"),
                Type.Literal("range"),
                Type.Literal("compare"),
              ]),
            ),
            from: Type.Optional(Type.String()),
            to: Type.Optional(Type.String()),
          }),
        ),
      }),
      execute: async (_id, args) =>
        result(
          await searchKnowledge(args.query, {
            resourceIds: args.resource_ids,
            projectId: args.project_id,
            sourceType: args.source_type,
            elementType: args.element_type,
            limit: args.limit,
            selfRag: args.self_rag,
            temporal: args.temporal,
            imageBudget: 4 * 1024 * 1024,
          }),
        ),
    }),
    defineTool({
      name: "get_knowledge_element",
      label: "获取知识元素",
      description:
        "根据检索返回的元素 ID 获取原图 base64、表格 HTML 或公式 LaTeX，保持文献版本一致。",
      parameters: Type.Object({
        element_id: Type.String(),
        generation_id: Type.Optional(Type.String()),
      }),
      execute: async (_id, args) =>
        result(
          getKnowledgeElement(args.element_id, {
            generationId: args.generation_id,
            imageBudget: 4 * 1024 * 1024,
          }),
        ),
    }),
  ];
}
