import test from "node:test";
import assert from "node:assert/strict";
import { sourceBounds } from "../server/parser/regions.js";

test("algorithm source crop includes its adjacent title without changing stored bounds", () => {
  const heading = { type: "heading", algorithm: true, page: 5, bbox: [40, 100, 260, 110] };
  const code = { type: "code", algorithm: true, page: 5, bbox: [45, 115, 550, 290] };
  const blocks = [heading, code];
  const before = JSON.stringify(blocks);
  assert.deepEqual(sourceBounds(code, blocks), [36, 96, 554, 294]);
  assert.equal(JSON.stringify(blocks), before);
  assert.deepEqual(sourceBounds(code, [{ ...heading, page: 4 }, code]), [41, 111, 554, 294]);
  assert.deepEqual(sourceBounds(code, [{ ...heading, algorithm: false }, code]), [41, 111, 554, 294]);
  assert.deepEqual(sourceBounds(code, [{ ...heading, bbox: [40, 50, 260, 60] }, code]), [41, 111, 554, 294]);
});
