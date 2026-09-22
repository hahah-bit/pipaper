// Isolated UI acceptance: mock only the model, use the configured upstream CLI.
import { nativeHttpFixture } from "../tests/helpers/native-http-fixture.mjs";
import { archifyModelResponse } from "../tests/helpers/archify-fixture.mjs";
const installation = process.env.PIPAPER_TEST_ARCHIFY_DIR;
if (!installation) throw new Error("请设置 PIPAPER_TEST_ARCHIFY_DIR 指向已有 Archify 安装");
const fixture = await nativeHttpFixture({ respond: archifyModelResponse, contextWindow: 64000 });
await fetch(fixture.url + "/api/archify/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: installation }) });
await fetch(fixture.url + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setup: { onboardedAt: new Date().toISOString() } }) });
console.log("Archify browser acceptance: " + fixture.url);
await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); process.stdin.once("data", resolve); });
await fixture.dispose();
