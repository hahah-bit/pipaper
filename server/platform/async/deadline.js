// Race uncooperative providers as well as aborting cooperative network/model calls.
// Every persisted write must use the child signal, so late results cannot commit.
export async function withDeadline(work, { signal, ms, message = "操作超时，请重试" }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(message), { code: "ETIMEDOUT", status: 504 })), ms);
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
