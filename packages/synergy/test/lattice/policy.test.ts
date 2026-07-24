import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { LatticeContinuationPolicy } from "../../src/lattice/policy"
import { LatticeStore } from "../../src/lattice/store"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

setDefaultTimeout(30_000)

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

  test("derives ordinary continuation from state and terminal message without persisting an effect", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: run.id, mode: run.mode }
      })

      const proposal = await LatticeContinuationPolicy.handle(await gateFor(session.id))
      const stored = await LatticeStore.get(ScopeContext.current.scope.id, session.id)

      expect(proposal?.kind).toBe("inbox")
      expect(proposal?.kind === "inbox" ? proposal.deliveryKey : undefined).toBe(
        `lattice:${run.id}:continue:msg_terminal`,
      )
      expect(stored.effect).toBeUndefined()
    })
  })

  test("pure budget convergence pauses and returns undefined instead of empty handled", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const run = await LatticeStore.create({ sessionID: session.id, mode: "auto", maxModelCalls: 1 })
      await Session.update(session.id, (draft) => {
        draft.workflow = { kind: "lattice", runID: run.id, mode: run.mode }
      })
      await LatticeStore.update(ScopeContext.current.scope.id, session.id, (draft) => {
        draft.modelCallCount = 1
      })

      expect(await LatticeContinuationPolicy.handle(await gateFor(session.id))).toBeUndefined()
      expect((await LatticeStore.get(ScopeContext.current.scope.id, session.id)).statusReason).toBe(
        "model_call_budget_exhausted",
      )
    })
  })
})
