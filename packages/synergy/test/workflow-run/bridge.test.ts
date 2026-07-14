import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { CortexEvent } from "../../src/cortex/event"
import { CortexTypes } from "../../src/cortex/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { WorkflowBridge } from "../../src/workflow-run/bridge"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowGuards } from "../../src/workflow-run/guards"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function charter(overrides: Partial<WorkflowTypes.Charter> = {}): WorkflowTypes.Charter {
  return WorkflowTypes.Charter.parse({
    id: "cht_contractor_bridge",
    version: 1,
    name: "Contractor bridge",
    entityType: "task",
    entityInitialState: "waiting",
    states: ["waiting", "done", "failed", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done", "failed"],
    seats: [{ name: "worker", agent: "synergy", charterPrompt: "work", pool: 1, worktree: "none" }],
    transitions: [],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
    ...overrides,
  })
}

function contractorTask(input: {
  taskID: string
  sessionID: string
  parentSessionID: string
  runID: string
  entityID: string
  status: "completed" | "error" | "cancelled" | "interrupted"
  completedAt: number
  output?: CortexTypes.TaskOutput
  error?: string
}): CortexTypes.Task {
  return CortexTypes.Task.parse({
    id: input.taskID,
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    parentMessageID: "msg_contractor_bridge",
    description: "Produce a bounded result",
    prompt: "Do the work",
    agent: "synergy",
    owner: {
      kind: "workflow_run",
      runID: input.runID,
      entityID: input.entityID,
      correlationID: `contractor:${input.entityID}`,
    },
    visibility: "hidden",
    status: input.status,
    startedAt: input.completedAt - 10,
    completedAt: input.completedAt,
    output: input.output,
    error: input.error,
  })
}

async function createRunWithEntity(input: {
  charter: WorkflowTypes.Charter
  entityID: string
  stateEntered: number
}): Promise<{ run: WorkflowTypes.Run; bossSessionID: string }> {
  const scopeID = ScopeContext.current.scope.id
  await CharterStore.put(scopeID, input.charter)
  const boss = await Session.create({})
  const run = await WorkflowRunStore.create({
    scopeID,
    charterRef: { id: input.charter.id, version: input.charter.version },
    title: "Contractors",
    bossSessionID: boss.id,
    seats: [],
    maxModelCalls: 0,
  })
  await WorkflowRunStore.update(scopeID, run.id, (draft) => {
    draft.entities.push({
      id: input.entityID,
      runID: run.id,
      title: "Contractor task",
      state: "waiting",
      bindings: {},
      submissions: [],
      time: {
        created: input.stateEntered,
        updated: input.stateEntered,
        stateEntered: input.stateEntered,
      },
    })
  })
  return { run, bossSessionID: boss.id }
}

describe("WorkflowBridge contractor terminal facts", () => {
  test("records one stable deliverable submission and drives a submission-guarded transition", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const stateEntered = Date.now()
      const definition = charter({
        transitions: [
          {
            id: "contractor_completed",
            from: "waiting",
            to: "done",
            trigger: { kind: "event" },
            guards: [{ name: "submission_recorded", args: { kind: "deliverable", fresh: "true" } }],
            effects: [],
          },
        ],
      })
      const { run, bossSessionID } = await createRunWithEntity({
        charter: definition,
        entityID: "wfe_contractor_success",
        stateEntered,
      })
      WorkflowBridge.init()
      const task = contractorTask({
        taskID: "ctx_contractor_success",
        sessionID: "ses_contractor_success",
        parentSessionID: bossSessionID,
        runID: run.id,
        entityID: "wfe_contractor_success",
        status: "completed",
        completedAt: stateEntered + 1,
        output: { mode: "summary", value: "Implemented and verified the requested change." },
      })

      await Promise.all([
        Bus.publish(CortexEvent.TaskCompleted, { task }),
        Bus.publish(CortexEvent.TaskCompleted, { task }),
      ])
      await Bus.publish(CortexEvent.TaskCompleted, { task })

      const after = await WorkflowRunStore.get(scopeID, run.id)
      const entity = after.entities[0]!
      expect(entity.state).toBe("done")
      expect(entity.submissions).toEqual([
        {
          id: task.id,
          kind: "deliverable",
          seat: "contractor",
          sessionID: task.sessionID,
          summary: "Implemented and verified the requested change.",
          refs: [task.sessionID],
          time: task.completedAt!,
        },
      ])
      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.filter((event) => event.kind === "submission_recorded")).toHaveLength(1)
      expect(events.filter((event) => event.kind === "contractor_finished")).toHaveLength(1)
      expect(events.find((event) => event.kind === "contractor_finished")?.data).toMatchObject({
        taskID: task.id,
        status: "completed",
        sessionID: task.sessionID,
      })
    })
  })

  test.each(["error", "cancelled", "interrupted"] as const)(
    "records one explicit %s fact and drives event evaluation without inventing a submission",
    async (status) => {
      await withScope(async () => {
        const scopeID = ScopeContext.current.scope.id
        const stateEntered = Date.now()
        const definition = charter({
          id: `cht_contractor_${status}`,
          transitions: [
            {
              id: "contractor_terminal",
              from: "waiting",
              to: "failed",
              trigger: { kind: "event" },
              guards: [],
              effects: [],
            },
          ],
        })
        const entityID = `wfe_contractor_${status}`
        const { run, bossSessionID } = await createRunWithEntity({
          charter: definition,
          entityID,
          stateEntered,
        })
        WorkflowBridge.init()
        const task = contractorTask({
          taskID: `ctx_contractor_${status}`,
          sessionID: `ses_contractor_${status}`,
          parentSessionID: bossSessionID,
          runID: run.id,
          entityID,
          status,
          completedAt: stateEntered + 1,
          error: status === "error" ? "Contractor failed its verification" : undefined,
        })

        await Bus.publish(CortexEvent.TaskCompleted, { task })
        await Bus.publish(CortexEvent.TaskCompleted, { task })

        const after = await WorkflowRunStore.get(scopeID, run.id)
        expect(after.entities[0]?.state).toBe("failed")
        expect(after.entities[0]?.submissions).toHaveLength(0)
        const terminalFacts = (await WorkflowRunStore.listEvents(scopeID, run.id)).filter(
          (event) => event.kind === "contractor_finished",
        )
        expect(terminalFacts).toHaveLength(1)
        expect(terminalFacts[0]?.data).toMatchObject({
          taskID: task.id,
          status,
          sessionID: task.sessionID,
          ...(task.error ? { error: task.error } : {}),
        })
      })
    },
  )
})

