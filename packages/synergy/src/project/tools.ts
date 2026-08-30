import { ToolRegistry } from "../tool/registry"
import { SessionControlTool } from "./tools/session-control"
import { WorktreeEnterTool } from "./tools/worktree-enter"
import { WorktreeLeaveTool } from "./tools/worktree-leave"
import { WorktreeListTool } from "./tools/worktree-list"

/**
 * Project domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerProjectTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("project", () => [
    SessionControlTool,
    WorktreeEnterTool,
    WorktreeLeaveTool,
    WorktreeListTool,
  ])
}
