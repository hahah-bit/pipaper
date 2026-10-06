import {
  loadProfile,
  saveProfile,
  deleteProfile,
  listEvidence,
  getEvidence,
  createEvidence,
  updateEvidence,
  deleteEvidence,
  listMatrices,
  getMatrix,
  createMatrix,
  updateMatrix,
  deleteMatrix,
  listHypotheses,
  getHypothesis,
  createHypothesis,
  updateHypothesis,
  deleteHypothesis,
} from "./store.js";

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

  api.get(
    "/research/projects/:projectId/evidence",
    route((req) => ({ evidence: listEvidence(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/evidence",
    route((req) => ({ evidence: createEvidence(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/evidence/:evidenceId",
    route((req) => ({ evidence: getEvidence(req.params.projectId, req.params.evidenceId) })),
  );

  api.put(
    "/research/projects/:projectId/evidence/:evidenceId",
    route((req) => ({ evidence: updateEvidence(req.params.projectId, req.params.evidenceId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/evidence/:evidenceId",
    route((req) => deleteEvidence(req.params.projectId, req.params.evidenceId)),
  );

  api.get(
    "/research/projects/:projectId/matrices",
    route((req) => ({ matrices: listMatrices(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/matrices",
    route((req) => ({ matrix: createMatrix(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/matrices/:matrixId",
    route((req) => ({ matrix: getMatrix(req.params.projectId, req.params.matrixId) })),
  );

  api.put(
    "/research/projects/:projectId/matrices/:matrixId",
    route((req) => ({ matrix: updateMatrix(req.params.projectId, req.params.matrixId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/matrices/:matrixId",
    route((req) => deleteMatrix(req.params.projectId, req.params.matrixId)),
  );

  api.get(
    "/research/projects/:projectId/hypotheses",
    route((req) => ({ hypotheses: listHypotheses(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/hypotheses",
    route((req) => ({ hypothesis: createHypothesis(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/hypotheses/:hypothesisId",
    route((req) => ({ hypothesis: getHypothesis(req.params.projectId, req.params.hypothesisId) })),
  );

  api.put(
    "/research/projects/:projectId/hypotheses/:hypothesisId",
    route((req) => ({ hypothesis: updateHypothesis(req.params.projectId, req.params.hypothesisId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/hypotheses/:hypothesisId",
    route((req) => deleteHypothesis(req.params.projectId, req.params.hypothesisId)),
  );
}
