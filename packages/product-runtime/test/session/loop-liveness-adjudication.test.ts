import { describe, expect, spyOn, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint/loop-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import "@ericsanchezok/synergy-product-runtime/product-registration"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

Log.init({ print: false })

async function createBlueprintNote() {
  return NoteStore.create({
    title: "Orphaned liveness Blueprint",
    kind: "blueprint",
    blueprint: { description: "Adjudicate driverless loops after restart." },
  })
}

async function createLoop(status: "armed" | "running" | "auditing" = "running") {
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

describe("orphaned BlueprintLoop adjudication on restart", () => {
  test("preserves a loop when its inbox evidence cannot be read", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { loop } = await createLoop("running")
        const read = spyOn(SessionInbox, "hasRunnableItem")
        read.mockRejectedValueOnce(new Error("Evidence storage is temporarily unavailable"))
        try {
          const report = await reconcile()
          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
          expect(report.entries.some((entry) => entry.action.startsWith("scope_reconcile_failed:"))).toBe(true)
        } finally {
          read.mockRestore()
        }
      },
    })
  })

  test("stops the session of a running loop with no durable driver and keeps the loop", async () => {
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

        // The loop record is left exactly as stored. A restart is evidence the
        // turn stopped, not that the user's work should be destroyed, and this
        // record is the only handle left for continuing or abandoning it.
        const after = await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)
        expect(after.status).toBe("running")
        expect(after.error).toBeUndefined()

        // The references therefore stay bound, because the loop they point at is
        // still live.
        const refreshed = await Session.get(session.id)
        expect(refreshed.blueprint?.loopID).toBe(loop.id)
        const refreshedNote = await NoteStore.get(ScopeContext.current.scope.id, note.id)
        expect(refreshedNote.blueprint?.activeLoopID).toBe(loop.id)
      },
    })
  })

  test("reports the stopped session with the workflow that holds it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createLoop("running")
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        await reconcile()

        // The status must name the cause, so the user has something actionable
        // instead of an unexplained stall that no control can clear.
        const statuses = await SessionManager.listStatuses(ScopeContext.current.scope.id)
        expect(statuses[session.id]).toMatchObject({
          type: "paused",
          reason: "workflow",
          description: "Stopped by BlueprintLoop; continue or abandon",
        })
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("workflow")
      },
    })
  })

  test("stops the session of an orphaned armed loop and preserves the loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createLoop("armed")
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        await reconcile()

        // `armed` has no in-flight work, but adjudication no longer invents a
        // terminal outcome for it either: the user's intent is preserved and the
        // session is what stops.
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("armed")
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("workflow")
      },
    })
  })

  test("keeps the preserved loop as the user's only handle on the stopped work", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, note, loop } = await createLoop("running")
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })

        await reconcile()

        // Adjudication deliberately does not free the Blueprint: the stopped
        // loop is the record the user continues or abandons from, so a second
        // loop on the same Blueprint is refused rather than silently allowed to
        // orphan the first one.
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
        await expect(
          BlueprintLoopStore.create({
            noteID: note.id,
            noteVersion: note.version,
            title: note.title,
            sessionID: session.id,
            runMode: "current",
          }),
        ).rejects.toMatchObject({ name: "BlueprintLoopAlreadyActive" })
      },
    })
  })
})

describe("orphaned BlueprintLoop adjudication preserves real drivers", () => {
  test("does not rewrite a pause the user already recorded", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createLoop("running")
        await Session.update(session.id, (draft) => {
          draft.blueprint = { loopID: loop.id, loopRole: "execution" }
        })
        // The user's own stop, recorded before any reconciliation ran.
        await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
        const before = await SessionLifecycle.snapshot(session.id)

        await reconcile()

        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
        // First pause wins: rewriting here would churn `since` and replace the
        // user's own cause with the workflow's.
        expect(await SessionLifecycle.snapshot(session.id)).toEqual(before)
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("aborted")
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
        // A loop that still owes a verdict is not orphaned, so the session is
        // left alone rather than being stopped under the user.
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
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
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
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
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
      },
    })
  })

  test("never touches a loop that already reached a terminal status", async () => {
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
