import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"
export namespace SessionModePolicy {
  const LATTICE_PARENT_TOOLS = new Set(["pathway_read", "pathway_write", "lattice_submit"])
  export function isLattice(session?: Pick<SessionInfo, "workflow">) {
    return session?.workflow?.kind === "lattice"
  }
  function latticeVisibility(
    toolName: string,
    session?: Pick<SessionInfo, "workflow" | "blueprint">,
  ): ToolDiagnostic | undefined {
    if (!isLattice(session)) {
      if (LATTICE_PARENT_TOOLS.has(toolName)) {
        return {
          code: "tool_unavailable",
          toolName,
          message: `The "${toolName}" tool is only available while this session is in Lattice mode.`,
        }
      }
      return undefined
    }

    if (
      LATTICE_PARENT_TOOLS.has(toolName) &&
      session?.blueprint?.loopID &&
      session.blueprint.loopRole === "execution"
    ) {
      return {
        code: "tool_unavailable",
        toolName,
        message: [
          `The "${toolName}" call was rejected because the current Lattice Step is owned by its active BlueprintLoop.`,
          "No Lattice action was submitted, no parent workflow state changed, and this is not permission to advance by another route.",
          `Active BlueprintLoop: ${session.blueprint.loopID}.`,
          "Do not work around this boundary with file, shell, Note, delegation, or other tools. Do not create, submit, or implement a future Pathway Step.",
          "If the current Blueprint is still incomplete, continue only that Blueprint. When it is complete and verified, call blueprint_loop_stop.",
          "If blueprint_loop_stop already succeeded, its review is queued and cannot start until this turn ends: call no more tools and end this assistant turn immediately.",
          `Do not retry "${toolName}" until the host has completed the BlueprintLoop review and delivered a new parent Lattice state.`,
        ].join("\n"),
        metadata: {
          submitted: false,
          owner: "blueprint_loop",
          loopID: session.blueprint.loopID,
          retryable: false,
          requiredAgentAction: "continue_current_blueprint_or_end_turn_after_stop",
        },
      }
    }
    return undefined
  }
  export function visibility(input: {
    toolName: string
    session?: Pick<SessionInfo, "workflow" | "blueprint" | "endpoint">
  }) {
    return latticeVisibility(input.toolName, input.session)
  }
}
