import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("待读去重保留本地 ID、PDF 和完整标题区分，持久化后可删除", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-toread-"));
  process.env.PIPAPER_DATA_DIR = directory;
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("pipaper-toread-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = await import("../server/toread.js");
  const first = store.toreadAdd({ id: "external-one", title: "One paper", doi: "10.1000/example", pdfUrl: "https://example.test/paper.pdf" });
  const duplicate = store.toreadAdd({ id: "external-two", title: "One paper", doi: " https://doi.org/10.1000/EXAMPLE " });
  assert.equal(duplicate.dup, true);
  assert.equal(duplicate.entry.id, first.entry.id);
  assert.equal(duplicate.entry.pdfUrl, "https://example.test/paper.pdf");
  assert.equal(store.toreadList().length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "to-read.json"), "utf8"));
  assert.equal(saved[0].id, first.entry.id);
  assert.ok(store.toreadDelete(first.entry.id));
  assert.equal(store.toreadList().length, 0);
  const prefix = "Long research topic ".repeat(6);
  store.toreadAdd({ title: prefix + "Part One" });
  store.toreadAdd({ title: prefix + "Part Two" });
  assert.equal(store.toreadList().length, 2);
});
