import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SessionControlTool } from "./tools/session-control"
import { WorktreeEnterTool } from "./tools/worktree-enter"
import { WorktreeLeaveTool } from "./tools/worktree-leave"
import { WorktreeListTool } from "./tools/worktree-list"

/**
 * Project domain tool registration. Loaded through src/registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerProjectTools(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true

  ToolRegistry.registerToolProvider("project", () => [
    SessionControlTool,
    WorktreeEnterTool,
    WorktreeLeaveTool,
    WorktreeListTool,
  ])
}
