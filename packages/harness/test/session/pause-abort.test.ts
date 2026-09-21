import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionAbort } from "../../src/session/abort"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionProgress } from "../../src/session/progress"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionHistory } from "../../src/session/history"
import { SessionManager } from "../../src/session/manager"
import { SessionInbox } from "../../src/session/inbox"
import { SessionCortexRuntime } from "../../src/session/cortex-runtime"

/** A reply-required root plus a non-terminal assistant: the persisted shape of
 *  a turn that stopped mid-work. */
async function createInterruptedTurn(sessionID: string) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    isRoot: true,
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    modelID: "test-model",
    providerID: "test-provider",
    path: { cwd: process.cwd(), root: process.cwd() },
    mode: "test",
    agent: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

async function latestAssistant(sessionID: string) {
  const messages = await SessionHistory.modelMessages({ sessionID })
  return messages.findLast((message) => message.info.role === "assistant")?.info as MessageV2.Assistant | undefined
}

describe("abort leaves an interactive session paused", () => {
  test("waiting for a stopped execution also waits for its external lease owner", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const lease = SessionManager.acquire(session.id)!
        const started = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<void>()
        const running = SessionManager.run(
          session.id,
          async () => {
            started.resolve()
            await cleanup.promise
          },
          { lease, releaseLease: false },
        )
        await started.promise
        let idle = false
        const waiting = SessionManager.waitForIdle(session.id).then(() => {
          idle = true
        })
        try {
          cleanup.resolve()
          await running
          await Bun.sleep(0)
          expect(idle).toBe(false)
          SessionManager.release(lease)
          await waiting
          expect(idle).toBe(true)
        } finally {
          cleanup.resolve()
          SessionManager.release(lease)
          await running
          await waiting
        }
      },
    })
  })
  test("abandon fences old work while descendant cancellation is pending and preserves later input", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await createInterruptedTurn(session.id)
        await SessionInbox.enqueueUser({ sessionID: session.id, parts: [{ type: "text", text: "Old queued work" }] })
        const started = Promise.withResolvers<void>()
        const cancelling = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<void>()
        const cancelChildren = spyOn(SessionCortexRuntime, "cancelAllForParent").mockImplementation(async () => {
          cancelling.resolve()
          await cleanup.promise
        })
        const schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
        const running = SessionManager.run(session.id, async (lease) => {
          started.resolve()
          await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }))
        })
        let abandoning: ReturnType<typeof SessionAbort.abort> | undefined
        try {
          await started.promise
          abandoning = SessionAbort.abort(session.id, { terminalize: true, abandonWorkflow: true })
          await cancelling.promise
          expect(await SessionInbox.list(session.id)).toEqual([])
          const later = await SessionInbox.enqueueUser({
            sessionID: session.id,
            parts: [{ type: "text", text: "New request" }],
          })
          await running
          expect(schedule).not.toHaveBeenCalled()
          expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()
          cleanup.resolve()
          expect((await abandoning).paused).toBe(false)
          expect((await SessionInbox.list(session.id)).map((item) => item.id)).toEqual([later.id])
        } finally {
          cleanup.resolve()
          SessionManager.signalAbort(session.id)
          await running
          await abandoning
          cancelChildren.mockRestore()
          schedule.mockRestore()
        }
      },
    })
  })
  test("release cannot schedule queued work while user-stop repair is still pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Stop before next task" })
        const item = await SessionInbox.enqueueUser({
          sessionID: session.id,
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          parts: [{ type: "text", text: "Wait for continue" }],
        })
        const started = Promise.withResolvers<void>()
        const repairing = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<void>()
        const cancelChildren = spyOn(SessionCortexRuntime, "cancelAllForParent").mockImplementation(async () => {
          repairing.resolve()
          await cleanup.promise
        })
        const schedule = spyOn(SessionManager, "scheduleWake").mockImplementation(() => {})
        const running = SessionManager.run(session.id, async (lease) => {
          started.resolve()
          if (!lease.signal.aborted) {
            await new Promise<void>((resolve) =>
              lease.signal.addEventListener("abort", () => resolve(), { once: true }),
            )
          }
        })
        let stopping: ReturnType<typeof SessionAbort.abort> | undefined
        try {
          await started.promise
          stopping = SessionAbort.abort(session.id)
          await repairing.promise
          await running
          expect(schedule).not.toHaveBeenCalled()
          expect((await SessionInbox.list(session.id)).map((entry) => entry.id)).toContain(item.id)
          cleanup.resolve()
          expect((await stopping).paused).toBe(true)
        } finally {
          cleanup.resolve()
          SessionManager.signalAbort(session.id)
          await running
          await stopping
          cancelChildren.mockRestore()
          schedule.mockRestore()
        }
      },
    })
  })

  test("a user stop pauses the session and reports it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "User stop" })
        await createInterruptedTurn(session.id)

        const result = await SessionAbort.abort(session.id)

        expect(result.paused).toBe(true)
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("aborted")
      },
    })
  })

  test("a user stop keeps the breakpoint resumable instead of terminalizing it", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Resumable" })
        await createInterruptedTurn(session.id)

        await SessionAbort.abort(session.id)

        // Terminalizing here would set finish:"error", which makes
        // needsModelCall false — Continue would then be a silent no-op, which
        // is the single worst failure mode of this design. The message must
        // stay non-terminal so the interrupted turn is still resumable.
        const assistant = await latestAssistant(session.id)
        expect(assistant).toBeDefined()
        expect(SessionProgress.isTerminalAssistant(assistant!)).toBe(false)
        expect(assistant!.time.completed).toBeUndefined()
      },
    })
  })

  test("an internal cancellation settles the turn without pausing", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Internal cancel" })
        await createInterruptedTurn(session.id)
        await SessionLifecycle.clear(session.id)

        // Lattice and Light Loop withdraw work they own. "Cancelled" is not
        // "the user asked this session to hold still", so no latch is written —
        // otherwise cancelling a workflow would demand a manual continue.
        const state = await SessionAbort.abort(session.id, { internalCancel: true })

        expect(state.paused).toBe(false)
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
      },
    })
  })

  test("an abort on an already-paused session does not rewrite the reason", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Already paused" })
        await createInterruptedTurn(session.id)
        await SessionLifecycle.pause({ sessionID: session.id, reason: "failed" })
        const before = await SessionLifecycle.snapshot(session.id)

        const result = await SessionAbort.abort(session.id)

        // The latch already records why the session stopped; a later abort
        // describes the same stoppage and must not churn `since`.
        expect(result.paused).toBe(true)
        const after = await SessionLifecycle.snapshot(session.id)
        expect(after?.reason).toBe("failed")
        expect(after?.since).toBe(before?.since)
      },
    })
  })
})
