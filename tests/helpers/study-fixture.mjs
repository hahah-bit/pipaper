import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { nativeHttpFixture } from "./native-http-fixture.mjs";

export const sampleBlocks = [
  { id: "title", type: "heading", text: "A Robust Routing Baseline", page: 1 },
  { id: "abstract_h", type: "heading", text: "Abstract", page: 1 },
  { id: "abstract", type: "para", md: "We improve routing robustness using a two-stage baseline. Accuracy is 95% with $x_1=2$.", page: 1 },
  { id: "intro_h", type: "heading", text: "1 Introduction", page: 1 },
  { id: "intro", type: "para", md: "Prior neural routing methods fail under distribution shift. We investigate whether training perturbations help.", page: 1 },
  { id: "method_h", type: "heading", text: "2 Method", page: 1 },
  { id: "method", type: "para", md: "The encoder maps nodes into embeddings. Training uses perturbations, validation selects the checkpoint, and testing measures generalization.", page: 1 },
  { id: "exp_h", type: "heading", text: "3 Experiments", page: 1 },
  { id: "exp", type: "para", md: "We compare matched training budgets and ablate perturbations to test robustness.", page: 1 },
  { id: "table", type: "table", caption: "Table 1. Held-out performance.", html: "<table><tr><th>Method</th><th>Accuracy</th></tr><tr><td>Baseline</td><td>90</td></tr><tr><td>Ours</td><td>95</td></tr></table>", page: 1 },
  { id: "conclusion_h", type: "heading", text: "4 Conclusion", page: 1 },
  { id: "conclusion", type: "para", md: "Perturbations improve held-out accuracy. Behavior on larger graphs remains unknown.", page: 1 },
];
export function samplePdf() {
  const stream = "BT /F1 18 Tf 45 750 Td (A Robust Routing Baseline) Tj 0 -40 Td /F1 12 Tf (Abstract: Accuracy is 95 percent.) Tj 0 -25 Td (Training perturbations improve generalization.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
export function mockStudyResponse(_request, text) {
  let prompt; try { prompt = JSON.parse(text); } catch { return; }
  if (prompt.task === "study_lesson") {
    const sourceId = prompt.blockIds[0];
    return JSON.stringify({ topics: prompt.requiredTopics.map(key => ({ key, text: `论文通过扰动训练检验分布外泛化。${key}需要结合对照实验判断。[查看原文](#block:${sourceId || "abstract"})`, basis: sourceId ? "paper" : "unreported", sources: sourceId ? [sourceId] : [] })),
      coveredBlockIds: prompt.blockIds, paragraphs: prompt.blockIds.map(blockId => ({ blockId, explanation: "本段通过对照实验说明方法的泛化边界。" })), questions: Array.from({ length: ["rough", "summary"].includes(prompt.stage) ? 3 : 2 }, (_, i) => ({ question: `请解释第 ${i + 1} 个核心要点与验证方法？`, rubric: ["说明问题与方法", "说明证据或边界"] })),
      ...(prompt.stage === "rough" ? { matches: (prompt.localKnowledge || []).map(e => ({ id: e.id, relevant: true, reason: "本地证据讨论相同的泛化边界。" })), recommendation: { worthDeep: false, reason: "与目标有交集，但需要用户自行判断是否继续。" } } : {}),
      ...(prompt.stage === "summary" ? { experiments: ["reproduction", "ablation", "destruction", ...(prompt.goalType === "innovate" ? ["innovation"] : [])].map(kind => ({ kind, hypothesis: "扰动提升泛化", variables: "扰动强度", control: "无扰动基线", metrics: "准确率", expected: "跨分布提高", failure: "提升消失" })) } : {}) });
  }
  if (prompt.task === "study_evaluation") return JSON.stringify({ evaluations: prompt.questions.map(q => ({ questionId: q.id, criteria: q.rubric.map(() => prompt.answers[q.id]?.includes("我理解")), feedback: prompt.answers[q.id]?.includes("我理解") ? "已说明机制与证据边界。" : "请补充实验如何支持这个结论。" })) });
  if (prompt.task === "study_research_queries") return JSON.stringify({ queries: [{ query: "neural routing distribution shift robustness", issue: "大规模泛化边界", why: "检索真实规模测试" }] });
  if (prompt.task === "study_plan") return JSON.stringify({ ...prompt.lesson, experiments: prompt.lesson.experiments.map(e => ({ ...e, variables: "扩大图规模与扰动强度" })) });
  if (prompt.task === "precise_translation") return JSON.stringify({ translation: "译文：" + prompt.source, terms: { robustness: "鲁棒性" } });
}
export async function studyFixture(options = {}) {
  const fixture = await nativeHttpFixture({ contextWindow: 64000, respond: mockStudyResponse,
    searchResponse: () => ({ body: '<div class="gs_r"><h3 class="gs_rt"><a href="https://example.org/robust-routing">Robust Routing Follow-up</a></h3><div class="gs_a">A. Researcher - Test Venue, 2026</div><div class="gs_rs">Studies failure under larger graphs.</div><a href="https://example.org/robust-routing.pdf">PDF</a></div>' }), ...options });
  fs.writeFileSync(path.join(fixture.data, "search-sources.json"), JSON.stringify([{ id: "fixture", name: "Local research fixture", type: "scholar-mirror", enabled: true, url: fixture.mockUrl }]));
  const pdf = samplePdf(), hash = createHash("sha256").update(pdf).digest("hex");
  const parsed = path.join(fixture.data, "parsed", "h_" + hash.slice(0, 24));
  fs.mkdirSync(parsed, { recursive: true });
  fs.writeFileSync(path.join(parsed, "blocks.json"), JSON.stringify({ v: 4, meta: { engine: "fixture" }, blocks: sampleBlocks, pages: [{ page: 1, width: 595, height: 842 }] }));
  fs.writeFileSync(path.join(parsed, "full.md"), sampleBlocks.map(b => b.md || b.text || b.html).join("\n"));
  return { ...fixture, pdf, parsed };
}
