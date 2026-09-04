export function composerAction(event) {
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null;
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "q") return "followUp";
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return null;
  return event.altKey ? "followUp" : "steer";
}
