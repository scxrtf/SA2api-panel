import { resolve } from "node:path";

export const enabled = () => process.env.WB2_WORKSPACE_ENABLED === "1";
// These are runtime worktree/data paths, not assets to trace into the server bundle.
export const projectRoot = () => resolve(/* turbopackIgnore: true */ process.env.WB2_WORKSPACE_ROOT || process.cwd());
export const dataRoot = () => resolve(/* turbopackIgnore: true */ process.env.WB2_WORKSPACE_DATA_DIR || resolve(process.cwd(), ".runtime", "agent-workspace"));

export class WorkspaceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
