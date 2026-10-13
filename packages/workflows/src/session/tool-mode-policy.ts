import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import type { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"
import { SessionModePolicy as Boss } from "@ericsanchezok/synergy-boss/session/tool-mode-policy"
import { SessionModePolicy as Lattice } from "@ericsanchezok/synergy-lattice/session/tool-mode-policy"
export const SessionModePolicy = {
  ...Boss,
  ...Lattice,
  unavailable,
  visibility(input: Parameters<typeof Boss.visibility>[0]) {
    return Boss.visibility(input) ?? Lattice.visibility(input)
  },
}
function unavailable(input: {
  toolName: string
  reason: string
  session?: Pick<SessionInfo, "workflow" | "blueprint">
  metadata?: Record<string, unknown>
}): ToolDiagnostic | undefined {
  if (input.reason === "audit_only") {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool is only available to the active Blueprint audit session.`,
      metadata: input.metadata,
    }
  }

  if (input.reason === "blueprint_loop_required") {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool requires an active BlueprintLoop session.`,
      metadata: input.metadata,
    }
  }

  if (input.reason === "light_loop_required") {
    return {
      code: "tool_unavailable",
      toolName: input.toolName,
      message: `The "${input.toolName}" tool requires an active Light Loop session.`,
      metadata: input.metadata,
    }
  }

  return undefined
}
