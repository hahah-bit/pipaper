import { randomUUID } from "node:crypto";
import { readTask, saveTask } from "./study-store.js";

export function createStudyActivity(task, kind, controller) {
  const activity = { id: randomUUID(), checkpointId: task.checkpoints[task.cursor]?.id, versionId: task.versionId,
    kind, startedAt: new Date().toISOString(), status: "running", steps: [] };
  let timer, closed = false, lastPersist = 0;
  const flush = () => {
    clearTimeout(timer); timer = null;
    let latest; try { latest = readTask(task.id); } catch { return; }
    if (["deleting", "delete-failed"].includes(latest.status)) return;
    if (closed || Date.now() - lastPersist > 1000) {
      latest.activities = [...(latest.activities || []).filter(a => a.id !== activity.id), activity];
      saveTask(latest); lastPersist = Date.now();
    }
    controller.emit({ t: "study_activity", activity });
  };
  const report = event => {
    if (closed) return;
    let step = activity.steps.find(s => s.id === event.id);
    if (event.type === "model_start" || event.type === "tool_start") {
      step = { id: event.id, type: event.type === "model_start" ? "model" : "tool", model: event.model,
        name: event.name, args: event.args, thinking: "", status: "running", startedAt: Date.now() };
      activity.steps.push(step);
    } else if (step) {
      if (event.type === "thinking") step.thinking = (step.thinking + event.text).slice(0, 120000);
      if (event.content) step.content = event.content;
      if (event.usage) step.usage = event.usage;
      if (event.type.endsWith("_end")) { step.status = event.error ? "error" : "completed"; step.error = event.error; step.endedAt = Date.now(); }
    }
    if (!timer) timer = setTimeout(flush, 150);
  };
  flush();
  return { activity, report, finish(error, aborted) {
    closed = true; activity.status = aborted ? "cancelled" : error ? "error" : "completed";
    activity.error = error?.message; activity.endedAt = new Date().toISOString();
    for (const step of activity.steps) if (step.status === "running") step.status = aborted ? "cancelled" : "error";
    flush();
  } };
}

export async function studyTool(controller, name, args, fn, summarize = result => result) {
  const id = randomUUID(); controller.studyReport?.({ type: "tool_start", id, name, args });
  try {
    const result = await fn();
    controller.studyReport?.({ type: "tool_end", id, content: [{ type: "text", text: JSON.stringify(summarize(result), null, 2)?.slice(0, 30000) || "完成" }] });
    return result;
  } catch (error) { controller.studyReport?.({ type: "tool_end", id, error: error.message }); throw error; }
}
