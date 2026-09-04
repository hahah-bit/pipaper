// Isolated production HTTP/SSE smoke test; no user credentials or online model.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(process.execPath, ["--test", "tests/native-http.test.mjs"], { cwd: root, stdio: "inherit", windowsHide: true });
child.on("exit", code => { process.exitCode = code ?? 1; });
