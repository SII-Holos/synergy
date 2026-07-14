import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { CharterStore } from "../../src/workflow-run/charter-store"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { WorkflowRunService } from "../../src/workflow-run/service"
import { WorkflowMachine } from "../../src/workflow-run/machine"
import { WorkflowContinuationPolicy } from "../../src/workflow-run/policy"
import { WorkflowSeats } from "../../src/workflow-run/seats"
import { WorkflowTypes } from "../../src/workflow-run/types"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

/**
 * A pooled charter whose assignment uses only session-creating effects (no
 * worktree, no blueprint loop), so the queue / release / redrive logic can be
 * exercised end-to-end with real seat sessions.
 */
function pooledCharter(pool: number): WorkflowTypes.Charter {
  return WorkflowTypes.Charter.parse({
    id: "cht_pool",
    version: 1,
    name: "Pool",
    entityType: "task",
    entityInitialState: "queued",
    states: ["queued", "working", "done", WorkflowTypes.BLOCKED_STATE],
    terminalStates: ["done"],
    seats: [{ name: "worker", agent: "synergy", charterPrompt: "work", pool, worktree: "none" }],
    transitions: [
      {
        id: "assign",
        from: "queued",
        to: "working",
        trigger: { kind: "event" },
        guards: [{ name: "seat_available", args: { seat: "worker" } }],
        effects: [{ name: "assign_entity", args: { seat: "worker" } }],
      },
      {
        id: "finish",
        from: "working",
        to: "done",
        trigger: { kind: "intent", allowedSeats: ["worker"] },
        guards: [],
        effects: [{ name: "release_seat", args: {} }],
      },
    ],
    gates: [],
    budget: { maxModelCalls: 0 },
    time: { created: Date.now() },
  })
}

async function seed(pool: number) {
  const scopeID = ScopeContext.current.scope.id
  await CharterStore.put(scopeID, pooledCharter(pool))
  const boss = await Session.create({})
  const run = await WorkflowRunStore.create({
    scopeID,
    charterRef: { id: "cht_pool", version: 1 },
    title: "Pool",
    bossSessionID: boss.id,
    seats: WorkflowSeats.initialBindings(pooledCharter(pool)),
    maxModelCalls: 0,
  })
  await Session.update(boss.id, (draft) => {
    draft.workflowRun = { runID: run.id, role: "boss" }
  })
  return { scopeID, run }
}

describe("seat pool queueing", () => {
  test("a pool of one atomically admits only one concurrent entity", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seed(1)

      await Promise.all([
        WorkflowRunService.addEntity({ runID: run.id, title: "first" }),
        WorkflowRunService.addEntity({ runID: run.id, title: "second" }),
      ])

      const after = await WorkflowRunStore.get(scopeID, run.id)
      expect(after.entities.map((entity) => entity.state).sort()).toEqual(["queued", "working"])
      expect(after.entities.every((entity) => entity.blockedReason === undefined)).toBe(true)
      expect(after.entities.filter((entity) => entity.state === WorkflowTypes.BLOCKED_STATE)).toHaveLength(0)
      expect(after.seats.filter((seat) => seat.entityID)).toHaveLength(1)
    })
  })

  test("entities beyond the pool wait in the initial state instead of blocking", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seed(2)
      for (let i = 0; i < 3; i++) await WorkflowRunService.addEntity({ runID: run.id, title: `t${i}` })

      const after = await WorkflowRunStore.get(scopeID, run.id)
      const working = after.entities.filter((e) => e.state === "working")
      const queued = after.entities.filter((e) => e.state === "queued")
      const blocked = after.entities.filter((e) => e.state === WorkflowTypes.BLOCKED_STATE)
      expect(working).toHaveLength(2)
      expect(queued).toHaveLength(1)
      expect(blocked).toHaveLength(0) // the overflow entity is NOT blocked
    })
  })

  test("releasing a seat lets a queued entity advance", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seed(2)
      for (let i = 0; i < 3; i++) await WorkflowRunService.addEntity({ runID: run.id, title: `t${i}` })

      let after = await WorkflowRunStore.get(scopeID, run.id)
      const workingEntity = after.entities.find((e) => e.state === "working")!
      const seatSessionID = workingEntity.bindings.seatSessionID!

      // The worker finishes → release_seat frees the slot → redrive assigns the queued entity.
      const result = await WorkflowMachine.submitIntent({
        scopeID,
        runID: run.id,
        entityID: workingEntity.id,
        transitionID: "finish",
        actorSessionID: seatSessionID,
      })
      expect(result.ok).toBe(true)

      after = await WorkflowRunStore.get(scopeID, run.id)
      expect(after.entities.filter((e) => e.state === "done")).toHaveLength(1)
      expect(after.entities.filter((e) => e.state === "working")).toHaveLength(2) // still 2 busy
      expect(after.entities.filter((e) => e.state === "queued")).toHaveLength(0) // queue drained
    })
  })

  test("does not reuse a released seat until its running session reaches idle", async () => {
    await withScope(async () => {
      const { scopeID, run } = await seed(1)
      await WorkflowRunService.addEntity({ runID: run.id, title: "first" })
      await WorkflowRunService.addEntity({ runID: run.id, title: "second" })

      let after = await WorkflowRunStore.get(scopeID, run.id)
      const first = after.entities.find((entity) => entity.state === "working")!
      const seatSessionID = first.bindings.seatSessionID!
      const lease = SessionManager.acquire(seatSessionID)
      expect(lease).toBeDefined()
      try {
        const result = await WorkflowMachine.submitIntent({
          scopeID,
          runID: run.id,
          entityID: first.id,
          transitionID: "finish",
          actorSessionID: seatSessionID,
        })
        expect(result.ok).toBe(true)

        after = await WorkflowRunStore.get(scopeID, run.id)
        expect(after.entities.filter((entity) => entity.state === "working")).toHaveLength(0)
        expect(after.entities.filter((entity) => entity.state === "queued")).toHaveLength(1)
        expect(after.seats[0]?.entityID).toBe(first.id)
        expect(after.entities.find((entity) => entity.id === first.id)?.assignedSeat).toBeUndefined()
      } finally {
        await SessionManager.release(lease!)
        SessionManager.unregisterRuntime(seatSessionID)
      }

      const seatSession = await Session.get(seatSessionID)
      const handled = await WorkflowContinuationPolicy.handle({
        scopeID,
        sessionID: seatSessionID,
        terminalMessageID: "msg_idle",
        session: seatSession,
      })
      expect(handled).toBe(true)

      after = await WorkflowRunStore.get(scopeID, run.id)
      expect(after.entities.filter((entity) => entity.state === "working")).toHaveLength(1)
      expect(after.entities.filter((entity) => entity.state === "queued")).toHaveLength(0)
      expect(after.seats[0]?.entityID).not.toBe(first.id)
    })
  })
})
