import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Session } from "../../src/session"
import { LatticeContinuationPolicy } from "../../src/lattice/policy"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeStore } from "../../src/lattice/store"
import { SessionWorkflowService } from "../../src/session/workflow"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

async function gateFor(sessionID: string) {
  const session = await Session.get(sessionID)
  return { session, scopeID: ScopeContext.current.scope.id, sessionID, terminalMessageID: "msg_terminal" }
}

describe("LatticeContinuationPolicy", () => {
  test("does not handle a session outside Lattice mode", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      expect(await LatticeContinuationPolicy.handle(await gateFor(session.id))).toBeUndefined()
    })
  })

  test("proposes a continuation in initial_planning", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })

      const proposal = await LatticeContinuationPolicy.handle(await gateFor(session.id))

      if (!proposal || proposal.kind !== "inbox") throw new Error("expected inbox proposal")
      expect(proposal.kind).toBe("inbox")
      expect(proposal.mode).toBe("steer")
      expect(proposal.message.summary?.title).toBe("Continue Lattice pathway")
      expect(proposal.message.metadata?.source).toBe("lattice_continuation")
    })
  })

  test("does not fire during collaborative blueprint_review", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "collaborative" })
      const scopeID = ScopeContext.current.scope.id
      await LatticeMachine.patch(scopeID, session.id, { steps: [{ title: "A", objective: "a" }] })
      await LatticeMachine.patch(scopeID, session.id, { bindCurrentBlueprint: { noteID: "note_a" } })
      expect((await LatticeStore.get(scopeID, session.id)).phase).toBe("blueprint_review")
      expect(await LatticeContinuationPolicy.handle(await gateFor(session.id))).toBeUndefined()
    })
  })

  test("does not fire when the run is paused", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      await LatticeMachine.pause(ScopeContext.current.scope.id, session.id, "user_exit")
      expect(await LatticeContinuationPolicy.handle(await gateFor(session.id))).toBeUndefined()
    })
  })

  test("handles budget exhaustion without proposing inbox work", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto", maxModelCalls: 1 })
      const scopeID = ScopeContext.current.scope.id
      await LatticeStore.update(scopeID, session.id, (draft) => {
        draft.modelCallCount = 1
      })

      expect(await LatticeContinuationPolicy.handle(await gateFor(session.id))).toEqual({ kind: "handled" })
      const run = await LatticeStore.get(scopeID, session.id)
      expect(run.status).toBe("paused")
      expect(run.statusReason).toBe("model_call_budget_exhausted")
    })
  })

  test("auto blueprint_execution starts the current step's loop", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await SessionWorkflowService.enableLattice(session.id, { kind: "lattice", mode: "auto" })
      const scopeID = ScopeContext.current.scope.id
      await LatticeMachine.patch(scopeID, session.id, { steps: [{ title: "A", objective: "a" }] })
      await LatticeMachine.patch(scopeID, session.id, { bindCurrentBlueprint: { noteID: "note_a" } })

      expect(await LatticeContinuationPolicy.handle(await gateFor(session.id))).toEqual({ kind: "handled" })
      const run = await LatticeStore.get(scopeID, session.id)
      const step = LatticeMachine.currentStep(run)
      expect(step?.status).toBe("running")
      expect(step?.blueprintLoopID).toBeDefined()
      expect(run.firstBlueprintStarted).toBe(true)
    })
  })
})
