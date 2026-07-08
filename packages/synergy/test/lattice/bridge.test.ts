import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { LoopEvent } from "../../src/blueprint/event"
import { LatticeBridge } from "../../src/lattice/bridge"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeStore } from "../../src/lattice/store"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

async function runningRun(scopeID: string) {
  const session = await Session.create({})
  await LatticeStore.reset({ sessionID: session.id, mode: "auto" })
  await LatticeMachine.patch(scopeID, session.id, { steps: [{ title: "A", objective: "a" }] })
  await LatticeMachine.patch(scopeID, session.id, { bindCurrentBlueprint: { noteID: "note_a" } })
  const run = await LatticeMachine.onLoopStarted(
    scopeID,
    session.id,
    (await LatticeStore.get(scopeID, session.id)).currentStepID!,
    "bll_a",
  )
  return { session, run }
}

function loopEvent(overrides: Record<string, unknown>) {
  return {
    id: "bll_a",
    scopeID: ScopeContext.current.scope.id,
    status: "completed",
    source: "lattice",
    ...overrides,
  } as any
}

describe("LatticeBridge", () => {
  test("completed loop event advances the run to result_analysis", async () => {
    await withScope(async () => {
      LatticeBridge.init()
      const scopeID = ScopeContext.current.scope.id
      const { session } = await runningRun(scopeID)
      await Bus.publish(LoopEvent.Updated, {
        loop: loopEvent({ sessionID: session.id, status: "completed" }),
      })
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.phase).toBe("result_analysis")
      expect(run.pathway[0].status).toBe("completed")
    })
  })

  test("failed loop event marks the step failed", async () => {
    await withScope(async () => {
      LatticeBridge.init()
      const scopeID = ScopeContext.current.scope.id
      const { session } = await runningRun(scopeID)
      await Bus.publish(LoopEvent.Updated, {
        loop: loopEvent({ sessionID: session.id, status: "failed", error: "boom" }),
      })
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.phase).toBe("result_analysis")
      expect(run.pathway[0].status).toBe("failed")
    })
  })

  test("ignores loops not owned by lattice", async () => {
    await withScope(async () => {
      LatticeBridge.init()
      const scopeID = ScopeContext.current.scope.id
      const { session } = await runningRun(scopeID)
      await Bus.publish(LoopEvent.Updated, {
        loop: loopEvent({ sessionID: session.id, status: "completed", source: "user" }),
      })
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.phase).toBe("blueprint_execution") // unchanged
    })
  })

  test("is inert when the run is already paused", async () => {
    await withScope(async () => {
      LatticeBridge.init()
      const scopeID = ScopeContext.current.scope.id
      const { session } = await runningRun(scopeID)
      await LatticeMachine.pause(scopeID, session.id, "user_exit")
      await Bus.publish(LoopEvent.Updated, {
        loop: loopEvent({ sessionID: session.id, status: "completed" }),
      })
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.status).toBe("paused")
      expect(run.pathway[0].status).toBe("ready") // reverted by pause, not completed
    })
  })
})
