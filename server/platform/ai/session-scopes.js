const scopes = new Map();

export function registerSessionScope(name, adapter) {
  scopes.set(name, adapter);
  return () => { if (scopes.get(name) === adapter) scopes.delete(name); };
}
export async function beforeSessionPrompt(controller, body) {
  for (const adapter of scopes.values()) if (adapter.matches(controller.meta))
    await adapter.beforePrompt?.(controller, body);
}
export async function sessionReplaced(controller, oldId, newId) {
  for (const adapter of scopes.values()) if (adapter.matches(controller.meta))
    await adapter.onReplace?.(controller, oldId, newId);
}
