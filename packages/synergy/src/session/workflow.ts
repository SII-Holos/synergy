import { BlueprintLoopStore } from "../blueprint/loop-store"
import { ScopeContext } from "../scope/context"
import { LatticeError } from "../lattice/error"
import { LatticeRunService } from "../lattice/run-service"
import { Lock } from "../util/lock"
import { Session } from "./index"
import { SessionManager } from "./manager"
import { SessionAbort } from "./abort"

type BlueprintLoopSource = "user" | "lattice" | "plugin"

export class WorkflowConflictError extends Error {
  constructor(
    public readonly state: string,
    reason: string,
  ) {
    super(reason)
    this.name = "WorkflowConflictError"
  }
}

function activeLoopStatus(status: string): boolean {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

async function activeBlueprintLoop(session: Session.Info) {
  const loopID = session.blueprint?.loopID
  if (!loopID) return undefined
  const loop = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loopID).catch(() => undefined)
  if (!loop || !activeLoopStatus(loop.status)) return undefined
  return loop
}

async function assertNoActiveBlueprintLoop(session: Session.Info, workflowName: string) {
  const loop = await activeBlueprintLoop(session)
  if (!loop) return
  throw new WorkflowConflictError("blueprint_loop", `Cannot enable ${workflowName} while a BlueprintLoop is active.`)
}

function workflowLock(sessionID: string) {
  return Lock.write(`session-workflow:${ScopeContext.current.scope.id}:${sessionID}`)
}

export namespace SessionWorkflowService {
  export type SetInput =
    | { kind: "none" }
    | { kind: "plan" }
    | { kind: "lightloop"; instructions: string }
    | {
        kind: "lattice"
        mode: "auto" | "collaborative"
        maxModelCalls?: number
        goal?: string
      }

  export function current(session: Session.Info): Session.Info["workflow"] {
    return session.workflow
  }

  export async function assertBlueprintLoopAllowed(session: Session.Info, source: BlueprintLoopSource): Promise<void> {
    const workflow = session.workflow
    if (source === "user") {
      if (!workflow) return
      throw new Error(`User BlueprintLoops cannot start while the ${workflow.kind} workflow is active.`)
    }
    // Plugin-owned loops are independently gated by the blueprint.delegate capability.
    if (source === "plugin") return

    if (workflow?.kind === "lattice") return
    if (!workflow) {
      throw new Error("Lattice-owned BlueprintLoops require an active Lattice workflow.")
    }
    throw new Error(`Lattice-owned BlueprintLoops cannot start while the ${workflow.kind} workflow is active.`)
  }

  export async function prepareBlueprintLoopBinding(
    sessionID: string,
    source: BlueprintLoopSource,
  ): Promise<Session.Info> {
    const session = await Session.get(sessionID)
    const workflow = session.workflow
    // Plugin-owned loops do not replace or depend on the Session's interactive workflow.
    if (source === "plugin") return session
    if (source === "user") {
      if (!workflow) return session
      if (workflow.kind === "plan" || workflow.kind === "lightloop") {
        SessionManager.assertIdle(sessionID)
        return setNone(sessionID)
      }
      throw new Error(`User BlueprintLoops cannot start while the ${workflow.kind} workflow is active.`)
    }

    await assertBlueprintLoopAllowed(session, source)
    return session
  }

  export async function set(sessionID: string, input: SetInput): Promise<Session.Info> {
    if (input.kind === "none") return setNone(sessionID)
    if (input.kind === "plan") return enablePlan(sessionID)
    if (input.kind === "lightloop") return startLightloop(sessionID, input.instructions)
    return enableLattice(sessionID, input)
  }

