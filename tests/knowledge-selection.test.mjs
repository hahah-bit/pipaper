import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formulaIsInline, knowledgeMarkdown, standaloneEvidence } from "../shared/knowledge-content.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-selection-"));
process.env.PIPAPER_DATA_DIR = path.join(directory, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(directory, "library");
const catalog = await import("../server/storage/catalog.js");
const { getConfig } = await import("../server/config.js");
const { normalizeDocument, hydrate, validateCandidate } = await import("../server/rag/document.js");
const { translateKnowledgeSelection } = await import("../server/rag/translation.js");
test.after(() => {
  catalog.closeCatalog();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("legacy formula captions restore inline math without dumping symbols or exposing duplicate LaTeX", () => {
  const parts = [
    { type: "text", text: "where " },
    { type: "formula", latex: "h_c", description: "行内公式：h_c" },
    { type: "text", text: "（行内公式：h_c） denotes context.\n\n" },
    { type: "formula", latex: "q_c=h_c+1\\tag{20}", description: "行内公式：q_c=h_c+1\\tag{20}" },
    { type: "text", text: "（行内公式：q_c=h_c+1\\tag{20}）（注：a real scientific footnote）" },
  ];
  assert.equal(formulaIsInline(parts[1]), true);
  assert.equal(formulaIsInline(parts[3]), false);
  assert.deepEqual(standaloneEvidence(parts), [parts[3]]);
  const markdown = knowledgeMarkdown(parts);
  assert.ok(markdown.includes("where $h_c$ denotes context."));
  assert.ok(markdown.includes("$$\nq_c=h_c+1\\tag{20}\n$$"));
  assert.ok(!markdown.includes("行内公式："));
  assert.ok(markdown.includes("（注：a real scientific footnote）"));
});

test("new normalization preserves display delimiters through hydration", () => {
  const document = normalizeDocument({ blocks: [{ id: "paragraph", type: "para", page: 1,
    md: "Inline $h_c$ and display $$q_c=h_c+1$$ and escaped \\(x_i\\)." }] },
    { resourceId: "display-test", versionId: "v1", generationId: "display-g" });
  assert.deepEqual(document.elements.map(e => e.display), [false, true, false]);
  const parts = hydrate({ text: document.body[0].text }, document.elements);
  assert.deepEqual(parts.filter(p => p.type === "formula").map(formulaIsInline), [true, false, true]);
});

test("numbered display equations validate in display mode instead of being falsely rejected by KaTeX", () => {
  assert.deepEqual(validateCandidate({}, { kind: "formula", uncertain: false, latex: "q_c=h_c+1\\tag{20}", shortDescription: "Query residual" }), []);
});

function seed(id) {
  const r = catalog.putResource({ id, kind: "original", sourceType: "original", title: "Routing paper", versionId: "v1" });
  const generation = { id: `${id}-g`, resourceId: id, versionId: "v1" };
  catalog.saveGeneration(generation, [{ id: `${id}-c`, kind: "chunk", resourceId: id,
    text: "Accuracy is 95% with $x_1=2$.", sectionPath: ["Method"], pages: [2], elementIds: [] }]);
  catalog.publish(generation.id, r.revision);
  return { resourceId: id, generationId: generation.id, recordId: `${id}-c`, text: "Accuracy is 95% with $x_1=2$." };
}

test("translation defaults to configured GLM, protects math/numbers, caches only the same version and selection", async () => {
  const input = seed("translation-cache"); let calls = 0;
  const complete = async options => {
    calls++;
    assert.deepEqual(options.models, [{ provider: "zai-coding-cn", id: "glm-4.7" }]);
    const prompt = JSON.parse(options.text);
    assert.equal(prompt.task, "knowledge_selection_translation");
    assert.equal(prompt.context, input.text);
    return { value: { translation: prompt.source.replace("Accuracy is", "准确率是").replace("with", "且") }, model: getConfig().translate.model };
  };
  const first = await translateKnowledgeSelection(input, { complete });
  assert.ok(first.translated.includes("95%")); assert.ok(first.translated.includes("$x_1=2$"));
  const cached = await translateKnowledgeSelection(input, { complete });
  assert.equal(cached.cached, true); assert.equal(calls, 1);
  await translateKnowledgeSelection({ ...input, text: "Accuracy is 95%." }, { complete });
  assert.equal(calls, 2);
  catalog.putResource({ ...catalog.resource(input.resourceId), lifecycle: "trashed" });
  await assert.rejects(translateKnowledgeSelection(input, { complete }), error => error.status === 409);
  assert.equal(calls, 2, "a cached translation never bypasses lifecycle checks");
});

test("translation retries structural damage once and withdraws results after late deletion", async () => {
  const input = seed("translation-retry"); let calls = 0;
  const result = await translateKnowledgeSelection(input, { complete: async options => {
    calls++;
    return { value: { translation: calls === 1 ? "数字和公式都没了" : JSON.parse(options.text).source } };
  } });
  assert.equal(calls, 2); assert.equal(result.translated, input.text);
  const late = seed("translation-late");
  await assert.rejects(translateKnowledgeSelection(late, { complete: async options => {
    catalog.putResource({ ...catalog.resource(late.resourceId), lifecycle: "trashed" });
    return { value: { translation: JSON.parse(options.text).source } };
  } }), error => error.status === 409);
  assert.equal(catalog.readState("unused", null), null);
});

test("translation rejects oversized selection and mismatched record provenance before invoking the model", async () => {
  const input = seed("translation-scope");
  const complete = () => { throw new Error("must not invoke"); };
  await assert.rejects(translateKnowledgeSelection({ ...input, text: "x".repeat(8001) }, { complete }), error => error.status === 422);
  await assert.rejects(translateKnowledgeSelection({ ...input, recordId: "translation-retry-c" }, { complete }), error => error.status === 404);
  await assert.rejects(translateKnowledgeSelection({ ...input, generationId: "wrong" }, { complete }), error => error.status === 409);
});
