import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"
export namespace SessionModePolicy {
  const BOSS_TOOLS = new Set(["boss_spawn", "boss_assign", "boss_report", "boss_status", "boss_cancel", "boss_project"])
  const BOSS_BOSS_ONLY_TOOLS = new Set(["boss_project"])
  const BOSS_WORKER_ONLY_TOOLS = new Set(["boss_report"])
  export function isBoss(session?: Pick<SessionInfo, "workflow">) {
    return session?.workflow?.kind === "boss"
  }
  function bossVisibility(toolName: string, session?: Pick<SessionInfo, "workflow">): ToolDiagnostic | undefined {
    if (!BOSS_TOOLS.has(toolName)) return undefined
    const workflow = session?.workflow
    if (workflow?.kind !== "boss") {
      return {
        code: "tool_unavailable",
        toolName,
        message: `The "${toolName}" tool is only available while this session is in Boss Mode.`,
      }
    }
    if (BOSS_WORKER_ONLY_TOOLS.has(toolName) && workflow.role !== "worker") {
      return {
        code: "tool_unavailable",
        toolName,
        message: `The "${toolName}" tool is only available to Boss Mode workers.`,
      }
    }
    if (BOSS_BOSS_ONLY_TOOLS.has(toolName) && workflow.role !== "boss") {
      return {
        code: "tool_unavailable",
        toolName,
        message: `The "${toolName}" tool is only available to the boss (not a worker).`,
      }
    }
    return undefined
  }
  export function visibility(input: { toolName: string; session?: Pick<SessionInfo, "workflow" | "endpoint"> }) {
    return bossVisibility(input.toolName, input.session)
  }
}
