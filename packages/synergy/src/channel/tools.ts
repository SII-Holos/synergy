import { ToolRegistry } from "../tool/registry"
import { ChannelPushTool } from "./tools/channel-push"
import { ResponseCardTool } from "./tools/response-card"
import { ClarusSubmitTaskResultTool } from "./tools/clarus-submit-task-result"
import { ClarusExtendTaskTool } from "./tools/clarus-extend-task"
import { GithubDeliverFixTool } from "./tools/github-deliver-fix"

/**
 * Channel domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerChannelTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("channel", () => [
    ChannelPushTool,
    ResponseCardTool,
    ClarusSubmitTaskResultTool,
    ClarusExtendTaskTool,
    GithubDeliverFixTool,
  ])
}
