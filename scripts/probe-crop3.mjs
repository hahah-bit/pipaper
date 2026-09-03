import { renderPage } from "../server/parser/render.js";

const a = "library/Attention Is All You Need (Vaswani et al., 2017).pdf";
const d = "library/DynamoLLM - Energy-adaptive LLM Serving (Stojkovic et al., 2024).pdf";

for (const [name, pdf, page] of [
  ["attention p1", a, 1],
  ["attention p2", a, 2],
  ["attention p3", a, 3],
  ["dynamo p1", d, 1],
  ["dynamo p3", d, 3],
]) {
  console.log("render", name, "…");
  try {
    const r = await renderPage(pdf, page, 2);
    console.log("   ok", r.width, "x", r.height);
  } catch (e) {
    console.log("   JS ERROR:", e.message?.slice(0, 120));
  }
}
console.log("done");
