import { describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowBridge } from "../../src/workflow-run/bridge"
import { WorkflowHandoff } from "../../src/workflow-run/handoff"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowTypes } from "../../src/workflow-run/types"

function entity(overrides: Partial<WorkflowTypes.Entity> = {}): WorkflowTypes.Entity {
  const now = Date.now()
  return {
    id: "wfe_1",
    runID: "wfr_1",
    title: "Add max/ultra effort variants",
    description: "1. Update transform.ts\n2. Update OPENAI_EFFORTS\n3. Azure path\n4. Frontend\n5. Tests",
    state: "executing",
    bindings: {},
    submissions: [],
    time: { created: now, updated: now, stateEntered: now },
    ...overrides,
  }
}

function handoff(overrides: Partial<WorkflowHandoff.Info> = {}): WorkflowHandoff.Info {
  return {
    id: "wfh_1",
    runID: "wfr_1",
    entityID: "wfe_1",
    toSeat: { seat: "executor", instance: 0 },
    task: "Implement a fix for this issue in your worktree and commit it.",
    acceptance: ["Change is committed"],
    contextRefs: [],
    expectedSubmission: "deliverable",
    ...overrides,
  }
}

describe("WorkflowHandoff.render", () => {
  test("includes the entity description (the Boss's analysis) — not just the generic task", () => {
    const text = WorkflowHandoff.render(handoff(), entity())
    expect(text).toContain("Entity details:")
    expect(text).toContain("Update transform.ts")
    expect(text).toContain("OPENAI_EFFORTS")
    expect(text).toContain("workflow_submit")
  })

  test("omits the details section when there is no description", () => {
    const text = WorkflowHandoff.render(handoff(), entity({ description: undefined }))
    expect(text).not.toContain("Entity details:")
    expect(text).toContain("Task:")
  })
})

