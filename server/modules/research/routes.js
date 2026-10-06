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
  exportBundle,
  importBundle,
  listProtocols,
  getProtocol,
  createProtocol,
  updateProtocol,
  freezeProtocol,
  deleteProtocol,
  listExperiments,
  getExperiment,
  createExperiment,
  updateExperiment,
  deleteExperiment,
  listRuns,
  getRun,
  createRun,
  updateRun,
  deleteRun,
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

  api.get(
    "/research/projects/:projectId/export",
    route((req) => ({ export: exportBundle(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/import",
    route((req) => importBundle(req.params.projectId, req.body?.data, { force: Boolean(req.body?.force) })),
  );

  api.get(
    "/research/projects/:projectId/protocols",
    route((req) => ({ protocols: listProtocols(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/protocols",
    route((req) => ({ protocol: createProtocol(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/protocols/:protocolId",
    route((req) => ({ protocol: getProtocol(req.params.projectId, req.params.protocolId) })),
  );

  api.put(
    "/research/projects/:projectId/protocols/:protocolId",
    route((req) => ({ protocol: updateProtocol(req.params.projectId, req.params.protocolId, req.body || {}) })),
  );

  api.post(
    "/research/projects/:projectId/protocols/:protocolId/freeze",
    route((req) => ({ protocol: freezeProtocol(req.params.projectId, req.params.protocolId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/protocols/:protocolId",
    route((req) => deleteProtocol(req.params.projectId, req.params.protocolId)),
  );

  api.get(
    "/research/projects/:projectId/experiments",
    route((req) => ({ experiments: listExperiments(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/experiments",
    route((req) => ({ experiment: createExperiment(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/experiments/:experimentId",
    route((req) => ({ experiment: getExperiment(req.params.projectId, req.params.experimentId) })),
  );

  api.put(
    "/research/projects/:projectId/experiments/:experimentId",
    route((req) => ({ experiment: updateExperiment(req.params.projectId, req.params.experimentId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/experiments/:experimentId",
    route((req) => deleteExperiment(req.params.projectId, req.params.experimentId)),
  );

  api.get(
    "/research/projects/:projectId/runs",
    route((req) => ({
      runs: listRuns(req.params.projectId, { experimentId: req.query.experimentId || undefined }),
    })),
  );

  api.get(
    "/research/projects/:projectId/runs/:runId",
    route((req) => ({ run: getRun(req.params.projectId, req.params.runId) })),
  );

  api.post(
    "/research/projects/:projectId/runs",
    route((req) => ({ run: createRun(req.params.projectId, req.body || {}) })),
  );

  api.put(
    "/research/projects/:projectId/runs/:runId",
    route((req) => ({ run: updateRun(req.params.projectId, req.params.runId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/runs/:runId",
    route((req) => deleteRun(req.params.projectId, req.params.runId)),
  );
}
