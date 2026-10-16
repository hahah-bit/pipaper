// One namespaced service for preferences, drafts and layouts. Browser mirrors survive offline edits.
const volatile = new Map();
let native;
try {
  native = window.localStorage;
  const probe = "pipaper.persistence.probe";
  native.setItem(probe, "1");
  native.removeItem(probe);
} catch {
  native = {
    getItem: (k) => volatile.get(k) ?? null,
    setItem: (k, v) => volatile.set(k, String(v)),
    removeItem: (k) => volatile.delete(k),
    key: (i) => [...volatile.keys()][i],
    get length() {
      return volatile.size;
    },
  };
}
const namespaces = ["preferences", "drafts", "layouts"];
const namespace = (key) =>
  /draft|notes-editor/i.test(key)
    ? "drafts"
    : /workspace|pane|float|\.pos|\.size|collapse/i.test(key)
      ? "layouts"
      : "preferences";
const revisions = new Map(),
  serverValues = new Map();
let timer,
  initialized = false;
let pending;
try {
  pending = JSON.parse(native.getItem("pipaper.persistence.pending") || "{}");
} catch {
  pending = {};
}
const remember = () =>
  native.setItem("pipaper.persistence.pending", JSON.stringify(pending));
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), 350);
}
export const persistence = {
  getItem: (key) => native.getItem(key),
  setItem(key, value) {
    native.setItem(key, String(value));
    (pending[namespace(key)] ||= {})[key] = String(value);
    remember();
    schedule();
  },
  removeItem(key) {
    native.removeItem(key);
    (pending[namespace(key)] ||= {})[key] = null;
    remember();
    schedule();
  },
};
async function request(ns, options) {
  const res = await fetch("/api/storage/state/" + ns, {
    ...options,
    signal: AbortSignal.timeout(7000),
  });
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}
export async function initPersistence() {
  try {
    for (const ns of namespaces) {
      const remote = await request(ns);
      revisions.set(ns, remote.revision);
      serverValues.set(ns, remote.value || {});
      if (!remote.revision) {
        for (let i = 0; i < native.length; i++) {
          const key = native.key(i);
          if (
            key.startsWith("pipaper.") &&
            key !== "pipaper.persistence.pending" &&
            namespace(key) === ns
          )
            (pending[ns] ||= {})[key] = native.getItem(key);
        }
      } else
        for (const [key, value] of Object.entries(remote.value || {}))
          if (!(key in (pending[ns] || {}))) {
            if (value == null) native.removeItem(key);
            else native.setItem(key, value);
          }
    }
    initialized = true;
    remember();
    await flush();
  } catch {
    initialized = false;
  }
}
async function flush() {
  if (!initialized) return;
  for (const ns of namespaces) {
    const edits = { ...pending[ns] };
    if (!Object.keys(edits).length) continue;
    try {
      const response = await request(ns, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: revisions.get(ns) || 0,
          value: { ...serverValues.get(ns), ...edits },
        }),
      });
      revisions.set(ns, response.revision);
      serverValues.set(ns, response.value);
      for (const [key, value] of Object.entries(edits))
        if (pending[ns]?.[key] === value) delete pending[ns][key];
      remember();
    } catch (e) {
      if (e.status === 409) {
        try {
          const remote = await request(ns);
          revisions.set(ns, remote.revision);
          serverValues.set(ns, remote.value);
          schedule();
        } catch {}
      }
    }
  }
}
window.addEventListener("online", () => void initPersistence());
