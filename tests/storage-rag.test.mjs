import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipaper-storage-rag-"));
process.env.PIPAPER_DATA_DIR = path.join(root, "data");
process.env.PIPAPER_LIBRARY_DIR = path.join(root, "library");
process.env.PIPAPER_KNOWLEDGE_DIR = path.join(root, "knowledge");
const catalog = await import("../server/storage/catalog.js"),
  files = await import("../server/storage/files.js");
const {
  normalizeDocument,
  chunkDocument,
  hydrate,
  validateCandidate,
  references,
} = await import("../server/rag/document.js");
const { startIngestion, runJob, controlJob } = await import(
  "../server/rag/ingestion.js"
);
const { embed, waiting, modelJson, expand } = await import(
  "../server/rag/providers.js"
);
const { rrf, VectorIndex } = await import("../server/rag/milvus.js");
const { searchKnowledge } = await import("../server/rag/search.js");
const { saveConfig } = await import("../server/config.js");
const { flushStore } = await import("../server/store.js");
const { managedPiTools } = await import("../server/storage/pi-tools.js");
test.after(() => {
  flushStore();
  catalog.closeCatalog();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});
saveConfig({ rag: { expansion: false } });
const make = (name, text = "# 标题\n\n可核验的正文内容。") =>
  files.writeFile(path.join(root, "knowledge", name + ".md"), text, {
    kind: "knowledge",
    sourceType: "note",
    title: name,
  });
const vector = () => [1, 0];
const services = {
  repair: async () => ({}),
  embed: async (texts) => texts.map(vector),
  index: { write: async () => {} },
};
test("content-addressed objects deduplicate and old revisions survive CAS conflicts", () => {
  const a = make("a", "old"),
    b = make("b", "old");
  assert.equal(a.objectPath, b.objectPath);
  const next = files.writeFile(a.location, "new", {
    expectedRevision: a.revision,
  });
  assert.ok(next.revision > a.revision);
  assert.equal(
    fs.readFileSync(
      catalog.history(a.id).find((v) => v.hash === a.hash).objectPath,
      "utf8",
    ),
    "old",
  );
  assert.throws(
    () => files.writeFile(a.location, "late", { expectedRevision: a.revision }),
    (e) => e.status === 409,
  );
  assert.equal(fs.readFileSync(a.location, "utf8"), "new");
});

test("an imported file's first revision remains readable after its first managed update", () => {
  const file = path.join(root, "knowledge", "legacy.md");
  fs.writeFileSync(file, "原始内容");
  const imported = files.registerFile(file, { kind: "knowledge" });
  assert.equal(imported.objectPath, null);
  files.writeFile(file, "更新内容", { expectedRevision: imported.revision });
  const first = catalog
    .history(imported.id)
    .find((v) => v.revision === imported.revision);
  assert.equal(fs.readFileSync(first.objectPath, "utf8"), "原始内容");
  assert.equal(fs.readFileSync(file, "utf8"), "更新内容");
});

