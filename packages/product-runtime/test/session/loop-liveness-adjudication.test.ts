import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint/loop-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import "@ericsanchezok/synergy-product-runtime/product-registration"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

Log.init({ print: false })

async function createBlueprintNote() {
  return NoteStore.create({
    title: "Phantom liveness Blueprint",
    kind: "blueprint",
    blueprint: { description: "Adjudicate driverless loops after restart." },
  })
}

async function createLoop(status: "armed" | "running" | "waiting" | "auditing" = "running") {
  const session = await Session.create({})
  const note = await createBlueprintNote()
  const created = await BlueprintLoopStore.create({
    noteID: note.id,
    noteVersion: note.version,
    title: note.title,
    sessionID: session.id,
    runMode: "current",
  })
  if (status === "armed") return { session, note, loop: created }
  // `armed` only transitions to `running` or `cancelled`, so every other state
  // is reached through running exactly as the live lifecycle reaches it.
  const running = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, {
    status: "running",
  })
  if (status === "running") return { session, note, loop: running }
  const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, { status })
  return { session, note, loop }
}

async function reconcile() {
  return SessionRecovery.reconcileRuntimeState({ scopeID: ScopeContext.current.scope.id, apply: true })
}

describe("phantom BlueprintLoop adjudication on restart", () => {
  test("terminalizes a running loop with no durable driver and clears its references", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, note, loop } = await createLoop("running")
        // A crash after bind leaves the references in place and no driver behind them.
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        await NoteStore.update(ScopeContext.current.scope.id, note.id, {
          blueprint: { activeLoopID: loop.id },
        })

        await reconcile()

        const after = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(after.status).toBe("failed")
        expect(after.error).toStartWith("interrupted:")

        const refreshed = await Session.get(session.id)
        expect(refreshed.blueprint?.loopID).toBeUndefined()
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedNote.blueprint?.activeLoopID).toBeUndefined()
      },
    })
  })

  test("leaves the session idle rather than pinned in recovering", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createLoop("running")
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        await reconcile()

        const statuses = await SessionManager.listStatuses(ScopeContext.current.scope.id)
        expect(statuses[session.id]).toBeUndefined()
      },
    })
  })

  test("cancels an orphaned armed loop because failed is not a legal transition from armed", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { loop } = await createLoop("armed")
        await reconcile()
        const after = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(after.status).toBe("cancelled")
      },
    })
  })

  test("frees the Blueprint so a new loop can start after adjudication", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, note, loop } = await createLoop("running")
        expect(loop.status).toBe("running")
        await reconcile()
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("failed")

        // The retired run must not block a fresh one on the same Blueprint.
        const restarted = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        expect(restarted.status).toBe("armed")
      },
    })
  })
})

describe("phantom BlueprintLoop adjudication preserves real drivers", () => {
  test("preserves a user-paused loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createLoop("waiting")
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        await reconcile()

        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("waiting")
        const refreshed = await Session.get(session.id)
        expect(refreshed.blueprint?.loopID).toBe(loop.id)
      },
    })
  })

  test("preserves a loop awaiting review because its stop intent is durable evidence", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const created = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        // The stop intent lands with the armed -> running transition, since a
        // loop never re-enters `running` from `running`.
        const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, {
          status: "running",
          stopRequest: {
            summary: "Audit after restart",
            requestedAt: Date.now(),
            requesterSessionID: session.id,
            requesterMessageID: "msg_stop_evidence",
          },
        })
        expect(loop.stopRequest?.summary).toBe("Audit after restart")

        await reconcile()

        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
      },
    })
  })

  test("preserves a loop whose session has runnable inbox work", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createLoop("running")
        await SessionInbox.enqueueMail({
          sessionID: session.id,
          mail: {
            type: "user",
            agent: "test",
            model: { providerID: "test-provider", modelID: "test-model" },
            parts: [
              {
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: Identifier.ascending("message"),
                type: "text",
                text: "resume this loop",
              },
            ],
          },
        })

        await reconcile()

        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
      },
    })
  })

  test("preserves a Lattice-owned loop because Lattice reconciles it after session recovery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const created = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
          source: "lattice",
          sourceDigest: "digest-lattice-1",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, { status: "running" })

        await reconcile()

        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, created.id)).status).toBe("running")
      },
    })
  })

  test("never terminalizes a loop that already reached a terminal status", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const note = await createBlueprintNote()
        const created = await BlueprintLoopStore.create({
          noteID: note.id,
          noteVersion: note.version,
          title: note.title,
          sessionID: session.id,
          runMode: "current",
        })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, { status: "running" })
        await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, {
          status: "completed",
          summary: "done",
        })

        await reconcile()

        const after = await BlueprintLoopStore.get(ScopeContext.current.scope.id, created.id)
        expect(after.status).toBe("completed")
        expect(after.summary).toBe("done")
        expect(after.error).toBeUndefined()
      },
    })
  })
})
