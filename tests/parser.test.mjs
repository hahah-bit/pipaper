import test from "node:test";
import assert from "node:assert/strict";
import { mineruBlocks } from "../server/parser/pipeline.js";
import { buildDocument, inlineContent, splitPageContinuations } from "../server/parser/document.js";
import { missingGlyphs, missingTableNumbers } from "../server/parser/evidence.js";
import { fuseAlgorithmMath } from "../server/parser/algorithm-math.js";
import { nativeScriptCandidates } from "../server/parser/algorithms.js";
import { blocksToContext, blocksToMd } from "../server/parser/mdblocks.js";
import { tableStructure } from "../server/parser/tables.js";

const native = { pages: Array.from({ length: 17 }, (_, i) => ({ page: i + 1, width: 600, height: 800, rotation: 0, items: [] })) };
test("structured source owns page, order, title and normalized coordinates", () => {
  const raw = { contentList: [
    { type: "page_number", text: "1", page_idx: 0, bbox: [490, 960, 500, 980] },
    { type: "text", text: "3.1 Vehicle Routing Problems", text_level: 1, page_idx: 2, bbox: [80, 100, 920, 130] },
    { type: "list", list_items: ["1. Index Selection", "2. Probability sampling"], page_idx: 16, bbox: [80, 200, 920, 300] }
  ] };
  const blocks = mineruBlocks(raw, native, () => "");
  const doc = buildDocument(blocks, native, { engine: "hybrid" });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].page, 17);
  assert.deepEqual(blocks[0].bbox, [48, 80, 552, 104]);
  assert.equal(doc.blocks[0].level, 2);
  assert.equal(doc.quality.errors.length, 0);
  assert.equal(doc.sections[0].page, 3);
});
test("unpositioned and out-of-order blocks fail validation, without destructive sorting", () => {
  const input = [{ type: "para", md: "page three", page: 3, bbox: [1, 1, 100, 100] }, { type: "para", md: "unmatched" }, { type: "para", md: "page two", page: 2, bbox: [1, 1, 100, 100] }];
  const doc = buildDocument(input, native, { engine: "hybrid" });
  assert.deepEqual(doc.blocks.map((b) => b.md), input.map((b) => b.md));
  assert.ok(doc.quality.errors.some((e) => e.code === "missing-page"));
  assert.ok(doc.quality.errors.some((e) => e.code === "page-order"));
  assert.equal(input[0].id, undefined);
});
test("double column and side figure are distinct layouts", () => {
  const box = (bbox, type = "para") => ({ type, md: "text ".repeat(40), page: 1, bbox, src: "image.png" });
  const doc = buildDocument([box([40, 80, 290, 180]), box([40, 200, 290, 300]), box([310, 80, 560, 180]), box([310, 200, 560, 300])], native, { engine: "hybrid" });
  assert.equal(doc.pages[0].layout, "double");
  assert.deepEqual(doc.blocks.map((b) => b.column), ["left", "left", "right", "right"]);
  const wrapped = buildDocument([box([40, 80, 290, 280]), box([310, 90, 560, 270], "image")], native, { engine: "hybrid" });
  assert.equal(wrapped.pages[0].layout, "single");
  assert.equal(wrapped.blocks[1].wrapBefore, wrapped.blocks[0].id);
});
test("math spans and code preserve source; invalid math is flagged", () => {
  const text = "where $a_{t}$ and $\\text{two words}$ remain.";
  assert.deepEqual(inlineContent(text).filter((b) => b.type === "math").map((b) => b.latex), ["a_{t}", "\\text{two words}"]);
  const doc = buildDocument([{ type: "formula", latex: "x=1\\tag{2}", page: 1, bbox: [20, 20, 300, 60] }, { type: "para", md: "$\\unknowncommand{x}$", page: 1, bbox: [20, 80, 300, 100] }], native, { engine: "hybrid" });
  assert.deepEqual(doc.blocks[0].issues, []);
  assert.ok(doc.blocks[1].issues.includes("formula-syntax"));
  const code = { type: "code", text: "1: for i\n2:   x_{i} <- f(s)", page: 5, id: "b_algorithm", issues: ["algorithm-math-review"] };
  assert.ok(blocksToContext([code]).includes(code.text));
  assert.ok(blocksToContext([code]).includes("p.5 | b_algorithm"));
  assert.ok(blocksToMd([code]).includes("```\n" + code.text));
});
test("algorithm fusion accepts agreeing math and rejects subscript punctuation OCR", () => {
  assert.equal(fuseAlgorithmMath("∇θJ(θ), s1,", "$\\nabla_{\\theta}J(\\theta), s_{1,}$", [["s1", "s_{1}"]]).text, "∇_{θ}J(θ), s_{1},");
  assert.equal(fuseAlgorithmMath("xj and yk", "$x_i$", [["yk", "y_{k}"]]).text, "xj and y_{k}");
  assert.equal(fuseAlgorithmMath("1 N ∑Nj=1", "$\\frac{1}{N}\\sum_{j=1}^{N}$").text, "(1)/(N) ∑_{j=1}^{N}");
});
test("native script recovery uses size and baseline, not paper-specific names", () => {
  const token = (text, seq, height, y) => ({ text, seq, height, bbox: [seq * 5, y - height, seq * 5 + 4, y] });
  const lines = [{ anchor: token("1:", 0, 10, 100), items: [token("z", 1, 10, 100), token("7", 2, 7, 101.49), token("WORD", 3, 8, 100)] }];
  assert.deepEqual(nativeScriptCandidates(lines), [["z7", "z_{7}"]]);
});
test("table model retains merged headers and identifies broken rows", () => {
  const table = tableStructure('<table><tr><th rowspan="2">Method</th><th colspan="2">TSP</th></tr><tr><td>Len</td><td>Gap</td></tr><tr><td>A</td><td>3.83</td><td>0%</td></tr></table>');
  assert.equal(table.columns, 3);
  assert.equal(table.cells[0].rowspan, 2);
  assert.deepEqual(table.issues, []);
  assert.ok(tableStructure('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>').issues.includes("table-grid-incomplete"));
});
test("native evidence detects OCR-only marks and omitted numeric cells", () => {
  assert.deepEqual(missingGlyphs('x_i=1\\tag{2}', 'x i = 1'), []);
  assert.deepEqual(missingGlyphs('p(a|s)', 'p ( a | s )'), []);
  assert.ok(missingGlyphs('\\bar{x}=1', 'x = 1').length);
  assert.deepEqual(missingTableNumbers([{ text: '6.12' }], '6.12 6.14'), ['6.14']);
});
test("cross-page merged paragraph is split only with unique native boundary evidence", () => {
  const tail = 'The following continuation belongs on the next page. It includes the remaining experiment details and the final observations that must stay together.';
  const n = structuredClone(native);
  n.pages[1].items = [{ text: tail, bbox: [10, 10, 200, 50], seq: 0 }];
  const first = 'This paragraph begins on the previous page with enough distinct context. ';
  const input = [{ type: 'para', md: first + tail, page: 1, bbox: [10, 700, 500, 750] }, { type: 'para', md: '', page: 2, bbox: [10, 10, 500, 80] }];
  const blocks = splitPageContinuations(input, n);
  assert.equal(blocks[0].md, first.trim());
  assert.equal(blocks[1].md, tail);
  assert.equal(input[1].md, '');
  n.pages[1].items[0].text = 'An unrelated next-page paragraph that must not be guessed into a matching location. '.repeat(3);
  assert.equal(splitPageContinuations(input, n)[1].md, '');
});
test('same-page column continuations are recovered without duplicating text', () => {
  const tail = 'This right column continues the paragraph started near the end of the left column. The rest of the passage includes enough unique text to verify both boundaries.';
  const n = structuredClone(native);
  n.pages[0].items = [{ text: tail, bbox: [310, 10, 560, 50], seq: 0 }];
  const start = 'The left column contains an introduction and leads into a continuation. ';
  const blocks = splitPageContinuations([{ type:'para',md:start+tail,page:1,bbox:[40,600,290,750] },{ type:'para',md:'',page:1,bbox:[310,10,560,80] }], n);
  assert.equal(blocks[0].md, start.trim());
  assert.equal(blocks[1].md, tail);
  assert.equal(blocks[1].provenance.repair, 'exact-region-continuation');
});
