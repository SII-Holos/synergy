import type { PluginSurfaceContext, PluginToolMessageSurfaceContext } from "@ericsanchezok/synergy-plugin"
import type { ToolProps } from "@ericsanchezok/synergy-ui/message-part"

export function createPluginToolMessageContext(
  context: PluginSurfaceContext,
  props: ToolProps,
): PluginToolMessageSurfaceContext {
  return {
    ...context,
    message: {
      get id() {
        return props.messageId ?? ""
      },
      role: "assistant",
    },
    tool: {
      get name() {
        return props.tool
      },
      get input() {
        return props.input
      },
      get metadata() {
        return props.metadata
      },
      get title() {
        return props.title
      },
      get output() {
        return props.output
      },
      get status() {
        return props.status
      },
    },
  }
}