describe("WorkflowHandoff.deliver", () => {
  test("durably enqueues one task for a stable handoff id", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const boss = await Session.create({ scope })
        const seat = await Session.create({ scope, parentID: boss.id })
        const charter = WorkflowTypes.Charter.parse({
          id: "cht_handoff",
          version: 1,
          name: "Handoff",
          entityType: "task",
          entityInitialState: "working",
          states: ["working", "done", WorkflowTypes.BLOCKED_STATE],
          terminalStates: ["done"],
          seats: [{ name: "executor", agent: "synergy", charterPrompt: "work", pool: 1, worktree: "none" }],
          transitions: [],
          gates: [],
          budget: { maxModelCalls: 0 },
          time: { created: Date.now() },
        })
        await CharterStore.put(scope.id, charter)
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: charter.id, version: charter.version },
          title: "R",
          bossSessionID: boss.id,
          seats: [
            {
              seat: "executor",
              instance: 0,
              status: "waiting",
              sessionID: seat.id,
              entityID: "wfe_1",
              lastEntityIDs: [],
            },
          ],
          maxModelCalls: 0,
        })
        const current = entity({
          runID: run.id,
          assignedSeat: { seat: "executor", instance: 0 },
          bindings: { seatSessionID: seat.id },
        })

        SessionManager.registerRuntime(seat.id)
        const abort = SessionManager.acquire(seat.id)
        expect(abort).toBeDefined()
        try {
          const stable = handoff({ id: "wfh_stable", runID: run.id })
          const [first, second] = await Promise.all([
            WorkflowHandoff.deliver(scope.id, seat.id, stable, current),
            WorkflowHandoff.deliver(scope.id, seat.id, stable, current),
          ])

          expect(second.messageID).toBe(first.messageID)
          const items = await SessionInbox.list(seat.id)
          expect(items).toHaveLength(1)
          expect(items[0]?.mode).toBe("task")
          expect(items[0]?.message?.metadata?.workflowRun?.handoffID).toBe(stable.id)

          const queued = await SessionInbox.nextTask(seat.id)
          expect(queued).toBeDefined()
          await SessionInbox.materializeItem(queued!)
          const afterMaterialization = await WorkflowHandoff.deliver(scope.id, seat.id, stable, current)
          expect(afterMaterialization.messageID).toBe(first.messageID)
          expect(await SessionInbox.list(seat.id)).toHaveLength(0)
        } finally {
          SessionManager.signalAbort(seat.id)
          SessionManager.unregisterRuntime(seat.id)
        }
      },
    })
  })

  test("a paused seat leaves its task durable and a resume event wakes it again", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = (await Scope.fromDirectory(tmp.path)).scope

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const boss = await Session.create({ scope })
        const seat = await Session.create({ scope, parentID: boss.id })
        const charter = WorkflowTypes.Charter.parse({
          id: "cht_handoff_pause",
          version: 1,
          name: "Paused handoff",
          entityType: "task",
          entityInitialState: "working",
          states: ["working", "done", WorkflowTypes.BLOCKED_STATE],
          terminalStates: ["done"],
          seats: [{ name: "executor", agent: "synergy", charterPrompt: "work", pool: 1, worktree: "none" }],
          transitions: [],
          gates: [],
          budget: { maxModelCalls: 0 },
          time: { created: Date.now() },
        })
        await CharterStore.put(scope.id, charter)
        const run = await WorkflowRunStore.create({
          scopeID: scope.id,
          charterRef: { id: charter.id, version: charter.version },
          title: "Paused handoff",
          bossSessionID: boss.id,
          seats: [
            {
              seat: "executor",
              instance: 0,
              status: "working",
              sessionID: seat.id,
              entityID: "wfe_pause_handoff",
              lastEntityIDs: [],
            },
          ],
          maxModelCalls: 0,
        })
        await Session.update(seat.id, (draft) => {
          draft.workflowRun = { runID: run.id, role: "seat", seat: "executor", instance: 0 }
        })
        const current = entity({
          id: "wfe_pause_handoff",
          runID: run.id,
          assignedSeat: { seat: "executor", instance: 0 },
          bindings: { seatSessionID: seat.id },
        })
        await WorkflowRunStore.update(scope.id, run.id, (draft) => {
          draft.entities.push(current)
        })
        await WorkflowHandoff.deliver(
          scope.id,
          seat.id,
          handoff({ id: "wfh_pause_handoff", runID: run.id, entityID: current.id }),
          current,
          { wake: false },
        )
        await WorkflowRunStore.update(scope.id, run.id, (draft) => {
          draft.status = "paused"
        })

        expect(await SessionInbox.hasRunnableItem(seat.id)).toBe(false)
        expect(await SessionInbox.nextTask(seat.id)).toBeUndefined()
        expect(await SessionInbox.list(seat.id)).toHaveLength(1)
        expect(await Session.messages({ sessionID: seat.id })).toHaveLength(0)

        const unsubscribe = WorkflowBridge.init()
        const originalScheduleWake = SessionManager.scheduleWake
        const wake = mock((_sessionID: string, _reason: string) => undefined)
        ;(SessionManager as unknown as { scheduleWake: typeof SessionManager.scheduleWake }).scheduleWake = wake
        try {
          await WorkflowRunStore.update(scope.id, run.id, (draft) => {
            draft.status = "active"
          })
          await WorkflowRunStore.appendEvent(scope.id, run, { kind: "run_resumed" })
        } finally {
          ;(SessionManager as unknown as { scheduleWake: typeof SessionManager.scheduleWake }).scheduleWake =
            originalScheduleWake
          unsubscribe()
        }

        expect(wake).toHaveBeenCalledWith(seat.id, "workflow_resumed")
        expect(await SessionInbox.hasRunnableItem(seat.id)).toBe(true)
        const consumed = await SessionInbox.nextTask(seat.id)
        expect(consumed).toBeDefined()
        expect(await SessionInbox.list(seat.id)).toHaveLength(0)
        expect(await Session.messages({ sessionID: seat.id })).toHaveLength(1)
      },
    })
  })
})
