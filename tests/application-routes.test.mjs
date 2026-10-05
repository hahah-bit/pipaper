import test from "node:test";
import assert from "node:assert/strict";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";

test("拆分后的 HTTP 装配保留文件、资源与独立页面入口", async () => {
  const fixture = await nativeHttpFixture();
  try {
    for (const endpoint of ["/api/files", "/api/papers", "/api/projects", "/api/config", "/api/clip", "/api/search/sources", "/api/search/toread", "/api/storage/resources"]) {
      const response = await fetch(fixture.url + endpoint);
      assert.equal(response.status, 200, endpoint + ": " + await response.text());
    }
    for (const page of ["/", "/videos", "/study/fixture", "/topics", "/topics/fixture"]) {
      const response = await fetch(fixture.url + page), html = await response.text();
      assert.equal(response.status, 200, page); assert.match(html, /theme\.css/, page);
    }
    const invalid = await fetch(fixture.url + "/api/papers/import", { method: "PUT", headers: { "Content-Type": "application/pdf", "X-Filename": "invalid.pdf" }, body: "" });
    assert.equal(invalid.status, 400);
  } finally { await fixture.dispose(); }
});
