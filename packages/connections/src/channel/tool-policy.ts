import type { Info } from "@ericsanchezok/synergy-harness/session/types"
import type { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
export function channelToolVisibility(input: {
  toolName: string
  session?: Pick<Info, "endpoint">
}): ToolDiagnostic | undefined {
  if (input.toolName === "response_card" && input.session?.endpoint?.kind !== "channel") {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool is only available in Channel sessions.`,
      metadata: { requiredEndpoint: "channel" },
    }
  }

  if (
    input.toolName === "github_deliver_fix" &&
    (input.session?.endpoint?.kind !== "channel" || input.session?.endpoint?.channel?.type !== "github")
  ) {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool is only available in GitHub Channel sessions.`,
      metadata: { requiredEndpoint: "github" },
    }
  }
}
export function registerChannelToolPolicy() {
  SessionModePolicy.register({ id: "channel", visibility: channelToolVisibility })
}
