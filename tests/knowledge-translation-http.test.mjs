import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { nativeHttpFixture } from "./helpers/native-http-fixture.mjs";

test("selection translation HTTP uses server model configuration and versioned context, preserving formulas and reusing cached translations", { timeout: 30000 }, async t => {
  const fixture = await nativeHttpFixture({ respond: (_request, text) => {
    const input = JSON.parse(text);
    assert.equal(input.task, "knowledge_selection_translation");
    return JSON.stringify({ translation: input.source.replace("Accuracy is", "准确率是").replace("with", "且") });
  } });
  t.after(() => fixture.dispose());
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {putResource,saveGeneration,publish,closeCatalog} from './server/storage/catalog.js';
    import {getConfig} from './server/config.js';
    const r=putResource({id:'translation-http',kind:'original',title:'Routing',versionId:'v1'});
    saveGeneration({id:'translation-http-g',resourceId:r.id,versionId:'v1',config:getConfig().rag,coverage:{partial:true}},[
      {id:'translation-http-c',kind:'chunk',resourceId:r.id,text:'Accuracy is 95% with $x_1=2$.',sectionPath:['Results'],pages:[2],elementIds:[]},
      {id:'translation-http-formula',kind:'formula',resourceId:r.id,page:2,label:'17',quality:'needs_review',issues:['math-source-conflict'],latex:'unverified'}]);
    publish('translation-http-g',r.revision);closeCatalog();
  `], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env,
    PIPAPER_DATA_DIR: fixture.data, PIPAPER_LIBRARY_DIR: path.join(fixture.directory, "library") }, stdio: "pipe" });
  const config = await fetch(fixture.url + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ translate: { model: { provider: "mock", id: "native-test" } }, rag: { rerank: { enabled: false } } }) });
  assert.equal(config.status, 200);
  const input = { resourceId: "translation-http", generationId: "translation-http-g", recordId: "translation-http-c",
    text: "Accuracy is 95% with $x_1=2$.", models: [{ provider: "untrusted", id: "wrong" }] };
  const translate = async body => {
    const response = await fetch(fixture.url + "/api/rag/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const first = await translate(input);
  assert.equal(first.status, 200);
  assert.deepEqual(first.value.model, { provider: "mock", id: "native-test" });
  assert.equal(first.value.translated, "准确率是 95% 且 $x_1=2$.");
  assert.equal(fixture.modelRequests.length, 1);
  const second = await translate(input);
  assert.equal(second.value.cached, true); assert.equal(fixture.modelRequests.length, 1);
  assert.equal((await translate({ ...input, generationId: "obsolete-generation" })).status, 409);
  assert.equal((await translate({ ...input, recordId: "unknown-record" })).status, 404);
  const search = await fetch(fixture.url + "/api/rag/search", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Accuracy 95", selfRag: false }) });
  const searchResult = await search.json();
  assert.equal(search.status, 200, JSON.stringify(searchResult));
  const result = searchResult.results.find(row => row.chunkId === input.recordId);
  assert.equal(result.coverageGaps[0].label, "17");
  assert.ok(!result.evidence.some(element => element.latex === "unverified"));
});