test("a fully quarantined document retains review evidence without publishing an index", async () => {
  const r = make("all-pending"),
    j = startIngestion(r.id, { schedule: false });
  const result = await runJob(j.id, {
    services: {
      ...services,
      parse: async () => ({
        blocks: [
          {
            id: "uncertain",
            type: "para",
            md: "待确认的扫描正文。",
            page: 1,
            issues: ["ocr-unresolved"],
          },
        ],
      }),
      index: {
        write: async () => {
          throw new Error("must not publish uncertain evidence");
        },
      },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.waitingFor, "review");
  assert.equal(catalog.published(r.id), null);
  const generation = catalog.generations(r.id)[0];
  assert.equal(generation.coverage.chunks, 0);
  const review = catalog.records(generation.id, "review")[0];
  assert.equal(review.blockId, "uncertain");
  assert.ok(review.issues.includes("ocr-unresolved"));
  assert.equal(
    catalog.records(generation.id, "text")[0].text,
    "待确认的扫描正文。",
  );
});

test("Pi write and exact-edit tools retain managed history and never own external workspace files", async () => {
  const [write, edit] = managedPiTools({
    paperId: "source-paper",
    id: "agent-test",
  });
  const target = path.join(root, "knowledge", "pi-note.md");
  await write.execute("w1", { path: target, content: "初始证据。" });
  const first = catalog.resourceAt(target);
  assert.equal(first.kind, "knowledge");
  assert.equal(first.sourcePaperId, "source-paper");
  await edit.execute("e1", {
    path: target,
    edits: [{ oldText: "初始", newText: "修订" }],
  });
  assert.equal(fs.readFileSync(target, "utf8"), "修订证据。");
  assert.equal(
    fs.readFileSync(
      catalog.history(first.id).find((v) => v.hash === first.hash).objectPath,
      "utf8",
    ),
    "初始证据。",
  );
  files.trash(first.id);
  await assert.rejects(
    write.execute("w2", { path: target, content: "迟到内容" }),
    /已删除/,
  );
  assert.equal(fs.existsSync(target), false);
  const external = path.join(root, "external-workspace.md");
  await write.execute("outside", { path: external, content: "工作区内容" });
  const reference = catalog.resourceAt(external);
  assert.equal(reference.owned, false);
  files.trash(reference.id);
  assert.equal(fs.readFileSync(external, "utf8"), "工作区内容");
});
test("shared resource ownership and external files survive another owner's deletion", () => {
  const dir = path.join(root, "owner");
  fs.mkdirSync(dir);
  const owner = files.registerFile(dir, { id: "owner", kind: "study" });
  const child = files.writeFile(path.join(dir, "shared.md"), "shared", {
    owner: owner.id,
  });
  catalog.putResource({ id: "consumer", kind: "study" });
  catalog.link("consumer", child.id, "uses");
  files.trash(owner.id);
  assert.equal(catalog.resource(child.id).lifecycle, "active");
  assert.ok(fs.existsSync(child.location));
  files.restore(owner.id);
  const external = path.join(root, "zotero.pdf");
  fs.writeFileSync(external, "external");
  files.registerFile(external, {
    id: "external",
    kind: "original",
    owned: false,
  });
  files.trash("external");
  assert.ok(fs.existsSync(external));
  files.restore("external");
});
test("trash move failure is hidden, retryable and idempotent; restore conflicts preserve both copies", (t) => {
  const r = make("locked"),
    rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (from === r.location) throw new Error("locked");
    return rename(from, to);
  });
  assert.throws(() => files.trash(r.id), /locked/);
  assert.equal(catalog.resource(r.id).lifecycle, "trashed");
  assert.ok(
    catalog
      .operations()
      .some((o) => o.resourceId === r.id && o.status === "failed"),
  );
  mock.mock.restore();
  files.trash(r.id);
  assert.ok(!fs.existsSync(r.location));
  files.trash(r.id);
  fs.writeFileSync(r.location, "new user file");
  assert.throws(
    () => files.restore(r.id),
    (e) => e.status === 409,
  );
  assert.equal(fs.readFileSync(r.location, "utf8"), "new user file");
  fs.rmSync(r.location);
  files.restore(r.id);
  files.restore(r.id);
  assert.equal(catalog.resource(r.id).lifecycle, "active");
});
test("permanent cleanup never reports success while vector cleanup is unavailable", async () => {
  const r = make("purge");
  files.trash(r.id);
  await assert.rejects(
    files.purge(r.id, async () => {
      throw waiting("offline");
    }),
    /offline/,
  );
  assert.equal(catalog.resource(r.id).lifecycle, "purging");
  await files.purge(r.id);
  assert.equal(catalog.resource(r.id).lifecycle, "deleted");
  assert.throws(
    () => files.restore(r.id),
    (e) => e.status === 409,
  );
});
function document() {
  return {
    meta: { title: "论文" },
    blocks: [
      { id: "h", type: "heading", level: 1, text: "方法" },
      { id: "intro", type: "para", md: "父标题引导文字。", page: 1 },
      { id: "hh", type: "heading", level: 2, text: "网络结构", page: 1 },
      {
        id: "p",
        type: "para",
        md: "如图 3 和表 2 所示，结合公式 1，模型包含三个模块。",
        page: 1,
      },
      {
        id: "fig",
        type: "image",
        caption: "图 3：模型架构",
        description: "三个模块连接",
        shortDescription: "模型三个模块",
        page: 3,
        assetId: "asset",
      },
      {
        id: "tbl",
        type: "table",
        caption: "表 2：实验结果",
        html: "<table><tr><th colspan='2'>结果</th></tr><tr><td>精度</td><td>95</td></tr></table>",
        page: 2,
      },
      { id: "eq", type: "formula", latex: "y=x+1\\tag{1}", page: 2 },
      {
        id: "foot",
        type: "footnote",
        text: "* 模型仅在给定数据集验证。",
        page: 1,
      },
    ],
  };
}
const options = {
  resourceId: "paper",
  versionId: "version",
  generationId: "generation",
};
test("reference numbers resolve across pages, retain merged HTML and formula, and hydrate at placeholders", () => {
  const doc = normalizeDocument(document(), options),
    text = doc.texts.find((t) => t.blockId === "p");
  assert.equal(text.quality, "ready");
  assert.equal(text.elementIds.length, 3);
  assert.ok(text.text.includes("（注："));
  const chunks = chunkDocument(doc);
  assert.equal(chunks[0].sectionPath.join("/"), "方法");
  assert.equal(chunks[1].sectionPath.join("/"), "方法/网络结构");
  const parts = hydrate(chunks[1], doc.elements, {
    loadImage: () => ({ data: "aGVsbG8=", mimeType: "image/png" }),
  });
  assert.ok(parts.some((p) => p.type === "image" && p.data));
  assert.ok(
    parts.some((p) => p.type === "table" && p.html.includes("colspan")),
  );
  assert.ok(parts.some((p) => p.type === "formula" && p.latex.includes("tag")));
});
test("explicit table continuations restore every page at a numbered reference without treating duplicates as continuations", () => {
  const blocks = [
    { id: "heading", type: "heading", level: 1, text: "Cities" },
    { id: "intro", type: "para", page: 1, text: "Details are in Table 5." },
    {
      id: "main",
      type: "table",
      page: 2,
      caption: "Table 5: City details",
      html: "<table><tr><td>City A</td></tr></table>",
    },
    {
      id: "continued",
      type: "table",
      page: 3,
      caption: "Table 5 – Continued from previous page",
      html: "<table><tr><td>City B</td></tr></table>",
    },
  ];
  const doc = normalizeDocument({ blocks }, options);
  assert.equal(doc.texts[0].quality, "ready");
  assert.equal(doc.texts[0].elementIds.length, 2);
  const chunk = chunkDocument(doc)[0];
  assert.deepEqual(
    hydrate(chunk, doc.elements)
      .filter((p) => p.type === "table")
      .map((p) => p.page),
    [2, 3],
  );
  assert.equal(doc.body.filter((r) => r.kind === "table").length, 0);
  const duplicate = normalizeDocument(
    { blocks: [...blocks, { ...blocks[2], id: "independent", page: 4 }] },
    options,
  );
  assert.equal(duplicate.texts[0].quality, "needs_review");
  assert.ok(
    duplicate.reviews.some((r) => r.issues.includes("ambiguous-reference")),
  );
});

