import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { LatticeStore } from "../../src/lattice/store"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeRunService } from "../../src/lattice/run-service"
import { BlueprintLoopStore } from "../../src/blueprint"
import { SessionWorkflowService } from "../../src/session/workflow"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("LatticeRunService", () => {
  test("workflow enable creates a run and writes session workflow", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const after = await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)
      expect(run.status).toBe("active")
      expect(run.maxModelCalls).toBe(0)
      expect(after.workflow).toEqual({
        kind: "lattice",
        runID: run.id,
        mode: "auto",
        firstBlueprintStarted: false,
      })
    })
  })

  test("enable updates mode and budget on an active run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "collaborative", maxModelCalls: 5 })
      expect(run.mode).toBe("collaborative")
      expect(run.maxModelCalls).toBe(5)
    })
  })

  test("workflow disable pauses the run and clears session workflow", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      await SessionWorkflowService.setNone(session.id)
      const run = await LatticeStore.get(ScopeContext.current.scope.id, session.id)
      expect(run?.status).toBe("paused")
      expect(run?.statusReason).toBe("user_exit")
      const after = await Session.get(session.id)
      expect(after.workflow).toBeUndefined()
      // Data preserved for later continue.
      const stored = await LatticeStore.getOrUndefined(ScopeContext.current.scope.id, session.id)
      expect(stored?.status).toBe("paused")
    })
  })

  test("re-enabling a paused run continues the same run (not a second one)", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeRunService.disable(session.id)
      const resumed = await LatticeRunService.enable({ sessionID: session.id, mode: "auto", action: "continue" })
      expect(resumed.id).toBe(first.id)
      expect(resumed.status).toBe("active")
      const runs = await LatticeStore.list(ScopeContext.current.scope.id)
      expect(runs).toHaveLength(1)
    })
  })

  test("restart replaces the run in place", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const first = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      await LatticeMachine.patch(ScopeContext.current.scope.id, session.id, {
        steps: [{ title: "A", objective: "a" }],
      })
      const restarted = await LatticeRunService.enable({ sessionID: session.id, mode: "auto", action: "restart" })
      expect(restarted.id).not.toBe(first.id)
      expect(restarted.phase).toBe("initial_planning")
      expect(restarted.pathway).toHaveLength(0)
      const runs = await LatticeStore.list(ScopeContext.current.scope.id)
      expect(runs).toHaveLength(1)
    })
  })

  test("enable rejects a session that already has an active foreign BlueprintLoop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const loop = await BlueprintLoopStore.create({ noteID: "note_x", title: "T", sessionID: session.id })
      await Session.update(session.id, (draft) => {
        draft.blueprint = { loopID: loop.id }
      })
      await expect(LatticeRunService.enable({ sessionID: session.id, mode: "auto" })).rejects.toThrow()
    })
  })

  test("cancel cancels the run", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const cancelled = await LatticeRunService.cancel(run.id)
      expect(cancelled.status).toBe("cancelled")
    })
  })
})
