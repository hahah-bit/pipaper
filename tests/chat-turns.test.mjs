import test from "node:test";
import assert from "node:assert/strict";
import { ChatTurns, turnRecordLabel } from "../src/chatTurns.js";

test("many assistant/tool steps in one question archive as one record without losing an answer", () => {
  const archives = [];
  const turns = new ChatTurns(turn => archives.push([...turn.nodes]));
  turns.begin();
  const steps = Array.from({ length: 10 }, () => ({ activity: { steps: 1, thinkShown: true }, textAcc: "" }));
  steps.forEach(step => turns.add(step));
  const answer = { textAcc: "Answer with evidence", activity: null };
  turns.add(answer);
  turns.finish(); turns.finish();
  assert.equal(archives.length, 1);
  assert.deepEqual(archives[0], [...steps, answer]);
  assert.equal(turnRecordLabel(archives[0]), "执行记录 · 思考 · 10 次工具调用 · 11 次模型调用");
});
test("busy reconnect archives old turns but leaves the current question live", () => {
  const archives = [];
  const turns = new ChatTurns(turn => archives.push([...turn.nodes]));
  turns.begin(); turns.add("previous");
  turns.begin(); turns.add("running");
  turns.finish({ keepCurrent: true });
  assert.deepEqual(archives, [["previous"]]);
  turns.finish();
  assert.deepEqual(archives, [["previous"], ["running"]]);
  turns.reset(); turns.add("other session"); turns.finish();
  assert.deepEqual(archives.at(-1), ["other session"]);
});
test("late steps and an interrupted question retain their ownership without re-archiving previous steps", () => {
  const sizes = [];
  const turns = new ChatTurns(turn => sizes.push([turn.archived, turn.nodes.length]));
  turns.add({ error: "cancelled" }); turns.finish();
  turns.add({ image: true }); turns.finish();
  turns.begin(); turns.add({ textAcc: "next answer" }); turns.finish();
  assert.deepEqual(sizes, [[0, 1], [1, 2], [0, 1]]);
});
