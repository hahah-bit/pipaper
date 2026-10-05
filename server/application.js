import express from "express";
import path from "node:path";
import { PUBLIC_DIR } from "./config.js";
import { registerStorageRoutes } from "./storage/routes.js";
import { registerSettingsRoutes } from "./modules/settings/routes.js";
import { registerLibraryRoutes } from "./modules/library/routes.js";
import { registerSessionRoutes } from "./session-routes.js";
import { registerNoteRoutes } from "./notes.js";
import { registerLatexRoutes } from "./latex-editor.js";
import { registerWorkspaceFileRoutes } from "./modules/writing/routes.js";
import { registerTranslationRoutes } from "./translation-routes.js";
import { registerStudyRoutes } from "./studies.js";
import { registerArchifyRoutes } from "./archify.js";
import { registerTopicRoutes } from "./topics/routes.js";
import { registerMediaRoutes } from "./modules/media/routes.js";
import { registerClippingRoutes } from "./modules/clippings/routes.js";
import { registerAcademicRoutes } from "./modules/academic/routes.js";

// HTTP composition. Library/storage recovery and listen belong to bootstrap/runtime.
export function createApplication() {
  const app = express();
  app.use(express.json({ limit: "24mb" }));
  app.use((req, res, next) => {
    // raw body for uploads (PUT /api/papers/import)
    if (req.method === "PUT" && ["/api/papers/import", "/api/studies/import"].includes(req.path)) {
      const chunks = [];
      let size = 0, rejected = false;
      req.on("data", (c) => { size += c.length; if (size > 100 * 1024 * 1024) { if (!rejected) res.status(413).json({ error: "PDF 最大 100 MB" }); rejected = true; chunks.length = 0; } else if (!rejected) chunks.push(c); });
      req.on("end", () => {
        if (rejected) return;
        req.rawBody = Buffer.concat(chunks);
        next();
      });
      return;
    }
    next();
  });
  const api = express.Router();
  registerStorageRoutes(api);
  registerSettingsRoutes(api);
  registerLibraryRoutes(api);
  registerSessionRoutes(api);
  registerNoteRoutes(api);
  registerLatexRoutes(api);
  registerWorkspaceFileRoutes(api);
  registerTranslationRoutes(api);
  registerStudyRoutes(api);
  registerArchifyRoutes(api);
  registerTopicRoutes(api);
  registerMediaRoutes(api);
  registerClippingRoutes(api);
  registerAcademicRoutes(api);
  app.use("/api", api);
  app.use(express.static(PUBLIC_DIR));
  app.get("/study/:id", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "study.html")));
  app.get(["/topics", "/topics/:id"], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "topics.html")));
  app.get(["/", "/videos"], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
  return app;
}
