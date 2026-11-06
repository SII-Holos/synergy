import type { Info } from "@ericsanchezok/synergy-harness/session/types"
import type { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"
import { SessionModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
export function githubToolVisibility(input: {
  toolName: string
  session?: Pick<Info, "endpoint">
}): ToolDiagnostic | undefined {
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
export function registerToolPolicy() {
  SessionModePolicy.register({ id: "channel-github", visibility: githubToolVisibility })
}
