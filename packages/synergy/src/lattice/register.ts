import { BlueprintLoopStore, isActiveLoopStatus } from "../blueprint/loop-store"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import type { Info as SessionInfo } from "../session/types"
import { SessionWorkflowService } from "../session/workflow"
import { ContinuationKernel } from "../session/continuation-kernel"
import { WorkflowPromptRegistry } from "../session/workflow-prompt-registry"
import { WorkflowKindRegistry } from "../session/workflow-kind-registry"
import { ToolRegistry } from "../tool/registry"
import { LatticeContinuationPolicy } from "./policy"
import { LatticeError } from "./error"
import { LatticeRuntime } from "./runtime"
import { LatticeRunService } from "./run-service"
import { LatticeStore } from "./store"
import { LatticePrompt } from "./prompt"
import { LatticeModelCalls } from "./model-calls"
import { LatticeController } from "./controller"
import { PathwayReadTool } from "./tools/pathway-read"
import { PathwayWriteTool } from "./tools/pathway-write"
import { LatticeSubmitTool } from "./tools/lattice-submit"

/**
 * Lattice domain registration (H1 continuation provider + H2 prompt
 * contribution with the full session-loop lifecycle + domain tools). Loaded
 * through src/product-registration.ts.
 */
let registered = false

async function activeBlueprintLoop(session: SessionInfo) {
  const loopID = session.blueprint?.loopID
  if (!loopID) return undefined
  const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loopID).catch(() => undefined)
  if (!loop || !isActiveLoopStatus(loop.status)) return undefined
  return loop
}

/** Lattice enable moved from SessionWorkflowService.enableLattice; the body
 * is unchanged — same lock, conflict checks, projection rollback, and
 * post-enable direct reconciliation. */
async function enableLatticeWorkflow(
  sessionID: string,
  input: { mode: "auto" | "collaborative"; maxModelCalls?: number; goal?: string },
): Promise<SessionInfo> {
  type EnableOutcome = Awaited<ReturnType<typeof LatticeRunService.enableForProjection>>
  let run: EnableOutcome["run"]
  let projected: SessionInfo
  {
    using _ = await SessionWorkflowService.lock(sessionID)
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    const existing = session.workflow ? WorkflowKindRegistry.effectiveKind(session.workflow) : undefined
    if (existing && existing !== "lattice") {
      throw new LatticeError.StateConflict({
        state: existing,
        reason: `Cannot enable Lattice while the ${existing} workflow is active.`,
      })
    }

    const loop = await activeBlueprintLoop(session)
    if (loop?.source === "user" || loop?.source === "plugin") {
      throw new LatticeError.StateConflict({
        state: "blueprint_loop",
        reason: `Cannot enable Lattice while a ${loop.source} BlueprintLoop is active.`,
      })
    }

    const outcome = await LatticeRunService.enableForProjection({
      sessionID,
      mode: input.mode,
      maxModelCalls: input.maxModelCalls,
      goal: input.goal,
    })
    run = outcome.run
    try {
      projected = await Session.update(sessionID, (draft) => {
        if (draft.workflow && draft.workflow.kind !== "lattice") {
          throw new LatticeError.StateConflict({
            state: draft.workflow.kind,
            reason: `Cannot enable Lattice while the ${draft.workflow.kind} workflow is active.`,
          })
        }
        draft.workflow = {
          kind: "lattice",
          runID: run.id,
          mode: run.mode,
        }
      })
    } catch (error) {
      if (outcome.created) {
        await LatticeRunService.cancelUnprojected(run.id).catch(() => undefined)
        const previousRunID = session.workflow?.kind === "lattice" ? session.workflow.runID : undefined
        await Session.update(sessionID, (draft) => {
          if (
            draft.workflow?.kind === "lattice" &&
            (draft.workflow.runID === run.id || draft.workflow.runID === previousRunID)
          ) {
            draft.workflow = undefined
          }
        }).catch(() => undefined)
      }
      throw error
    }
  }
  if (run.effect?.kind === "deliver_prompt") {
    await LatticeController.reconcileDirect(ScopeContext.current.scope.id, sessionID, "enable")
  }
  return projected
}

export function registerLatticeDomain(): void {
  if (registered) return
  registered = true

  ContinuationKernel.registerProvider("lattice", () => [LatticeContinuationPolicy])

  WorkflowPromptRegistry.register({
    kind: "lattice",
    controlSources: ["lattice_continuation"],
    init() {
      LatticeRuntime.ensure()
    },
    async buildSystem(session: SessionInfo) {
      const workflow = session.workflow
      if (workflow?.kind !== "lattice") return []
      const run = await LatticeStore.getOrUndefined((session.scope as { id: string }).id, session.id).catch(
        () => undefined,
      )
      if (run && run.status === "active") return [LatticePrompt.build(session, run)]
      return []
    },
    projectUserMessage(query: string, agentName: string) {
      const header =
        agentName === "synergy"
          ? "You are synergy in the Lattice workflow."
          : agentName === "synergy-max"
            ? "You are synergy-max in the Lattice workflow."
            : "You are in the Lattice workflow."
      return [
        "<lattice-user-request>",
        header,
        "Treat this message as evidence for the current Lattice responsibility; follow the current Lattice system state instead of restarting the workflow.",
        "While clarifying, investigate and align requirements before proposing a Pathway or Blueprint.",
        "",
        "User request:",
        query,
        "</lattice-user-request>",
      ].join("\n")
    },
    async finalize(sessionID: string, scopeID: string) {
      if (LatticeModelCalls.peek(sessionID) > 0) {
        await LatticeModelCalls.flush(scopeID, sessionID).catch(() => undefined)
      }
    },
    onModelCall(sessionID: string) {
      LatticeModelCalls.record(sessionID)
    },
    async isActive(session: SessionInfo) {
      const workflow = session.workflow
      if (!workflow || workflow.kind !== "lattice") return false
      const run = await LatticeStore.getOrUndefined((session.scope as { id: string }).id, session.id).catch(
        () => undefined,
      )
      return run?.status === "active" || run?.status === "paused"
    },
    async enable(sessionID, input) {
      return enableLatticeWorkflow(sessionID, input)
    },
    async disable(sessionID) {
      await LatticeRunService.disable(sessionID)
    },
    workflowConflict(error: unknown) {
      return error instanceof LatticeError.StateConflict ? { reason: error.data.reason } : undefined
    },
  })

  ToolRegistry.registerToolProvider("lattice", () => [PathwayReadTool, PathwayWriteTool, LatticeSubmitTool])
}
