import { loadProfile, saveProfile, deleteProfile } from "./store.js";

// 研究模块路由（加法开发）：入口挂在 /api/research 下，不影响既有路由。
const route = (handler) => async (req, res) => {
  try {
    const value = await handler(req, res);
    if (!res.headersSent) res.json(value);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  }
};

export function registerResearchRoutes(api) {
  api.get(
    "/research/projects/:projectId/profile",
    route((req) => ({ profile: loadProfile(req.params.projectId) })),
  );

  api.put(
    "/research/projects/:projectId/profile",
    route((req) => ({ profile: saveProfile(req.params.projectId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/profile",
    route((req) => deleteProfile(req.params.projectId)),
  );
}
