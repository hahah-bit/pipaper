import test from "node:test";
import assert from "node:assert/strict";
import { makeCheckpoints, roughBlocks, validateEvaluation, advanceTask, parseModelJson } from "../server/study-flow.js";
import { protectTranslation, restoreTranslation, splitTranslation, translationKey } from "../server/study-translation.js";
import { sampleBlocks } from "./helpers/study-fixture.mjs";

test("reading checkpoints cover the paper, restrict rough reading and cannot skip mastery gates", () => {
  const checkpoints = makeCheckpoints({ blocks: sampleBlocks });
  assert.deepEqual(checkpoints.map(c => c.kind), ["rough", "introduction", "method", "experiments", "summary"]);
  assert.ok(checkpoints[0].blockIds.includes("abstract")); assert.ok(checkpoints[0].blockIds.includes("conclusion"));
  assert.ok(!checkpoints[0].blockIds.includes("method"));
  assert.deepEqual(roughBlocks({ blocks: [{ id: "title", type: "heading", text: "Title" }, { id: "unknown", type: "para", md: "Unclassified full body" }] }).map(b => b.id), ["title"], "missing section markers cannot accidentally unlock the full body in rough reading");
  const covered = new Set(checkpoints.filter(c => c.stage === "deep").flatMap(c => c.blockIds));
  assert.ok(sampleBlocks.every(b => covered.has(b.id)));
  const task = { status: "active", cursor: 0, checkpoints, artifacts: [] };
  assert.throws(() => advanceTask(task), /考查/);
  checkpoints[0].status = "passed";
  advanceTask(task); assert.equal(task.cursor, 1, "a negative recommendation never blocks an explicit choice to continue");
  task.cursor = 2; checkpoints[2].status = "passed";
  assert.throws(() => advanceTask(task), /架构图/);
  task.artifacts = ["architecture", "pipeline"].map(kind => ({ kind, checkpointId: checkpoints[2].id, historical: true }));
  assert.throws(() => advanceTask(task), /架构图/, "old-version diagrams cannot satisfy current evidence requirements");
  task.artifacts.forEach(a => a.historical = false); advanceTask(task); assert.equal(task.cursor, 3);
});
test("malformed or incomplete evaluations never pass; each rubric item must be a boolean", () => {
  const cp = { lesson: { questions: [{ id: "q1", rubric: ["mechanism", "evidence"] }] } };
  assert.throws(() => validateEvaluation({ evaluations: [] }, cp, { q1: "a" }));
  assert.throws(() => validateEvaluation({ evaluations: [{ questionId: "q1", criteria: [true, "true"], feedback: "ok" }] }, cp, { q1: "a" }));
  assert.equal(validateEvaluation({ evaluations: [{ questionId: "q1", criteria: [true, false], feedback: "missing evidence" }] }, cp, { q1: "a" }).passed, false);
  assert.throws(() => parseModelJson("通过！跳到总结"));
});
test("structured output accepts fenced JSON but never repairs or invents assessment fields", () => {
  assert.deepEqual(parseModelJson('```JSON\n{"text":"### 问题与动机\\n公式 $x_1=2$"}\n```'), { text: "### 问题与动机\n公式 $x_1=2$" });
  for (const text of ['### 问题与动机\n普通讲解', '{"evaluations":', '{"passed":true} {"passed":false}', '[]', '```json\n{}\n```\n```json\n{}\n```']) {
    assert.throws(() => parseModelJson(text), error => error.status === 422 && error.modelDiagnostics.output === text && !!error.modelDiagnostics.reason);
  }
});
test("translation protects formulas, tables and numeric values without cutting long blocks", () => {
  const original = '<table><tr><td>95%</td><td>$x_1=2$</td></tr></table>' + "Long scientific sentence. ".repeat(600);
  const protectedSource = protectTranslation(original);
  const pieces = splitTranslation(protectedSource.text);
  assert.ok(pieces.length > 2); assert.equal(pieces.join(""), protectedSource.text);
  assert.equal(restoreTranslation(pieces.join(""), protectedSource.tokens), original);
  assert.throws(() => restoreTranslation(protectedSource.text.replace("⟦PIPAPER_0⟧", ""), protectedSource.tokens));
  const input = { block: { type: "para", md: "95%" }, versionId: "v_a", model: { provider: "mock", id: "one" } };
  assert.notEqual(translationKey(input), translationKey({ ...input, versionId: "v_b" }));
  assert.notEqual(translationKey(input), translationKey({ ...input, model: { provider: "mock", id: "two" } }));
});
