// One event stream for the navigation indicator and any open resource workspace.
const listeners = new Set();
let source, timer;
export function subscribeStorageEvents(callback) {
  listeners.add(callback);
  if (!source) {
    source = new EventSource("/api/storage/events");
    source.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const listener of listeners) listener();
      }, 500);
    };
  }
  return () => {
    listeners.delete(callback);
    if (!listeners.size) {
      source.close();
      source = null;
      clearTimeout(timer);
    }
  };
}
export function storageSummary(jobs, reviews) {
  const latest = latestStorageJobs(jobs);
  return {
    running: latest.filter((job) => ["queued", "running"].includes(job.status))
      .length,
    failed: latest.filter((job) =>
      ["failed", "blocked", "interrupted"].includes(job.status),
    ).length,
    reviews: reviews.length,
  };
}
export function latestStorageJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    if (seen.has(job.resourceId)) return false;
    seen.add(job.resourceId);
    return true;
  });
}
