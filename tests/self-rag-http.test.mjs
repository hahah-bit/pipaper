import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";

test(
  "streaming retrieval exposes real stage events and verified versioned evidence, without invalidating indexes for ranking changes",
  { timeout: 30000 },
  async (t) => {
    const fixture = await nativeHttpFixture({
      respond: (_request, text) => {
        const input = JSON.parse(text);
        if (input.maxQueries)
          return JSON.stringify({
            queries: ["adaptive routing architecture"],
            rationale: "双语术语召回",
          });
        if (input.claims)
          return JSON.stringify({
            checks: input.claims.map((_, index) => ({
              index,
              supported: true,
              reason: "证据直接支持",
            })),
          });
        if (input.round)
          return JSON.stringify({
            sufficient: true,
            evaluations: input.evidence.map((e) => ({
              id: e.id,
              relevant: true,
              reason: "方法原文",
            })),
            missing: [],
            followupQueries: [],
          });
        return JSON.stringify({
          claims: [
            {
              text: "路由模型使用自适应嵌入。",
              citations: [input.evidence[0].id],
            },
          ],
          gaps: [],
          comparisons: [],
        });
      },
    });
    t.after(() => fixture.dispose());
    const code = `import {putResource,saveGeneration,publish,closeCatalog} from './server/storage/catalog.js';import {getConfig} from './server/config.js';const r=putResource({id:'retrieval-http',kind:'original',sourceType:'original',title:'Adaptive routing model',metadata:{year:2024},versionId:'v1',indexEnabled:true});const g={id:'retrieval-http-g',resourceId:r.id,versionId:'v1',config:getConfig().rag,coverage:{partial:false}};saveGeneration(g,[{id:'retrieval-http-c',resourceId:r.id,kind:'chunk',text:'The routing model uses adaptive embeddings. [[table:retrieval-http-table]]',pages:[2],sectionPath:['Method'],elementIds:['retrieval-http-table']},{id:'retrieval-http-table',resourceId:r.id,kind:'table',label:'1',quality:'ready',page:2,html:'<table><tr><td>Adaptive embeddings</td></tr></table>',shortDescription:'Table 1 routing model',sectionPath:['Method']}]);publish(g.id,r.revision);closeCatalog();`;
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PIPAPER_DATA_DIR: fixture.data,
        PIPAPER_LIBRARY_DIR: path.join(fixture.directory, "library"),
      },
      stdio: "pipe",
    });
    const updated = await fetch(fixture.url + "/api/rag/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        retrieval: { model: { provider: "mock", id: "native-test" } },
        rerank: { enabled: false },
      }),
    });
    assert.equal(updated.status, 200);
    const status = await (
      await fetch(fixture.url + "/api/storage/resources/retrieval-http")
    ).json();
    assert.equal(status.resource.indexStale, false);
    const response = await fetch(fixture.url + "/api/rag/search/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "adaptive routing model Table 1",
        resourceIds: ["retrieval-http"],
        limit: 3,
        services: { embed: "untrusted-client-value" },
      }),
    });
    const events = (await response.text()).trim().split("\n").map(JSON.parse);
    assert.ok(
      events.some((e) => e.type === "progress" && e.value.stage === "verify"),
    );
    const result = events.find((e) => e.type === "result")?.value;
    assert.ok(result);
    assert.equal(result.analysis.status, "supported");
    assert.ok(
      result.results.every((r) => r.generationId === "retrieval-http-g"),
    );
    assert.ok(
      result.results.some((r) =>
        r.evidence.some((e) => e.html?.includes("<table>")),
      ),
    );
    assert.ok(
      result.analysis.claims.every(
        (c) =>
          c.verified &&
          c.citations.every((id) => result.results.some((r) => r.id === id)),
      ),
    );
  },
);
