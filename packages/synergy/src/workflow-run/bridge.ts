import { Bus } from "../bus"
import { LoopEvent } from "../blueprint/event"
import { CortexEvent } from "../cortex/event"
import { MessageV2 } from "../session/message-v2"
import { ScopedState } from "../scope/scoped-state"
import { Log } from "../util/log"
import { WorkflowMachine } from "./machine"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * WorkflowBridge translates platform facts into entity state transitions:
 *  - a lattice-independent BlueprintLoop (source "workflow") reaching a terminal
 *    state re-evaluates the entity whose `loopID` binding matches;
 *  - a handoff user message materialising in a seat session is a deterministic
 *    acknowledgement (`handoff_acked`) — the ack a guard can depend on;
 *  - a hidden contractor Cortex task completing records a submission and
 *    re-evaluates the entity.
 *
 * Like LatticeBridge, it only acts on active runs; a paused/terminal run is
 * inert.
 */
export namespace WorkflowBridge {
  const log = Log.create({ service: "workflow.bridge" })

  const subscription = ScopedState.create(
    () => {
      const unsubLoop = Bus.subscribe(LoopEvent.Updated, (event) =>
        handleLoop(event.properties.loop).catch((error) =>
          log.error("workflow bridge loop handler failed", { loopID: event.properties.loop.id, error }),
        ),
      )
      const unsubMessage = Bus.subscribe(MessageV2.Event.Updated, (event) =>
        handleMessage(event.properties.info).catch((error) =>
          log.error("workflow bridge message handler failed", { error }),
        ),
      )
      const unsubCortex = Bus.subscribe(CortexEvent.TaskCompleted, (event) =>
        handleContractor(event.properties.task).catch((error) =>
          log.error("workflow bridge contractor handler failed", { error }),
        ),
      )
      return { unsubscribe: () => [unsubLoop, unsubMessage, unsubCortex].forEach((u) => u()) }
    },
    async (state) => state.unsubscribe(),
  )

  export function init(): () => void {
    return subscription().unsubscribe
  }

  async function findRunByEntityBinding(
    scopeID: string,
    predicate: (entity: WorkflowTypes.Entity) => boolean,
  ): Promise<{ run: WorkflowTypes.Run; entity: WorkflowTypes.Entity } | undefined> {
    const runs = await WorkflowRunStore.list(scopeID)
    for (const run of runs) {
      if (run.status !== "active") continue
      const entity = run.entities.find(predicate)
      if (entity) return { run, entity }
    }
    return undefined
  }

  async function handleLoop(loop: {
    id: string
    scopeID: string
    status: string
    source: "user" | "lattice" | "workflow"
  }): Promise<void> {
    if (loop.source !== "workflow") return
    if (loop.status !== "completed" && loop.status !== "failed" && loop.status !== "cancelled") return
    const match = await findRunByEntityBinding(loop.scopeID, (e) => e.bindings.loopID === loop.id)
    if (!match) return
    await WorkflowMachine.evaluateEventTransitions(loop.scopeID, match.run.id, match.entity.id)
  }

  async function handleMessage(info: MessageV2.Info): Promise<void> {
    if (info.role !== "user") return
    const workflow = (info.metadata as Record<string, any> | undefined)?.workflowRun as
      | { runID?: string; entityID?: string; handoffID?: string }
      | undefined
    const handoffID = workflow?.handoffID
    const runID = workflow?.runID
    if (!handoffID || !runID) return

    const scopeID = await scopeForSession(info.sessionID)
    if (!scopeID) return
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run || run.status !== "active") return

    const events = await WorkflowRunStore.listEvents(scopeID, runID)
    if (events.some((e) => e.kind === "handoff_acked" && e.data?.handoffID === handoffID)) return

    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: runID },
      {
        kind: "handoff_acked",
        entityID: workflow?.entityID,
        data: { handoffID, sessionID: info.sessionID },
      },
    )
    if (workflow?.entityID) {
      await WorkflowMachine.evaluateEventTransitions(scopeID, runID, workflow.entityID)
    }
  }

  async function handleContractor(task: {
    id: string
    parentSessionID?: string
    sessionID?: string
    status: string
    visibility?: string
    owner?: {
      kind?: string
      runID?: string
      entityID?: string
      correlationID?: string
    }
    output?: { mode?: string; value?: unknown }
  }): Promise<void> {
    if (task.owner?.kind !== "workflow_run" || !task.owner.runID) return
    if (!task.parentSessionID) return
    const scopeID = await scopeForSession(task.parentSessionID)
    if (!scopeID) return
    const run = await WorkflowRunStore.getOrUndefined(scopeID, task.owner.runID)
    if (!run || run.status !== "active") return
    const entityID = task.owner.entityID
    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: run.id },
      {
        kind: "contractor_finished",
        entityID,
        data: {
          taskID: task.id,
          status: task.status,
          correlationID: task.owner.correlationID,
          outputMode: task.output?.mode,
        },
      },
    )
    if (entityID) await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entityID)
  }

  async function scopeForSession(sessionID: string): Promise<string | undefined> {
    const { SessionManager } = await import("../session/manager")
    const session = await SessionManager.getSession(sessionID).catch(() => undefined)
    if (!session) return undefined
    return (session.scope as { id: string }).id
  }
}
