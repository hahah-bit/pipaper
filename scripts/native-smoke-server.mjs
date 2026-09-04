import { nativeHttpFixture } from "../tests/helpers/native-http-fixture.mjs";
const fixture = await nativeHttpFixture({ port: Number(process.env.SMOKE_PORT || 4320) });
console.log(`Native UI fixture: ${fixture.url}`);
console.log(`Isolated data: ${fixture.directory}`);
process.once("SIGINT", async () => { await fixture.dispose(); process.exit(0); });
process.once("SIGTERM", async () => { await fixture.dispose(); process.exit(0); });
