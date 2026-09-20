import { describe, expect, test } from "bun:test"
import { tmpdir } from "../support/fixture"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionAbort } from "../../src/session/abort"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionProgress } from "../../src/session/progress"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionHistory } from "../../src/session/history"

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
        expect(result.paused).toBe(false)
        const after = await SessionLifecycle.snapshot(session.id)
        expect(after?.reason).toBe("failed")
        expect(after?.since).toBe(before?.since)
      },
    })
  })
})
