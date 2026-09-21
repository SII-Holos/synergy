import { describe, expect, test } from "bun:test"
import { BlueprintLoopStore } from "@ericsanchezok/synergy-workflows/blueprint/loop-store"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionAbort } from "@ericsanchezok/synergy-harness/session/abort"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import * as SessionWorking from "@ericsanchezok/synergy-harness/session/working"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import "@ericsanchezok/synergy-product-runtime/product-registration"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

Log.init({ print: false })

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

describe("workflow escape hatch on the abort path", () => {
  test("a plain stop pauses the session and leaves the bound workflow recoverable", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop()

        // Precondition: a stored loop projects nothing at all. It is a record of
        // intent, not evidence that a turn is running.
        expect(await SessionWorking.resolve(session.id)).toBeUndefined()

        const result = await SessionAbort.abort(session.id)

        // The stop is honest and visible, but it destroys nothing: the user can
        // still continue the work they just stopped.
        expect(result.paused).toBe(true)
        expect(result.abandoned).toBe(false)
        expect(SessionAbort.hadEffect(result)).toBe(true)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("running")
        expect((await Session.get(session.id)).blueprint?.loopID).toBe(loop.id)

        const status = await SessionWorking.resolve(session.id)
        expect(status).toMatchObject({ status: "paused", reason: "aborted" })
      },
    })
  })

  test("an explicit abandon cancels the bound workflow and releases the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop()

        const result = await SessionAbort.abort(session.id, { abandonWorkflow: true })

        expect(result.abandoned).toBe(true)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")

        // The binding goes with the cancelled loop: leaving it behind would
        // point the session at a workflow that can never resume it.
        const refreshed = await Session.get(session.id)
        expect(refreshed.blueprint?.loopID).toBeUndefined()
        expect(refreshed.blueprint?.loopRole).toBeUndefined()

        expect(result.paused).toBe(false)
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        expect(await SessionWorking.resolve(session.id)).toBeUndefined()
      },
    })
  })

  test("an explicit abandon cancels the workflow even when durable evidence remains", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop({ withStopRequest: true, withInbox: true })

        const result = await SessionAbort.abort(session.id, { abandonWorkflow: true })

        // Abandonment is the user's decision, so it must not be vetoed by
        // liveness evidence. Refusing here would trap the user in a session that
        // recovery keeps preserving precisely because it still looks alive.
        expect(result.abandoned).toBe(true)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")
      },
    })
  })

  test("an explicit abandon of a Lattice-owned workflow still releases the session", async () => {
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

        // Recovery leaves Lattice loops alone because Lattice reconciles them
        // itself, but an explicit user abandon is not recovery: the domain cancel
        // path still runs so the work actually stops.
        const result = await SessionAbort.abort(session.id, { abandonWorkflow: true })

        expect(result.abandoned).toBe(true)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")
      },
    })
  })

  test("reports no workflow to abandon when none is bound", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        const result = await SessionAbort.abort(session.id, { abandonWorkflow: true })

        expect(result.abandoned).toBe(false)
      },
    })
  })

  test("a repeat abandon reports what it changed instead of failing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { session, loop } = await createRunningLoop()
        await SessionAbort.abort(session.id, { abandonWorkflow: true })
        await SessionLifecycle.clear(session.id)

        const second = await SessionAbort.abort(session.id, { abandonWorkflow: true })

        // Idempotent, not a second success: there is nothing left to repair or
        // to cancel, and the loop stays exactly where the first call left it.
        expect(second.repaired).toBe(false)
        expect(second.abandoned).toBe(false)
        expect((await BlueprintLoopStore.get(ScopeContext.current.scope.id, loop.id)).status).toBe("cancelled")
      },
    })
  })

  test("reports an effect on an idle session because the stop records a pause", async () => {
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
        // Recording the pause is itself the effect, so a caller must not treat
        // this as a no-op: the session is now stopped awaiting an explicit
        // continue, and reporting otherwise would hide that from the operator.
        expect(result.paused).toBe(true)
        expect(SessionAbort.hadEffect(result)).toBe(true)
      },
    })
  })

  test("reports the runtime outcome when a live turn is actually stopped", async () => {
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
          expect(result.paused).toBe(true)
          expect(SessionAbort.hadEffect(result)).toBe(true)
        } finally {
          await SessionManager.release(lease!)
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })
})
