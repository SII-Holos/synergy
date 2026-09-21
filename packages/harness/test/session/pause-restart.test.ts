import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionDrive } from "../../src/session/drive"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionManager } from "../../src/session/manager"
import { SessionHistory } from "../../src/session/history"
import { resolve as resolveWorking, toStatus } from "../../src/session/working"

/** A reply-required root with no terminal assistant: the persisted shape of a
 *  turn that stopped mid-work. */
async function createInterruptedTurn(sessionID: string, rootMessageID: string) {
  await Session.updateMessage({
    id: rootMessageID,
    sessionID,
    role: "user",
    isRoot: true,
    agent: "test",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: rootMessageID,
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

describe("a paused session is visible and inert without a live runtime", () => {
  test.each([false, true])(
    "startup settles orphaned tools without terminalizing the breakpoint (paused=%s)",
    async (paused) => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({})
          await createInterruptedTurn(session.id, Identifier.ascending("message"))
          const assistant = (await SessionHistory.modelMessages({ sessionID: session.id })).at(-1)!
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: assistant.info.id,
            type: "tool",
            callID: "interrupted-tool",
            tool: "bash",
            state: { status: "running", input: { command: "sleep 120" }, time: { start: Date.now() } },
          })
          if (paused) await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
          const original = await SessionLifecycle.snapshot(session.id)
          await SessionInvoke.reconcilePausedSessions(session.scope.id)
          const messages = await SessionHistory.modelMessages({ sessionID: session.id })
          const repaired = messages.find((message) => message.info.id === assistant.info.id)!
          expect(repaired.parts.find((part) => part.type === "tool")?.state.status).toBe("error")
          if (repaired.info.role !== "assistant") throw new Error("Expected an assistant breakpoint")
          expect(repaired.info.time.completed).toBeUndefined()
          expect(SessionManager.isRunning(session.id)).toBe(false)
          const latch = await SessionLifecycle.snapshot(session.id)
          if (original) expect(latch).toEqual(original)
          await SessionInvoke.reconcilePausedSessions(session.scope.id)
          expect(await SessionLifecycle.snapshot(session.id)).toEqual(latch)
        },
      })
    },
  )
  test("startup reconciliation records the latch and drives nothing", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Interrupted by a dead process" })
        await createInterruptedTurn(session.id, Identifier.ascending("message"))

        // The real startup entry, not a re-implementation of it: this is what a
        // restart runs.
        await SessionInvoke.reconcilePausedSessions(scope.id)

        const latch = await SessionLifecycle.snapshot(session.id)
        expect(latch?.reason).toBe("interrupted")
        // The whole point of deleting automatic recovery: startup records the
        // state and stops there. Nothing was resumed on the user's behalf.
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })

  test("the pause survives with no runtime registered and refuses to be driven", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Restart survivor" })
        await createInterruptedTurn(session.id, Identifier.ascending("message"))
        await SessionInvoke.reconcilePausedSessions(scope.id)

        // After a restart there is no loop driving this session, which is the
        // state under test. An idle runtime object may exist while the session
        // is open, so ownership — not the object's presence — is the signal.
        // The status must still resolve from the persisted latch, or the user
        // would see an idle session with work stopped inside it and no control
        // to resume.
        expect(SessionManager.isRunning(session.id)).toBe(false)

        const working = await resolveWorking(session.id)
        expect(working?.status).toBe("paused")
        if (working?.status === "paused") expect(working.reason).toBe("interrupted")

        // The cross-scope recovery scan reads storage rather than runtimes, so
        // this is the path by which every other client learns about the pause.
        const statuses = await SessionManager.listStatuses(scope.id)
        expect(statuses[session.id]?.type).toBe("paused")
        expect(toStatus(working!).type).toBe("paused")

        // An automatic wake must not restart the work the user has not asked to
        // resume — even though the turn is genuinely unfinished.
        try {
          expect(await SessionDrive.request(session.id, "restart-probe")).toBe(false)
        } finally {
          SessionDrive.reset()
        }
        expect(SessionManager.isRunning(session.id)).toBe(false)
      },
    })
  })

  test("continue resumes the interrupted turn, and abandon ends it", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({ title: "Explicit exits" })
        await createInterruptedTurn(session.id, Identifier.ascending("message"))

        await SessionLifecycle.pause({ sessionID: session.id, reason: "aborted" })
        expect(await SessionLifecycle.snapshot(session.id)).toBeDefined()

        // Abandon is the terminal exit: it clears the latch and leaves a
        // terminal message, so the session no longer claims unfinished work.
        const state = await SessionInvoke.repairAbortState(session.id, {
          terminalize: true,
          pauseReason: "aborted",
        })
        expect(state.abandoned || state.repaired).toBe(true)
        await SessionLifecycle.clear(session.id)
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
        expect(await SessionLifecycle.listUnfinishedSessions(scope.id)).not.toContain(session.id)
      },
    })
  })
})
