import { startServer } from "./bootstrap/runtime.js";

const running = await startServer();
console.log(`\n  PiPaper 论文精读工作台  →  http://127.0.0.1:${running.server.address().port}\n`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    running.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
