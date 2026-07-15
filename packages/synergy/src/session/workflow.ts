import { BlueprintLoopStore } from "../blueprint/loop-store"
import { ScopeContext } from "../scope/context"
import { LatticeRunService } from "../lattice/run-service"
import { Session } from "./index"
import { SessionManager } from "./manager"
import { SessionAbort } from "./abort"

type BlueprintLoopSource = "user" | "lattice" | "plugin"

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
  throw new Error(`Cannot enable ${workflowName} while a BlueprintLoop is active.`)
}

export namespace SessionWorkflowService {
  export type SetInput =
    | { kind: "none" }
    | { kind: "plan" }
    | { kind: "lightloop"; taskDescription: string }
    | {
        kind: "lattice"
        mode: "auto" | "collaborative"
        maxModelCalls?: number
        goal?: string
        action?: "continue" | "restart"
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
    if (input.kind === "lightloop") return enableLightloop(sessionID, input.taskDescription)
    return enableLattice(sessionID, input)
  }

  export async function setNone(sessionID: string, options?: { allowRunning?: boolean }): Promise<Session.Info> {
    if (!options?.allowRunning) SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow?.kind === "lattice") {
      await LatticeRunService.disable(sessionID)
    }
    return Session.update(sessionID, (draft) => {
      draft.workflow = undefined
    })
  }

  export async function clearIfLattice(sessionID: string): Promise<Session.Info> {
    const session = await Session.get(sessionID)
    if (session.workflow?.kind !== "lattice") return session
    return Session.update(sessionID, (draft) => {
      draft.workflow = undefined
    })
  }

  export async function enablePlan(sessionID: string): Promise<Session.Info> {
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow) {
      throw new Error(`Cannot enable Plan while the ${session.workflow.kind} workflow is active.`)
    }
    await assertNoActiveBlueprintLoop(session, "Plan")
    return Session.update(sessionID, (draft) => {
      draft.workflow = { kind: "plan" }
    })
  }

  export async function enableLightloop(sessionID: string, taskDescription: string): Promise<Session.Info> {
    SessionManager.assertIdle(sessionID)
    const trimmed = taskDescription.trim()
    if (!trimmed) throw new Error("taskDescription is required when enabling Light Loop.")

    const session = await Session.get(sessionID)
    if (session.workflow) {
      throw new Error(`Cannot enable Light Loop while the ${session.workflow.kind} workflow is active.`)
    }
    await assertNoActiveBlueprintLoop(session, "Light Loop")
    return Session.update(sessionID, (draft) => {
      draft.workflow = { kind: "lightloop", taskDescription: trimmed }
    })
  }

  export async function updateLightloopTaskDescription(
    sessionID: string,
    taskDescription: string,
  ): Promise<Session.Info> {
    const trimmed = taskDescription.trim()
    if (!trimmed) throw new Error("taskDescription is required when updating Light Loop.")

    return Session.update(sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop") {
        throw new Error("Session does not have an active Light Loop workflow.")
      }
      if (draft.workflow.stopRequest) {
        throw new Error("Cannot update the Light Loop task while completion review is pending.")
      }
      draft.workflow.taskDescription = trimmed
    })
  }

  export async function cancelLightloop(sessionID: string): Promise<Session.Info> {
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
    SessionManager.assertIdle(sessionID)
    const session = await Session.get(sessionID)
    if (session.workflow && session.workflow.kind !== "lattice") {
      throw new Error(`Cannot enable Lattice while the ${session.workflow.kind} workflow is active.`)
    }

    const loop = await activeBlueprintLoop(session)
    if (loop?.source === "user" || loop?.source === "plugin") {
      throw new Error(`Cannot enable Lattice while a ${loop.source} BlueprintLoop is active.`)
    }

    const run = await LatticeRunService.enable({
      sessionID,
      mode: input.mode,
      maxModelCalls: input.maxModelCalls,
      goal: input.goal,
      action: input.action,
    })
    return Session.update(sessionID, (draft) => {
      draft.workflow = {
        kind: "lattice",
        runID: run.id,
        mode: run.mode,
        firstBlueprintStarted: run.firstBlueprintStarted,
      }
    })
  }
}
