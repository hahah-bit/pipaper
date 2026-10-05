import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";

test(
  "storage HTTP adapters retain drafts on conflicts, restore notes and unlink project membership",
  { timeout: 30000 },
  async (t) => {
    const fixture = await nativeHttpFixture();
    t.after(() => fixture.dispose());
    const request = async (route, body, method = body ? "POST" : "GET") => {
      const response = await fetch(fixture.url + "/api" + route, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, value: await response.json() };
    };
    const meta = (
      await request("/notes/ensure", {
        paperId: "fixture-paper",
        title: "证据笔记",
        category: "精读",
      })
    ).value;
    const rel = `精读/${meta.slug}/note.md`,
      saved = await request(
        "/notes/file",
        { path: rel, content: "# 方法\n\n可靠证据。" },
        "PUT",
      );
    assert.equal(saved.status, 200);
    const read = await request("/notes/file?path=" + encodeURIComponent(rel));
    assert.equal(read.value.revision, saved.value.revision);
    const updated = await request(
      "/notes/file",
      {
        path: rel,
        content: "# 方法\n\n新证据。",
        revision: read.value.revision,
      },
      "PUT",
    );
    assert.equal(updated.status, 200);
    const conflict = await request(
      "/notes/file",
      { path: rel, content: "旧草稿", revision: read.value.revision },
      "PUT",
    );
    assert.equal(conflict.status, 409);
    assert.equal(
      (await request("/notes/file?path=" + encodeURIComponent(rel))).value
        .content,
      "# 方法\n\n新证据。",
    );
    const listed = (await request("/storage/resources?kind=knowledge")).value
        .resources,
      r = listed.find((r) => r.location.endsWith("note.md"));
    assert.equal(r.sourcePaperId, "fixture-paper");
    const job = (await request("/ingestion/jobs", { resourceId: r.id })).value;
    for (let i = 0; i < 30; i++) {
      const jobs = (
        await request("/ingestion/jobs?resourceId=" + encodeURIComponent(r.id))
      ).value.jobs;
      if (jobs[0].status === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(
      (await request("/ingestion/jobs?resourceId=" + encodeURIComponent(r.id)))
        .value.jobs[0].status,
      "blocked",
    );
    await request(
      "/storage/resources/" + encodeURIComponent(r.id),
      null,
      "DELETE",
    );
    assert.equal(
      (await request("/notes/file?path=" + encodeURIComponent(rel))).status,
      404,
    );
    assert.equal(
      (await request("/rag/search", { query: "证据", resourceIds: [r.id] }))
        .value.results.length,
      0,
    );
    assert.equal(
      (await request("/ingestion/jobs?resourceId=" + encodeURIComponent(r.id)))
        .value.jobs[0].status,
      "cancelled",
    );
    await request(
      "/storage/resources/" + encodeURIComponent(r.id) + "/restore",
      {},
    );
    assert.equal(
      (await request("/notes/file?path=" + encodeURIComponent(rel))).status,
      200,
    );
    const project = (await request("/projects", { name: "项目归属" })).value;
    await request(
      "/projects/" + project.id,
      { addPaper: "fixture-paper" },
      "PUT",
    );
    await request("/projects/" + project.id, null, "DELETE");
    assert.ok(
      (await request("/papers")).value.papers.some(
        (p) => p.id === "fixture-paper",
      ),
    );
    await request(
      "/storage/resources/" +
        encodeURIComponent("project:" + project.id) +
        "/restore",
      {},
    );
    assert.ok(
      (await request("/papers")).value.projects.some(
        (p) => p.id === project.id && p.paperIds.includes("fixture-paper"),
      ),
    );
    fs.rmSync(r.location);
    await fixture.restart();
    const missing = (
      await request("/storage/resources/" + encodeURIComponent(r.id))
    ).value.resource;
    assert.equal(missing.availability, "missing");
    assert.equal(
      (
        await request(
          "/storage/resources/" + encodeURIComponent(r.id) + "/repair",
          { revision: missing.revision - 1 },
        )
      ).status,
      409,
    );
    const repaired = await request(
      "/storage/resources/" + encodeURIComponent(r.id) + "/repair",
      { revision: missing.revision },
    );
    assert.equal(repaired.status, 200);
    assert.equal(repaired.value.availability, "ready");
    assert.equal(fs.readFileSync(r.location, "utf8"), "# 方法\n\n新证据。");
  },
);
