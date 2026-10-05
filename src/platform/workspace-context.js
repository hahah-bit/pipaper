// The page entry declares its conversation scope before controllers mount.
export const workspaceContext = { workspace: "main" };
export function configureWorkspace(workspace) {
  if (!["main", "video"].includes(workspace)) throw new Error("无效工作区");
  workspaceContext.workspace = workspace;
}