test("ambiguous scientific references and model uncertainty are quarantined", () => {
  const source = document();
  source.blocks.push({ ...source.blocks[4], id: "fig-duplicate" });
  const doc = normalizeDocument(source, options);
  assert.equal(
    doc.texts.find((t) => t.blockId === "p").quality,
    "needs_review",
  );
  assert.ok(doc.reviews.some((r) => r.issues.includes("ambiguous-reference")));
  assert.ok(
    validateCandidate(
      {},
      {
        kind: "table",
        html: "<table><tr><td>1</td></tr></table>",
        shortDescription: "table",
        uncertain: true,
      },
    ).includes("model-uncertain"),
  );
  assert.ok(
    validateCandidate(
      {},
      { kind: "formula", latex: "\\unknownbad", shortDescription: "equation" },
    ).includes("formula-syntax"),
  );
  const invalid = {
    kind: "formula",
    latex: "\\np_{ij}",
    shortDescription: "transition",
    uncertain: false,
  };
  assert.ok(
    validateCandidate({}, { ...invalid, latex: "" }).includes("formula-syntax"),
  );
  assert.ok(
    validateCandidate({}, { ...invalid, shortDescription: 42 }).includes(
      "missing-description",
    ),
  );
  assert.ok(
    validateCandidate(
      { nativeText: "pij", issues: ["math-source-conflict"] },
      invalid,
    ).includes("formula-syntax"),
  );
  const withBadMath = normalizeDocument(
    {
      blocks: [
        { id: "safe", type: "para", md: "可核验正文。" },
        {
          id: "bad",
          type: "formula",
          nativeText: "pij",
          latex: "p_{ij}",
          issues: ["math-source-conflict"],
        },
      ],
    },
    { ...options, repairs: { bad: invalid } },
  );
  assert.ok(withBadMath.reviews.some((v) => v.blockId === "bad"));
  assert.ok(
    chunkDocument(withBadMath).some((c) => c.text.includes("可核验正文")),
  );
});
test("recursive chunks obey UTF-8 budgets and preserve placeholders and title IDs", () => {
  const source = document();
  source.blocks[3].md =
    "中文语义。".repeat(500) + "如图 3 所示。" + "额外解释。".repeat(400);
  const doc = normalizeDocument(source, options);
  const chunks = chunkDocument(doc, {
    targetBytes: 450,
    maxBytes: 600,
    overlapBytes: 30,
  });
  for (const c of chunks) {
    assert.ok(
      Buffer.byteLength(c.text) +
        Buffer.byteLength(c.sectionPath.join(" > ")) +
        16 <=
        600,
    );
    assert.ok(!c.text.includes("�"));
    assert.equal(
      (c.text.match(/\[\[/g) || []).length,
      (c.text.match(/\]\]/g) || []).length,
    );
  }
  const nested = chunks.filter((c) => c.sectionPath.length === 2);
  assert.ok(nested.length > 5);
  assert.equal(new Set(nested.map((c) => c.sectionId)).size, 1);
});
test("headers are removed while scientific notes remain, and Markdown tables become HTML", () => {
  const source = {
    blocks: [
      { id: "head", type: "header", text: "journal header", page: 1 },
      { id: "para", type: "para", md: "正文[^1]。", page: 1 },
      { id: "note", type: "footnote", text: "1 数据范围说明", page: 1 },
      {
        id: "table",
        type: "table",
        md: "|单位|值|\n|---|---|\n|mm|2|",
        page: 1,
      },
    ],
  };
  const doc = normalizeDocument(source, options);
  assert.ok(doc.dropped.length);
  assert.ok(doc.texts[0].text.includes("数据范围说明"));
  assert.ok(
    doc.elements.find((e) => e.kind === "table").html.includes("<table>"),
  );
});
test("persistent ingestion deduplicates requests and publishes validated canonical evidence", async () => {
  const r = make("indexable"),
    j = startIngestion(r.id, { schedule: false });
  assert.equal(startIngestion(r.id, { schedule: false }).id, j.id);
  const result = await runJob(j.id, { services });
  assert.equal(result.status, "succeeded");
  assert.equal(catalog.published(r.id).id, j.generationId);
  const chunks = catalog.records(j.generationId, "chunk");
  assert.ok(chunks.length);
  assert.ok(catalog.readState("ingestion-stage:" + j.keys[0].key, null));
  const index = {
    search: async () => [
      [
        {
          canonical_id: chunks[0].id,
          resource_id: r.id,
          generation_id: j.generationId,
        },
      ],
      [],
    ],
  };
  const found = await searchKnowledge("正文", {
    selfRag: false,
    resourceIds: [r.id],
    services: {
      embed: services.embed,
      index,
      rerank: async (_q, docs) => docs.map((_, index) => ({ index, score: 1 })),
    },
  });
  assert.equal(found.results.length, 1);
  files.trash(r.id);
  const hidden = await searchKnowledge("正文", {
    resourceIds: [r.id],
    services: {
      embed: () => {
        throw new Error("must not request embedding");
      },
      index,
    },
  });
  assert.equal(hidden.results.length, 0);
  files.restore(r.id);
});
test("late indexing responses after cancellation or revision changes cannot publish", async () => {
  for (const mode of ["cancel", "update"]) {
    const r = make("late-" + mode),
      j = startIngestion(r.id, { schedule: false });
    let release, entered;
    const gate = new Promise((resolve) => {
      entered = resolve;
    });
    const running = runJob(j.id, {
      services: {
        ...services,
        index: {
          write: async () => {
            entered();
            await new Promise((resolve) => {
              release = resolve;
            });
          },
        },
      },
    });
    await gate;
    if (mode === "cancel") controlJob(j.id, "cancel");
    else catalog.putResource({ ...catalog.resource(r.id), title: "changed" });
    release();
    await running;
    assert.equal(catalog.published(r.id), null);
    assert.equal(catalog.job(j.id).status, "cancelled");
  }
});
test("service outages keep resumable checkpoints and the prior published generation", async () => {
  const r = make("blocked"),
    j = startIngestion(r.id, { schedule: false });
  const failed = await runJob(j.id, {
    services: {
      ...services,
      index: {
        write: async () => {
          throw waiting("Milvus offline");
        },
      },
    },
  });
  assert.equal(failed.status, "blocked");
  assert.ok(failed.completedStages.includes("embed"));
  const resumed = catalog.saveJob({
    ...failed,
    status: "queued",
    epoch: failed.epoch + 1,
  });
  assert.equal((await runJob(resumed.id, { services })).status, "succeeded");
});
test("embedding uses document/query types, batches at ten, validates dimensions and caches", async () => {
  const calls = [],
    config = {
      url: "https://workspace.example/api",
      model: "test",
      dimension: 2,
    };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return {
      ok: true,
      json: async () => ({
        output: {
          embeddings: body.input.texts.map((_, text_index) => ({
            text_index,
            embedding: [1, 0],
          })),
        },
      }),
    };
  };
  const texts = Array.from({ length: 21 }, (_, i) => "evidence " + i);
  assert.equal(
    (await embed(texts, { config, key: "local-test", fetchImpl })).length,
    21,
  );
  assert.deepEqual(
    calls.map((c) => c.input.texts.length),
    [10, 10, 1],
  );
  await embed(texts, { config, key: "local-test", fetchImpl });
  assert.equal(calls.length, 3);
  await embed([texts[0]], {
    type: "query",
    config,
    key: "local-test",
    fetchImpl,
  });
  assert.equal(calls.at(-1).parameters.text_type, "query");
  await assert.rejects(
    embed(["wrong"], {
      config: { ...config, dimension: 3 },
      key: "local-test",
      fetchImpl,
    }),
    /维数/,
  );
});
test("RRF deduplicates variants before ranks and excludes unpublished or deleted evidence", () => {
  const lists = [
    [
      { canonical_id: "a" },
      { canonical_id: "a" },
      { canonical_id: "b" },
      { canonical_id: "hidden" },
    ],
    [{ canonical_id: "b" }, { canonical_id: "a" }],
  ];
  const result = rrf(lists, { valid: (h) => h.canonical_id !== "hidden" });
  assert.equal(result.length, 2);
  assert.equal(result[0].score, result[1].score);
});
test("explicit reimport creates a new resource without reviving the deleted version", () => {
  const old = make("reimport", "old");
  files.trash(old.id);
  const fresh = files.createFile(old.location, "new", { kind: "knowledge" });
  assert.notEqual(fresh.id, old.id);
  assert.equal(catalog.resource(old.id).lifecycle, "trashed");
  files.writeFile(fresh.location, "newer");
  assert.equal(catalog.resourceAt(fresh.location).id, fresh.id);
  assert.throws(
    () => files.restore(old.id),
    (e) => e.status === 409,
  );
});
test("export replacement retains IDs, versions and recoverable directory checkpoints", (t) => {
  const target = path.join(root, "export"),
    temp = path.join(root, "export.tmp");
  const old = files.writeFile(path.join(target, "report.md"), "old", {
    kind: "knowledge",
  });
  files.registerTree(target);
  files.writeFile(path.join(temp, "report.md"), "new", { kind: "knowledge" });
  files.registerTree(temp);
  const rename = fs.renameSync,
    mock = t.mock.method(fs, "renameSync", (from, to) => {
      if (from === temp) throw new Error("interrupted publish");
      return rename(from, to);
    });
  assert.throws(() => files.commitDirectory(temp, target), /interrupted/);
  assert.equal(fs.readFileSync(old.location, "utf8"), "old");
  mock.mock.restore();
  const pending = catalog
    .operations()
    .find((o) => o.type === "directory-publish" && o.status === "failed");
  files.finishDirectory(pending);
  files.finishDirectory(pending);
  assert.equal(catalog.resourceAt(old.location).id, old.id);
  assert.equal(fs.readFileSync(old.location, "utf8"), "new");
  assert.equal(
    fs.readFileSync(
      catalog.history(old.id).find((v) => v.hash === old.hash).objectPath,
      "utf8",
    ),
    "old",
  );
});
test("restart refuses an obsolete write and cancels a queued job with a changed revision", async () => {
  const r = make("recover", "current"),
    blob = files.asset(Buffer.from("late"));
  const op = catalog.operation({
    type: "write",
    status: "pending",
    resourceId: r.id,
    location: r.location,
    objectPath: blob.path,
    baseRevision: r.revision - 1,
  });
  const { recoverStorage } = await import("../server/storage/migration.js");
  recoverStorage();
  assert.equal(
    catalog.operations().find((o) => o.id === op.id).status,
    "cancelled",
  );
  assert.equal(fs.readFileSync(r.location, "utf8"), "current");
  const j = startIngestion(r.id, { schedule: false });
  catalog.putResource({ ...catalog.resource(r.id), title: "updated" });
  assert.equal((await runJob(j.id, { services })).status, "cancelled");
  assert.equal(catalog.published(r.id), null);
});
test("subfigures, inline formulas and manual ambiguous bindings preserve canonical attachments", () => {
  const source = {
    blocks: [
      { id: "p", type: "para", md: "见 Figure 3(a)，计算 $y=x+1$。" },
      {
        id: "parent",
        type: "image",
        caption: "Figure 3",
        description: "whole",
      },
      {
        id: "child",
        type: "image",
        caption: "Figure 3a",
        description: "panel",
      },
    ],
  };
  const doc = normalizeDocument(source, options),
    p = doc.texts[0];
  assert.equal(p.quality, "ready");
  assert.equal(p.elementIds.length, 2);
  assert.ok(p.text.includes("[[formula:"));
  assert.equal(
    doc.elements.find((e) => e.id === p.elementIds[0]).blockId,
    "child",
  );
  assert.equal(doc.body.filter((r) => r.blockId === "child").length, 0);
  const ambiguous = document();
  ambiguous.blocks.push({ ...ambiguous.blocks[4], id: "duplicate" });
  const repaired = normalizeDocument(ambiguous, {
    ...options,
    repairs: {
      p: {
        kind: "text",
        text: ambiguous.blocks[3].md,
        humanVerified: true,
        uncertain: false,
        references: { "image:3": "fig" },
      },
    },
  });
  assert.equal(repaired.texts.find((t) => t.blockId === "p").quality, "ready");
});
test("model format failures stay reviewable rather than becoming configuration errors", async () => {
  const runtime = {
    getAvailable: async () => [
      { provider: "test", id: "vision", input: ["text", "image"] },
    ],
    streamSimple: async function* () {
      yield { type: "text_delta", delta: "not JSON" };
    },
  };
  await assert.rejects(
    modelJson({
      runtime,
      models: [{ provider: "test", id: "vision" }],
      text: "region",
      system: "verify",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    }),
    (e) =>
      e.status === 422 &&
      !e.waitingConfiguration &&
      e.modelDiagnostics.output === "not JSON",
  );
  assert.throws(
    () => saveConfig({ rag: { embedding: { apiKey: "secret" } } }),
    (e) => e.status === 422,
  );
  assert.throws(
    () => saveConfig({ rag: { chunk: { maxBytes: 7000 } } }),
    (e) => e.status === 422,
  );
});
test("expansion retries malformed or unsupported candidates without caching them as evidence", async () => {
  let calls = 0;
  const valid = {
    background: "Source observation.",
    unsupported: false,
    questions: [
      { language: "zh", text: "观测说明了什么？" },
      { language: "zh", text: "来源包含哪些观测？" },
      { language: "en", text: "What is observed?" },
      { language: "en", text: "What does the source describe?" },
    ],
  };
  const runtime = {
    getAvailable: async () => [
      { provider: "test", id: "expansion", input: ["text"] },
    ],
    streamSimple: async function* (_model, input) {
      calls++;
      const output =
        calls === 1
          ? { ...valid, background: 42 }
          : calls === 2
            ? { ...valid, background: "Observed 99 samples." }
            : valid;
      if (calls > 1)
        assert.ok(
          JSON.parse(input.messages[0].content[0].text).validationFeedback,
        );
      yield { type: "text_delta", delta: JSON.stringify(output) };
    },
  };
  const chunk = {
    text: "Source observation.",
    sectionPath: ["expansion-retry"],
  };
  const opts = { runtime, models: [{ provider: "test", id: "expansion" }] };
  const result = await expand(chunk, "", opts);
  assert.equal(calls, 3);
  assert.equal(result.background, valid.background);
  assert.equal(
    catalog.readState(`expansion-rejected:${result.fingerprint}:1`).error,
    "扩写包含来源未支持的数值",
  );
  assert.deepEqual(await expand(chunk, "", opts), result);
  assert.equal(calls, 3);
});

