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
  listComparisons,
  getComparison,
  createComparison,
  updateComparison,
  deleteComparison,
  listConclusions,
  getConclusion,
  createConclusion,
  updateConclusion,
  deleteConclusion,
  listManuscripts,
  getManuscript,
  createManuscript,
  updateManuscript,
  addManuscriptCitation,
  removeManuscriptCitation,
  toggleManuscriptConclusion,
  manuscriptBib,
  snapshotManuscript,
  checkManuscript,
  deleteManuscript,
  exportProjectBundle,
  listReselections,
  getReselection,
  createReselection,
  updateReselection,
  draftFromCandidate,
  deleteReselection,
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
    "/research/projects/:projectId/reselections",
    route((req) => ({ reselections: listReselections(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/reselections",
    route((req) => ({ reselection: createReselection(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/reselections/:reselectionId",
    route((req) => ({ reselection: getReselection(req.params.projectId, req.params.reselectionId) })),
  );

  api.put(
    "/research/projects/:projectId/reselections/:reselectionId",
    route((req) => ({ reselection: updateReselection(req.params.projectId, req.params.reselectionId, req.body || {}) })),
  );

  api.post(
    "/research/projects/:projectId/reselections/:reselectionId/draft",
    route((req) => draftFromCandidate(req.params.projectId, req.params.reselectionId, req.body || {})),
  );

  api.delete(
    "/research/projects/:projectId/reselections/:reselectionId",
    route((req) => deleteReselection(req.params.projectId, req.params.reselectionId)),
  );

  api.get(
    "/research/projects/:projectId/export",
    route((req) => ({ export: req.query.scope === "project" ? exportProjectBundle(req.params.projectId) : exportBundle(req.params.projectId) })),
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

  api.get(
    "/research/projects/:projectId/comparisons",
    route((req) => ({ comparisons: listComparisons(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/comparisons",
    route((req) => ({ comparison: createComparison(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/comparisons/:comparisonId",
    route((req) => ({ comparison: getComparison(req.params.projectId, req.params.comparisonId) })),
  );

  api.put(
    "/research/projects/:projectId/comparisons/:comparisonId",
    route((req) => ({ comparison: updateComparison(req.params.projectId, req.params.comparisonId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/comparisons/:comparisonId",
    route((req) => deleteComparison(req.params.projectId, req.params.comparisonId)),
  );

  api.get(
    "/research/projects/:projectId/conclusions",
    route((req) => ({ conclusions: listConclusions(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/conclusions",
    route((req) => ({ conclusion: createConclusion(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/conclusions/:conclusionId",
    route((req) => ({ conclusion: getConclusion(req.params.projectId, req.params.conclusionId) })),
  );

  api.put(
    "/research/projects/:projectId/conclusions/:conclusionId",
    route((req) => ({ conclusion: updateConclusion(req.params.projectId, req.params.conclusionId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/conclusions/:conclusionId",
    route((req) => deleteConclusion(req.params.projectId, req.params.conclusionId)),
  );

  api.get(
    "/research/projects/:projectId/manuscripts",
    route((req) => ({ manuscripts: listManuscripts(req.params.projectId) })),
  );

  api.post(
    "/research/projects/:projectId/manuscripts",
    route((req) => ({ manuscript: createManuscript(req.params.projectId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/manuscripts/:manuscriptId",
    route((req) => ({ manuscript: getManuscript(req.params.projectId, req.params.manuscriptId) })),
  );

  api.put(
    "/research/projects/:projectId/manuscripts/:manuscriptId",
    route((req) => ({ manuscript: updateManuscript(req.params.projectId, req.params.manuscriptId, req.body || {}) })),
  );

  api.post(
    "/research/projects/:projectId/manuscripts/:manuscriptId/citations",
    route((req) => ({ manuscript: addManuscriptCitation(req.params.projectId, req.params.manuscriptId, req.body || {}) })),
  );

  api.delete(
    "/research/projects/:projectId/manuscripts/:manuscriptId/citations/:key",
    route((req) => ({ manuscript: removeManuscriptCitation(req.params.projectId, req.params.manuscriptId, req.params.key) })),
  );

  api.post(
    "/research/projects/:projectId/manuscripts/:manuscriptId/conclusion-links",
    route((req) => ({ manuscript: toggleManuscriptConclusion(req.params.projectId, req.params.manuscriptId, req.body || {}) })),
  );

  api.get(
    "/research/projects/:projectId/manuscripts/:manuscriptId/bib",
    route((req) => manuscriptBib(req.params.projectId, req.params.manuscriptId)),
  );

  api.post(
    "/research/projects/:projectId/manuscripts/:manuscriptId/snapshot",
    route((req) => ({ manuscript: snapshotManuscript(req.params.projectId, req.params.manuscriptId) })),
  );

  api.get(
    "/research/projects/:projectId/manuscripts/:manuscriptId/checks",
    route((req) => checkManuscript(req.params.projectId, req.params.manuscriptId)),
  );

  api.delete(
    "/research/projects/:projectId/manuscripts/:manuscriptId",
    route((req) => deleteManuscript(req.params.projectId, req.params.manuscriptId)),
  );
}
