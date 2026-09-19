import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import { SessionModePolicy as CoreModePolicy } from "@ericsanchezok/synergy-harness/session/tool-mode-policy"
import { ToolDiagnostic } from "@ericsanchezok/synergy-harness/tool/diagnostic"

export namespace SessionModePolicy {
  const LATTICE_PARENT_TOOLS = new Set(["pathway_read", "pathway_write", "lattice_submit"])
  const BOSS_TOOLS = new Set(["boss_spawn", "boss_assign", "boss_report", "boss_status", "boss_cancel", "boss_project"])
  const BOSS_BOSS_ONLY_TOOLS = new Set(["boss_project"])
  const BOSS_WORKER_ONLY_TOOLS = new Set(["boss_report"])

  export function isLattice(session?: Pick<SessionInfo, "workflow">) {
    return session?.workflow?.kind === "lattice"
  }

  export function isBoss(session?: Pick<SessionInfo, "workflow">) {
    return session?.workflow?.kind === "boss"
  }

  function bossVisibility(
    toolName: string,
    session?: Pick<SessionInfo, "workflow" | "blueprint">,
  ): ToolDiagnostic | undefined {
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

  export function visibility(input: {
    toolName: string
    session?: Pick<SessionInfo, "workflow" | "blueprint" | "endpoint">
  }): ToolDiagnostic | undefined {
    const latticeDiagnostic = latticeVisibility(input.toolName, input.session)
    if (latticeDiagnostic) return latticeDiagnostic
    const bossDiagnostic = bossVisibility(input.toolName, input.session)
    if (bossDiagnostic) return bossDiagnostic
    return undefined
  }

  export function unavailable(input: {
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
}

export async function workflowToolAvailability(input: { session?: SessionInfo; agent: string }) {
  const result = new Map<string, ToolDiagnostic>()
  const session = input.session
  const stop = session?.id ? await BlueprintToolAccess.canStopLoop(session) : false
  const blueprintReview = session?.id
    ? await BlueprintToolAccess.canUseReviewTools(input.agent, session.id, session)
    : false
  const lightReview = session?.id
    ? await LightLoopReviewAccess.resolve({ agent: input.agent, reviewSessionID: session.id, reviewSession: session })
    : undefined
  const reject = (ids: string[], reason: string) =>
    ids.forEach((toolName) => result.set(toolName, CoreModePolicy.unavailable({ toolName, reason, session })))
  if (!stop) reject(["blueprint_loop_stop"], "blueprint_loop_required")
  if (!blueprintReview) reject(["blueprint_loop_approve", "blueprint_loop_reject"], "permission")
  if (!isActiveLightLoopWorkflow(session?.workflow)) reject(["loop_stop"], "light_loop_required")
  if (!lightReview) reject(["light_loop_approve", "light_loop_reject"], "permission")
  return result
}
import { BlueprintToolAccess } from "../blueprint/tool-access"
import { LightLoopReviewAccess } from "./light-loop-review-access"
import { isActiveLightLoopWorkflow } from "./light-loop-state"