test("migration scan is read-only, application is idempotent and rollback preserves files", () => {
  const sandbox = path.join(root, "migration-fixture"),
    data = path.join(sandbox, "data"),
    knowledge = path.join(sandbox, "knowledge");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(knowledge);
  fs.writeFileSync(
    path.join(data, "papers.json"),
    JSON.stringify({ papers: [] }),
  );
  fs.writeFileSync(path.join(knowledge, "note.md"), "# Note\nSource.");
  const cli = fileURLToPath(
      new URL("../scripts/storage-migrate.mjs", import.meta.url),
    ),
    env = {
      ...process.env,
      PIPAPER_DATA_DIR: data,
      PIPAPER_LIBRARY_DIR: path.join(sandbox, "library"),
      PIPAPER_KNOWLEDGE_DIR: knowledge,
    };
  const invoke = (mode) =>
    execFileSync(process.execPath, [cli, mode], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.equal(JSON.parse(invoke("--scan")).missing.length, 0);
  assert.equal(fs.existsSync(path.join(data, "storage")), false);
  const applied = JSON.parse(invoke("--apply"));
  assert.deepEqual(JSON.parse(invoke("--apply")), applied);
  invoke("--rollback");
  assert.equal(
    fs.readFileSync(path.join(knowledge, "note.md"), "utf8"),
    "# Note\nSource.",
  );
  assert.ok(
    fs.existsSync(path.join(data, "storage", "catalog-before-rollback.sqlite")),
  );
});
