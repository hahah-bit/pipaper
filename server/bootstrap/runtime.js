import { abortExecutions } from "../platform/jobs/executions.js";
import { createApplication } from "../application.js";
import { getConfig } from "../config.js";
import { listPapers, flushStore } from "../store.js";
import { closeSessions } from "../native-harness.js";
import { migrateLibrary } from "./library-migration.js";
import { migrateStorage, recoverStorage } from "../storage/migration.js";
import { auditResources } from "../storage/files.js";
import { resumeIngestion } from "../rag/ingestion.js";
import { startMaintenance } from "../storage/maintenance.js";

export async function startServer({ port = Number(process.env.PORT || getConfig().port || 4318), host = "127.0.0.1" } = {}) {
  const app = createApplication();
  migrateLibrary();
  migrateStorage(listPapers({ includeTemporary: true }));
  recoverStorage();
  auditResources();
  resumeIngestion();
  const stopMaintenance = startMaintenance();
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, host, () => resolve(listener));
      listener.once("error", reject);
    });
  } catch (error) { stopMaintenance(); throw error; }
  let closing;
  const close = () => closing ||= (async () => {
    stopMaintenance();
    abortExecutions();
    await closeSessions();
    flushStore();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  })();
  return { app, server, close };
}
