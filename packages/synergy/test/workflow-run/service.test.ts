import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { WorkflowRunService } from "../../src/workflow-run/service"
import { WorkflowRunStore } from "../../src/workflow-run/store"
import { IssueToPrCharter } from "../../src/workflow-run/builtin/issue-to-pr"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("WorkflowRunService", () => {
  test("create instantiates the built-in charter and binds the boss session", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      expect(run.status).toBe("active")
      // 3 executor + 1 reviewer + 1 tester = 5 seat instances.
      expect(run.seats).toHaveLength(5)
      const after = await Session.get(boss.id)
      expect(after.workflowRun).toEqual({ runID: run.id, role: "boss" })
    })
  })

  test("a boss session cannot own two runs", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      await WorkflowRunService.create({ charterID: IssueToPrCharter.CHARTER_ID, title: "A", bossSessionID: boss.id })
      await expect(
        WorkflowRunService.create({ charterID: IssueToPrCharter.CHARTER_ID, title: "B", bossSessionID: boss.id }),
      ).rejects.toThrow(/already bound/)
    })
  })

  test("adding an entity assigns an executor seat and delivers a handoff", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })

      await WorkflowRunService.addEntity({ runID: run.id, title: "Fix bug", description: "A bug" })

      const after = await WorkflowRunStore.get(scopeID, run.id)
      const entity = after.entities[0]
      expect(entity.state).toBe("executing")
      expect(entity.assignedSeat?.seat).toBe("executor")
      expect(entity.bindings.seatSessionID).toBeDefined()

      const seat = after.seats.find(
        (item) => item.seat === entity.assignedSeat?.seat && item.instance === entity.assignedSeat?.instance,
      )
      expect(seat?.entityID).toBe(entity.id)
      expect(seat?.activeTaskID).toBeDefined()

      const events = await WorkflowRunStore.listEvents(scopeID, run.id)
      expect(events.some((e) => e.kind === "seat_session_created")).toBe(true)
      expect(events.some((e) => e.kind === "seat_assigned")).toBe(true)
      const handoff = events.find((e) => e.kind === "handoff_sent")
      expect(handoff).toBeDefined()
      expect(typeof handoff?.data?.taskID).toBe("string")
    })
  })

  test("cancel clears active seat tasks and marks the run cancelled", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      await WorkflowRunService.addEntity({ runID: run.id, title: "Fix bug", description: "A bug" })
      const before = await WorkflowRunStore.get(scopeID, run.id)
      expect(before.seats.some((seat) => !!seat.activeTaskID)).toBe(true)

      const cancelled = await WorkflowRunService.control(run.id, "cancel")
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.seats.every((seat) => !seat.activeTaskID)).toBe(true)
      expect(cancelled.seats.every((seat) => seat.status === "idle" || seat.status === "unbound")).toBe(true)
    })
  })

  test("pause halts and resume reactivates a run", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      await IssueToPrCharter.ensureSeeded(scopeID)
      const boss = await Session.create({})
      const run = await WorkflowRunService.create({
        charterID: IssueToPrCharter.CHARTER_ID,
        title: "Issues",
        bossSessionID: boss.id,
      })
      const paused = await WorkflowRunService.control(run.id, "pause")
      expect(paused.status).toBe("paused")
      const resumed = await WorkflowRunService.control(run.id, "resume")
      expect(resumed.status).toBe("active")
      const cancelled = await WorkflowRunService.control(run.id, "cancel")
      expect(cancelled.status).toBe("cancelled")
    })
  })
})
