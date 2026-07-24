import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "../../src/blueprint"
import { LoopEvent } from "../../src/blueprint/event"
import { Bus } from "../../src/bus"
import { Identifier } from "../../src/id/id"
import { LatticeBridge } from "../../src/lattice/bridge"
import { LatticeMachine } from "../../src/lattice/machine"
import { LatticeRuntime } from "../../src/lattice/runtime"
import { LatticeStore } from "../../src/lattice/store"
import type { LatticeTypes } from "../../src/lattice/types"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { tmpdir } from "../fixture/fixture"

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

function envelope(run: LatticeTypes.Run) {
  return {
    id: Identifier.ascending("lattice_action"),
    source: "agent" as const,
    expectedStateRevision: run.stateRevision,
    expectedPathwayRevision: run.pathwayRevision,
    time: { created: Date.now() },
  }
}

async function runningRun(scopeID: string) {
  const session = await Session.create({})
  let run = await LatticeStore.create({ sessionID: session.id, mode: "auto" })

  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.consumePendingAction(
      LatticeMachine.queueAction(draft, {
        ...envelope(draft),
        kind: "submit_requirements",
        requirements: {
          goal: "Complete A",
          successCriteria: ["A is verified"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
        },
      }),
    ),
  )
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.writePathway(draft, [{ title: "A", objective: "Complete A" }]),
  )
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.consumePendingAction(
      LatticeMachine.queueAction(draft, { ...envelope(draft), kind: "submit_pathway", reason: "ready" }),
    ),
  )
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.consumePendingAction(
      LatticeMachine.queueAction(draft, {
        ...envelope(draft),
        kind: "submit_pathway_review",
        reason: "reviewed",
      }),
    ),
  )
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.consumePendingAction(
      LatticeMachine.queueAction(draft, {
        ...envelope(draft),
        kind: "submit_blueprint",
        blueprintID: "note_blueprint",
        blueprintVersion: 1,
        contentDigest: "digest-a",
      }),
    ),
  )
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.consumePendingAction(
      LatticeMachine.queueAction(draft, {
        ...envelope(draft),
        kind: "submit_blueprint_review",
        reason: "reviewed",
        blueprintVersion: 1,
        contentDigest: "digest-a",
      }),
    ),
  )

  const loop = await BlueprintLoopStore.create({
    noteID: "note_blueprint",
    title: "Test Blueprint",
    sessionID: session.id,
    source: "lattice",
    sourceDigest: "digest-a",
  })
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) =>
    LatticeMachine.onLoopCreated(draft, { loopID: loop.id, blueprintVersion: 1, sourceDigest: "digest-a" }),
  )
  const running = await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "running" })
  run = await LatticeStore.updateByRunID(scopeID, run.id, (draft) => LatticeMachine.onLoopStarted(draft, loop.id))
  await SessionInbox.deliverUnique({
    sessionID: session.id,
    deliveryKey: `test:blueprint-prompt:${loop.id}`,
    mode: "context",
    message: {
      role: "user",
      visible: false,
      metadata: { loopID: loop.id },
      parts: [{ type: "text", text: "Blueprint prompt receipt" }],
    },
  })
  return { session, run, loop: running }
}

async function waitForRun(
  scopeID: string,
  sessionID: string,
  predicate: (run: LatticeTypes.Run) => boolean,
): Promise<LatticeTypes.Run> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const run = await LatticeStore.get(scopeID, sessionID)
    if (predicate(run)) return run
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for Lattice Runtime reconciliation")
}

describe("LatticeBridge", () => {
  test("uses BlueprintLoop records as facts and Bus updates only as best-effort wakeups", async () => {
    await withScope(async () => {
      const scopeID = ScopeContext.current.scope.id
      const { session, loop } = await runningRun(scopeID)
      LatticeBridge.init()
      LatticeBridge.init()
      await LatticeRuntime.init()

      const completedLoop = await BlueprintLoopStore.updateStatus(scopeID, loop.id, { status: "completed" })
      const completedRun = await waitForRun(
        scopeID,
        session.id,
        (run) => run.status === "completed" && run.effect === undefined,
      )

      expect(completedRun.pathway[0].status).toBe("completed")
      expect(completedRun.pathway[0].loopHistory[0]).toMatchObject({
        loopID: loop.id,
        status: "completed",
      })

      const revision = completedRun.revision
      await Bus.publish(LoopEvent.Updated, { loop: completedLoop })
      await Bun.sleep(50)
      expect((await LatticeStore.get(scopeID, session.id)).revision).toBe(revision)

      await Bus.publish(LoopEvent.Updated, {
        loop: { ...completedLoop, id: Identifier.ascending("blueprint_loop"), source: "user" },
      })
      await Bun.sleep(50)
      expect((await LatticeStore.get(scopeID, session.id)).revision).toBe(revision)
    })
  }, 20_000)
})
