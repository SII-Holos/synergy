import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { registerChannelToolPolicy } from "./tool-policy"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ChannelPushTool } from "./tools/channel-push"
import { ResponseCardTool } from "./tools/response-card"
import { ClarusSubmitTaskResultTool } from "./tools/clarus-submit-task-result"
import { ClarusExtendTaskTool } from "./tools/clarus-extend-task"
import { GithubDeliverFixTool } from "./tools/github-deliver-fix"

/**
 * Channel domain tool registration. Loaded through src/product-registration.ts.
 */
const runtimeState = RuntimeContext.state(() => ({
  registered: false,
}))

export function registerChannelTools(): void {
  const instanceState = runtimeState()

  if (instanceState.registered) return
  instanceState.registered = true
  registerChannelToolPolicy()

  ToolRegistry.registerToolProvider("channel", () => [
    ChannelPushTool,
    ResponseCardTool,
    ClarusSubmitTaskResultTool,
    ClarusExtendTaskTool,
    GithubDeliverFixTool,
  ])
}
