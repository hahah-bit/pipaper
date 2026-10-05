import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchKnowledge, getKnowledgeElement } from "./search.js";

function result(value) {
  const images = [];
  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") {
      if (item.data && item.mimeType) {
        images.push({
          type: "image",
          data: item.data,
          mimeType: item.mimeType,
        });
        return { ...item, data: undefined };
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
        "检索已入库文献及笔记、研读、选题成果。返回核验原文、标题路径、页码与版本，并在占位符位置还原图表公式。过期证据会明确标记。",
      parameters: Type.Object({
        query: Type.String(),
        resource_ids: Type.Optional(Type.Array(Type.String())),
        project_id: Type.Optional(Type.String()),
        source_type: Type.Optional(Type.String()),
        element_type: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (_id, args) =>
        result(
          await searchKnowledge(args.query, {
            resourceIds: args.resource_ids,
            projectId: args.project_id,
            sourceType: args.source_type,
            elementType: args.element_type,
            limit: args.limit,
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
