import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Attachment } from "../../src/attachment"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInbox } from "../../src/session/inbox"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionManager } from "../../src/session/manager"
import { createUserMessage } from "../../src/session/input"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const sessionID = "ses_wake_retry_test"
const originalDelays = [...SessionManager.WAKE_RETRY_DELAYS_MS]
const FAST_DELAYS = [5, 5, 5, 5]
const MAX_ATTEMPTS = 1 + FAST_DELAYS.length

function fastDelays() {
  SessionManager.WAKE_RETRY_DELAYS_MS.splice(0, SessionManager.WAKE_RETRY_DELAYS_MS.length, ...FAST_DELAYS)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for wake retries")
    await Bun.sleep(5)
  }
}

describe("session wake retry", () => {
  afterEach(() =>
    runtime.run(() => {
      SessionManager.WAKE_RETRY_DELAYS_MS.splice(0, SessionManager.WAKE_RETRY_DELAYS_MS.length, ...originalDelays)
      mock.restore()
    }),
  )

  test("wake tolerates a failed pre-loop repair and still drives the loop", () =>
    runtime.run(async () => {
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockRejectedValue(new Error("repair storage unavailable"))
      const loop = spyOn(SessionInvoke, "loop").mockResolvedValue({} as never)

      await SessionManager.wake(sessionID)

      expect(loop).toHaveBeenCalledTimes(1)
    }))

  test("scheduleWake retries transient loop failures until the inbox is driven", () =>
    runtime.run(async () => {
      fastDelays()
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
      let attempts = 0
      const loop = spyOn(SessionInvoke, "loop").mockImplementation((() => {
        attempts++
        return attempts < 3 ? Promise.reject(new Error("transient provider failure")) : Promise.resolve({} as never)
      }) as unknown as typeof SessionInvoke.loop)

      SessionManager.scheduleWake(sessionID, "user-input")
      await waitFor(() => loop.mock.calls.length >= 3)
      expect(attempts).toBe(3)
    }))

  test("scheduleWake gives up after bounded retries", () =>
    runtime.run(async () => {
      fastDelays()
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
      const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(new Error("permanent failure"))

      SessionManager.scheduleWake(sessionID, "user-input")
      await waitFor(() => loop.mock.calls.length >= MAX_ATTEMPTS)
      await Bun.sleep(30)
      expect(loop.mock.calls.length).toBe(MAX_ATTEMPTS)
    }))
  test("scheduleWake abandons the chain immediately on a permanent worktree failure", () =>
    runtime.run(async () => {
      fastDelays()
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
      const failure = new Error("Worktree directory not found: /tmp/gone")
      failure.name = "WorktreeNotFoundError"
      const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(failure)

      SessionManager.scheduleWake(sessionID, "user-input")
      await waitFor(() => loop.mock.calls.length >= 1)
      await Bun.sleep(40)
      expect(loop.mock.calls.length).toBe(1)
    }))

  test("keeps retrying InvalidUrlError through the bounded chain", () =>
    runtime.run(async () => {
      fastDelays()
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
      const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(new Attachment.InvalidUrlError())

      SessionManager.scheduleWake(sessionID, "user-input")
      await waitFor(() => loop.mock.calls.length >= MAX_ATTEMPTS)
      await Bun.sleep(30)
      expect(loop.mock.calls.length).toBe(MAX_ATTEMPTS)
    }))

  test("scheduleWake coalesces duplicate requests for the same session", () =>
    runtime.run(async () => {
      fastDelays()
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
      const loop = spyOn(SessionInvoke, "loop").mockRejectedValue(new Error("permanent failure"))

      SessionManager.scheduleWake(sessionID, "user-input")
      SessionManager.scheduleWake(sessionID, "user-input")
      await waitFor(() => loop.mock.calls.length >= MAX_ATTEMPTS)
      await Bun.sleep(30)
      expect(loop.mock.calls.length).toBe(MAX_ATTEMPTS)
    }))
  test("scheduleWake preserves a release request arriving while the loop is finishing", () =>
    runtime.run(async () => {
      spyOn(SessionInbox, "hasRunnableItem").mockResolvedValue(true)
      spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)
      let attempts = 0
      const loop = spyOn(SessionInvoke, "loop").mockImplementation((async () => {
        attempts++
        if (attempts === 1) SessionManager.scheduleWake(sessionID, "release")
        return {} as never
      }) as unknown as typeof SessionInvoke.loop)
      SessionManager.scheduleWake(sessionID, "user-input")
      await waitFor(() => loop.mock.calls.length === 2)
      expect(attempts).toBe(2)
    }))
  test("a drained InvalidUrlError does not strand the task queued behind it", () =>
    runtime.run(async () => {
      fastDelays()
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          const root = await createUserMessage({
            sessionID: session.id,
            model: { providerID: "test", modelID: "test" },
            parts: [{ type: "text", text: "root request" }],
          })
          await SessionInbox.enqueueUser({
            sessionID: session.id,
            noReply: true,
            parts: [
              { type: "text", text: "poisoned steer" },
              { type: "attachment", mime: "text/plain", filename: "broken.txt", url: "data:text/plain;base64,!!!" },
            ],
          })
          await SessionInbox.enqueueUser({
            sessionID: session.id,
            parts: [{ type: "text", text: "real task" }],
          })

          let attempts = 0
          let committed = false
          const loop = spyOn(SessionInvoke, "loop").mockImplementation((async () => {
            attempts++
            if (attempts === 1) {
              // Failed materialization parks the original payload so later work can proceed.
              const steerItems = await SessionInbox.peekSteer(session.id)
              expect(steerItems.length).toBe(1)
              for (const item of steerItems) await SessionInbox.materializeItem(item, root.info.id)
              return {} as never
            }
            expect((await SessionInbox.peekSteer(session.id)).length).toBe(0)
            const task = await SessionInbox.peekTask(session.id)
            expect(task).toBeDefined()
            await SessionInbox.materializeItem(task!)
            await SessionInbox.commitReady(session.id, [task!.id])
            committed = true
            return {} as never
          }) as unknown as typeof SessionInvoke.loop)
          spyOn(SessionInvoke, "repairAfterAbort").mockResolvedValue(false)

          SessionManager.scheduleWake(session.id, "test")
          await waitFor(() => committed)
          expect(attempts).toBe(2)
          expect((await SessionInbox.list(session.id)).some((item) => item.status === "failed")).toBe(true)
          expect(await SessionInbox.peekTask(session.id)).toBeUndefined()
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())

test("closing admission cancels scheduled wakeups and drains an in-flight failure without retrying", async () => {
  await using owned = await testRuntime()
  await owned.run(async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let attempts = 0
    using pending = spyOn(SessionInbox, "hasRunnableItem").mockImplementation(async () => {
      attempts++
      entered.resolve()
      await release.promise
      throw new Error("in-flight wake failure")
    })
    SessionManager.scheduleWake("ses_closing_wake", "test")
    await entered.promise
    SessionManager.closeAdmission()
    let drained = false
    const drain = SessionManager.drain().then(() => {
      drained = true
    })
    await Bun.sleep(5)
    expect(drained).toBe(false)
    release.resolve()
    await drain
    SessionManager.scheduleWake("ses_after_close", "test")
    await Bun.sleep(300)
    expect(attempts).toBe(1)
  })
})
