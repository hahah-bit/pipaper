// Persisted app resource selection; independent from Pi's cwd-based projects.
export const RESOURCE_SCHEMA = 2;
export function normalizeResources(value = {}) {
  const legacy = value.schemaVersion !== RESOURCE_SCHEMA;
  const names = Array.isArray(value.skillsEnabled) ? [...new Set(value.skillsEnabled)] : [];
  return {
    ...value, schemaVersion: RESOURCE_SCHEMA,
    revision: Number.isInteger(value.revision) ? value.revision : 0,
    skillsMode: legacy ? (names.length ? "selected" : "inherit") : (value.skillsMode === "selected" ? "selected" : "inherit"),
    skillsEnabled: names,
    legacyGated: legacy ? names.length > 0 : !!value.legacyGated,
    extensions: [...new Set(value.extensions || [])],
    packages: (value.packages || []).map(p => legacy && typeof p === "string" && /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~*-]*)?$/.test(p) ? "npm:" + p : p),
  };
}
export function selectSkills(base, gated, resources) {
  const r = normalizeResources(resources);
  const candidates = [...new Map([...base, ...gated].map(s => [s.name, s])).values()];
  return candidates.filter(s => r.skillsMode === "inherit" || r.skillsEnabled.includes(s.name) || (r.legacyGated && gated.some(g => g.name === s.name)));
}
export function resourceSource(source) { return typeof source === "string" ? source : source?.source || ""; }
