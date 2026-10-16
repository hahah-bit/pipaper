import { setTimeout as delay } from "node:timers/promises";

let queue = Promise.resolve(), nextRequest = 0;
export function scheduleArxiv(work, signal) {
  const job = queue.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    await delay(Math.max(0, nextRequest - Date.now()), null, { signal });
    nextRequest = Date.now() + 3100;
    return work();
  });
  queue = job;
  return job;
}
