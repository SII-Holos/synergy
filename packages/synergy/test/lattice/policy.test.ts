import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { LatticeContinuationPolicy } from "../../src/lattice/policy"
import { LatticeRunService } from "../../src/lattice/run-service"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeStore } from "../../src/lattice/store"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

let originalDeliver: typeof SessionManager.deliver

beforeEach(() => {
  originalDeliver = SessionManager.deliver
})
afterEach(() => {
  ;(SessionManager.deliver as any) = originalDeliver
})

async function gateFor(sessionID: string) {
  const session = await Session.get(sessionID)
  return { session, scopeID: ScopeContext.current.scope.id, sessionID, terminalMessageID: "msg_terminal" }
}

describe("LatticeContinuationPolicy", () => {
  test("returns false when the session is not in Lattice mode", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const handled = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      expect(handled).toBe(false)
    })
  })

  test("delivers a continuation in initial_planning", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const deliveries: any[] = []
      ;(SessionManager.deliver as any) = mock(async (input: any) => {
        deliveries.push(input)
      })
      const handled = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      expect(handled).toBe(true)
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0].mail.metadata.source).toBe("lattice_continuation")
    })
  })

  test("does not fire during collaborative blueprint_review", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeRunService.enable({ sessionID: session.id, mode: "collaborative" })
      const scopeID = ScopeContext.current.scope.id
      await LatticeMachine.patch(scopeID, session.id, { steps: [{ title: "A", objective: "a" }] })
      await LatticeMachine.patch(scopeID, session.id, { bindCurrentBlueprint: { noteID: "note_a" } })
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.phase).toBe("blueprint_review")

      const deliver = mock(async () => {})
      ;(SessionManager.deliver as any) = deliver
      const handled = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      expect(handled).toBe(false)
      expect(deliver).not.toHaveBeenCalled()
    })
  })

  test("does not fire when the run is paused", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      // Manually pause but keep session.lattice for the gate.
      await LatticeMachine.pause(ScopeContext.current.scope.id, session.id, "user_exit")
      const deliver = mock(async () => {})
      ;(SessionManager.deliver as any) = deliver
      const handled = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      expect(handled).toBe(false)
    })
  })

  test("pauses the run when the model-call budget is exhausted", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeRunService.enable({ sessionID: session.id, mode: "auto", maxModelCalls: 1 })
      const scopeID = ScopeContext.current.scope.id
      await LatticeStore.update(scopeID, session.id, (draft) => {
        draft.modelCallCount = 1
      })
      const deliver = mock(async () => {})
      ;(SessionManager.deliver as any) = deliver
      const handled = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      expect(handled).toBe(true)
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.status).toBe("paused")
      expect(run.statusReason).toBe("model_call_budget_exhausted")
      expect(deliver).not.toHaveBeenCalled()
    })
  })

  test("auto blueprint_execution starts the current step's loop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await LatticeRunService.enable({ sessionID: session.id, mode: "auto" })
      const scopeID = ScopeContext.current.scope.id
      await LatticeMachine.patch(scopeID, session.id, { steps: [{ title: "A", objective: "a" }] })
      await LatticeMachine.patch(scopeID, session.id, { bindCurrentBlueprint: { noteID: "note_a" } })
      // phase is now blueprint_execution, no loop started yet
      ;(SessionManager.deliver as any) = mock(async () => {})
      const handled = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      expect(handled).toBe(true)
      const run = await LatticeStore.get(scopeID, session.id)
      const step = LatticeMachine.currentStep(run)
      expect(step?.status).toBe("running")
      expect(step?.blueprintLoopID).toBeDefined()
      expect(run.firstBlueprintStarted).toBe(true)
    })
  })
})
