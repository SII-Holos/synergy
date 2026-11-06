import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ChannelReactionOnlyTool } from "./channel/tools/channel-reaction-only"
import { registerReactionOnlyToolPolicy } from "./tool-policy"
import { registerReactionOnlyJobs } from "./channel/loop-jobs"

export function registerFeishuTools() {
  registerReactionOnlyToolPolicy()
  registerReactionOnlyJobs()
  ToolRegistry.registerToolProvider("channel-feishu", () => [ChannelReactionOnlyTool])
}
