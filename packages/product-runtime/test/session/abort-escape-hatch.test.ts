import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint/loop-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import * as SessionWorking from "@ericsanchezok/synergy-harness/session/working"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

async function createBlueprintNote() {
  return NoteStore.create({
    title: "Abort escape hatch Blueprint",
    kind: "blueprint",
    blueprint: { description: "Stop a driverless workflow from the abort path." },
  })
}

async function createRunningLoop(input: { withStopRequest?: boolean; withInbox?: boolean } = {}) {
  const session = await Session.create({})
  const note = await createBlueprintNote()
  const created = await BlueprintLoopStore.create({
    noteID: note.id,
    noteVersion: note.version,
    title: note.title,
    sessionID: session.id,
    runMode: "current",
  })
  const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, {
    status: "running",
    ...(input.withStopRequest
      ? {
          stopRequest: {
            summary: "review me",
            requestedAt: Date.now(),
            requesterSessionID: session.id,
            requesterMessageID: "msg_abort_evidence",
          },
        }
      : {}),
  })
  await Session.update(session.id, (draft) => {
    draft.blueprint = { loopID: loop.id, loopRole: "execution" }
  })
  if (input.withInbox) {
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
            text: "queued work",
          },
        ],
      },
    })
  }
  return { session, note, loop }
}

describe("abort escape hatch for a driverless workflow", () => {
  test("frees a session pinned by a phantom BlueprintLoop and reports the effect", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, loop } = await createRunningLoop()

          // Before the stop, the loop pins the session as recovering.
          const before = await SessionWorking.resolve(session.id)
          expect(before?.status).toBe("recovering")
          if (before?.status !== "recovering") throw new Error("expected recovering status")
          expect(before.reason).toBe("workflow")

          const result = await SessionAbort.abort(session.id)

          expect(result.abandoned).toBe(true)
          expect(SessionAbort.hadEffect(result)).toBe(true)
          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")

          // The session is genuinely unblocked, not merely reported as idle.
          expect(await SessionWorking.resolve(session.id)).toBeUndefined()
          const refreshed = await Session.get(session.id)
          expect(refreshed.blueprint?.loopID).toBeUndefined()
        },
      })
    }))

  test("does not abandon a loop that still has a durable driver", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { session, loop } = await createRunningLoop({ withStopRequest: true })

          const result = await SessionAbort.abort(session.id)

          expect(result.abandoned).toBe(false)
          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
        },
      })
    }))

  test("does not abandon a Lattice-owned loop, which owns its own restart", () =>
    runtime.run(async () => {
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
            sourceDigest: "digest-abort-lattice",
          })
          const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, {
            status: "running",
          })
          await Session.update(session.id, (draft) => {
            draft.blueprint = { loopID: loop.id, loopRole: "execution" }
          })

          const result = await SessionAbort.abort(session.id)

          expect(result.abandoned).toBe(false)
          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
        },
      })
    }))

  test("does not abandon a user-paused loop", () =>
    runtime.run(async () => {
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
          const loop = await BlueprintLoopStore.updateStatus(ScopeContext.current.scope.id, created.id, {
            status: "waiting",
          })
          await Session.update(session.id, (draft) => {
            draft.blueprint = { loopID: loop.id, loopRole: "execution" }
          })

          const result = await SessionAbort.abort(session.id)

          expect(result.abandoned).toBe(false)
          expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("waiting")
        },
      })
    }))

  test("reports no effect when aborting an idle session with nothing to stop", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})

          const result = await SessionAbort.abort(session.id)

          // The session has a runtime slot but no owner: the honest outcome is
          // that no running turn was stopped, not that work was canceled.
          expect(["idle", "not_found"]).toContain(result.outcome)
          expect(result.repaired).toBe(false)
          expect(result.abandoned).toBe(false)
          expect(SessionAbort.hadEffect(result)).toBe(false)
        },
      })
    }))

  test("reports the runtime outcome when a live turn is actually stopped", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const lease = SessionManager.acquire(session.id)
          expect(lease).toBeDefined()
          try {
            const result = await SessionAbort.abort(session.id)
            expect(result.outcome).toBe("signaled")
            expect(SessionAbort.hadEffect(result)).toBe(true)
          } finally {
            await SessionManager.release(lease!)
            SessionManager.unregisterRuntime(session.id)
          }
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