  export async function setNone(sessionID: string, options?: { allowRunning?: boolean }): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    if (!options?.allowRunning) SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow?.kind === "lattice") {
      await LatticeRunService.disable(sessionID)
    }
    return Session.update(sessionID, (draft) => {
      draft.workflow = undefined
    })
  }

  export async function clearIfLattice(sessionID: string, expectedRunID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow?.kind !== "lattice" || session.workflow.runID !== expectedRunID) return session
    return clearLatticeProjectionExact(sessionID, expectedRunID)
  }

  /** @internal Caller must serialize competing workflow changes. */
  export async function clearLatticeProjectionExact(sessionID: string, expectedRunID: string): Promise<Session.Info> {
    return Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind === "lattice" && draft.workflow.runID === expectedRunID) {
        draft.workflow = undefined
      }
    })
  }

  /** Repair only the durable Lattice ownership projection after an interrupted enable. */
  export async function repairLatticeProjection(input: {
    sessionID: string
    runID: string
    mode: "auto" | "collaborative"
  }): Promise<Session.Info> {
    return Session.update(input.sessionID, (draft) => {
      const workflow = draft.workflow
      if (!workflow) {
        draft.workflow = { kind: "lattice", runID: input.runID, mode: input.mode }
        return
      }
      if (workflow.kind === "lattice" && workflow.runID === input.runID) {
        workflow.mode = input.mode
        return
      }
      throw new Error(
        `Session workflow is owned by ${workflow.kind}:${"runID" in workflow ? workflow.runID : "active"}.`,
      )
    })
  }

  export async function enablePlan(sessionID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow) {
      throw new WorkflowConflictError(
        session.workflow.kind,
        `Cannot enable Plan while the ${session.workflow.kind} workflow is active.`,
      )
    }
    await assertNoActiveBlueprintLoop(session, "Plan")
    return Session.update(sessionID, (draft) => {
      if (draft.workflow) {
        throw new WorkflowConflictError(
          draft.workflow.kind,
          `Cannot enable Plan while the ${draft.workflow.kind} workflow is active.`,
        )
      }
      draft.workflow = { kind: "plan" }
    })
  }

  export async function startLightloop(sessionID: string, instructions: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    SessionManager.assertIdle(sessionID)
    const trimmed = instructions.trim()
    if (!trimmed) throw new Error("instructions is required when starting Light Loop.")

    const session = await Session.get(sessionID)
    if (session.workflow) {
      throw new WorkflowConflictError(
        session.workflow.kind,
        `Cannot enable Light Loop while the ${session.workflow.kind} workflow is active.`,
      )
    }
    await assertNoActiveBlueprintLoop(session, "Light Loop")
    return Session.update(sessionID, (draft) => {
      if (draft.workflow) {
        throw new WorkflowConflictError(
          draft.workflow.kind,
          `Cannot enable Light Loop while the ${draft.workflow.kind} workflow is active.`,
        )
      }
      draft.workflow = { kind: "lightloop", instructions: trimmed }
    })
  }

  export async function updateLightloopInstructions(sessionID: string, instructions: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    const trimmed = instructions.trim()
    if (!trimmed) throw new Error("instructions is required when updating Light Loop.")

    return Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") {
        throw new Error("Session does not have an active Light Loop workflow.")
      }
      if (draft.workflow.stopRequest) {
        throw new Error("Cannot update the Light Loop task while completion review is pending.")
      }
      draft.workflow.instructions = trimmed
    })
  }

  export async function cancelLightloop(sessionID: string): Promise<Session.Info> {
    using _ = await workflowLock(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow?.kind !== "lightloop") return session

    await SessionAbort.abort(sessionID)
    return Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind === "lightloop") draft.workflow = undefined
    })
  }

  export async function enableLattice(
    sessionID: string,
    input: Extract<SetInput, { kind: "lattice" }>,
  ): Promise<Session.Info> {
    let run: Awaited<ReturnType<typeof LatticeRunService.enable>>
    let projected: Session.Info
    {
      using _ = await workflowLock(sessionID)
      SessionManager.assertIdle(sessionID)
      const session = await Session.get(sessionID)
      if (session.workflow && session.workflow.kind !== "lattice") {
        throw new LatticeError.StateConflict({
          state: session.workflow.kind,
          reason: `Cannot enable Lattice while the ${session.workflow.kind} workflow is active.`,
        })
      }

      const loop = await activeBlueprintLoop(session)
      if (loop?.source === "user" || loop?.source === "plugin") {
        throw new LatticeError.StateConflict({
          state: "blueprint_loop",
          reason: `Cannot enable Lattice while a ${loop.source} BlueprintLoop is active.`,
        })
      }

      run = await LatticeRunService.enable({
        sessionID,
        mode: input.mode,
        maxModelCalls: input.maxModelCalls,
        goal: input.goal,
      })
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
        await LatticeRunService.pause(run.id).catch(() => undefined)
        throw error
      }
    }
    if (run.effect?.kind === "deliver_prompt") {
      const { LatticeController } = await import("../lattice/controller")
      await LatticeController.reconcileDirect(ScopeContext.current.scope.id, sessionID, "enable")
    }
    return projected
  }
}