describe("WorkflowBridge durable handoff acknowledgements", () => {
  test("a guard projects a persisted handoff message into one stable ack after the bus event was missed", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const boss = await Session.create({})
      const seat = await Session.create({ parentID: boss.id })
      const definition = charter({ id: "cht_handoff_guard_recovery" })
      await CharterStore.put(scopeID, definition)
      const entityID = "wfe_handoff_guard_recovery"
      const handoffID = "wfh_handoff_guard_recovery"
      const run = await WorkflowRunStore.create({
        scopeID,
        charterRef: { id: definition.id, version: definition.version },
        title: "Recover handoff guard",
        bossSessionID: boss.id,
        seats: [
          {
            seat: "worker",
            instance: 0,
            status: "working",
            sessionID: seat.id,
            entityID,
            lastEntityIDs: [],
          },
        ],
        maxModelCalls: 0,
      })
      const now = Date.now()
      await WorkflowRunStore.update(scopeID, run.id, (draft) => {
        draft.entities.push({
          id: entityID,
          runID: run.id,
          title: "Persisted handoff",
          state: "waiting",
          bindings: { seatSessionID: seat.id },
          submissions: [],
          assignedSeat: { seat: "worker", instance: 0 },
          pendingHandoffID: handoffID,
          time: { created: now, updated: now, stateEntered: now },
        })
      })
      const delivery = await SessionInbox.deliver({
        sessionID: seat.id,
        mode: "task",
        message: {
          role: "user",
          agent: "synergy",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "Persisted workflow handoff" }],
          metadata: { workflowRun: { runID: run.id, entityID, handoffID } },
        },
      })
      await SessionInbox.materializeItem(await SessionInbox.getStored(seat.id, delivery.itemID))
      await SessionInbox.commitReady(seat.id, [delivery.itemID])
      expect(
        (await WorkflowRunStore.listEvents(scopeID, run.id)).filter((event) => event.kind === "handoff_acked"),
      ).toHaveLength(0)

      const current = await WorkflowRunStore.get(scopeID, run.id)
      const currentEntity = current.entities[0]!
      const results = await Promise.all([
        WorkflowGuards.evaluate("handoff_acked", { scopeID, run: current, entity: currentEntity }, {}),
        WorkflowGuards.evaluate("handoff_acked", { scopeID, run: current, entity: currentEntity }, {}),
      ])

      expect(results).toEqual([{ ok: true }, { ok: true }])
      const acknowledgements = (await WorkflowRunStore.listEvents(scopeID, run.id)).filter(
        (event) => event.kind === "handoff_acked",
      )
      expect(acknowledgements).toHaveLength(1)
      expect(acknowledgements[0]?.data).toEqual({
        handoffID,
        sessionID: seat.id,
        messageID: delivery.messageID,
      })
    })
  })
})
