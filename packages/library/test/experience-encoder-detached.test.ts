import { afterEach, expect, spyOn, test } from "bun:test"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { AgentCall } from "@ericsanchezok/synergy-harness/agent/call"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionContextContributions } from "@ericsanchezok/synergy-harness/session/context-contributions"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLibrarySessionRecall } from "../src/session-recall"
import { Embedding } from "../src/vector/embedding"
import { LibraryDB } from "../src/database"

const mocks: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

function fakeVector() {
  return Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0))
}

interface FixtureContext {
  sessionID: string
  userMessageID: string
  assistant: MessageV2.Assistant
}

async function fixture(config: object, run: (ctx: FixtureContext) => Promise<void>) {
  await using tmp = await tmpdir({ config })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ title: "Research" })
      const user = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        isRoot: true,
        time: { created: Date.now() },
        agent: "synergy",
        model: { providerID: "test", modelID: "test" },
      })
      if (user.role !== "user") throw new Error("expected user")
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: user.id,
        sessionID: session.id,
        type: "text",
        text: "Investigate why the sidebar keeps showing the session as running.",
      })
      const assistant = await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        parentID: user.id,
        rootID: user.id,
        visible: true,
        finish: "stop",
        agent: "synergy",
        mode: "synergy",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test",
        providerID: "test",
        path: { cwd: "/tmp/research", root: "/tmp/research" },
        time: { created: Date.now(), completed: Date.now() },
      })
      if (assistant.role !== "assistant") throw new Error("expected assistant")
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: assistant.id,
        sessionID: session.id,
        type: "text",
        text: "The turn finished streaming its final answer.",
      })
      registerLibrarySessionRecall()
      try {
        await run({ sessionID: session.id, userMessageID: user.id, assistant: assistant as MessageV2.Assistant })
      } finally {
        LoopJob.cancelDetached(session.id)
        await LoopJob.settleDetached(session.id)
      }
    },
  })
}

test("completion callback returns before encoding finishes; settleDetached captures it", async () => {
  const encodeStarted = Promise.withResolvers<void>()
  const releaseEncode = Promise.withResolvers<void>()
  mocks.push(
    spyOn(Provider, "getModel").mockResolvedValue({ providerID: "test", id: "test" } as never),
    spyOn(Embedding, "generate").mockImplementation(async (input: { id: string }) => ({
      id: input.id,
      vector: fakeVector(),
      model: "test-model",
    })),
    spyOn(AgentCall, "text").mockImplementation(async () => {
      encodeStarted.resolve()
      await releaseEncode.promise
      return { text: "Investigate sidebar running state after completion" } as never
    }),
  )
  await fixture({}, async (ctx) => {
    expect(LibraryDB.Experience.get(ctx.userMessageID)).toBeNull()
    const completion = SessionContextContributions.onAssistantComplete(ctx.assistant)
    // The hook must not hold the turn on encoding: it resolves while the
    // encode is still blocked on its model call.
    const resolved = await Promise.race([completion.then(() => true), Bun.sleep(500).then(() => false)])
    expect(resolved).toBe(true)
    await Promise.race([
      encodeStarted.promise,
      Bun.sleep(5_000).then(() => {
        throw new Error("detached encode did not start")
      }),
    ])
    expect(LibraryDB.Experience.get(ctx.userMessageID)).toBeNull()
    releaseEncode.resolve()
    await LoopJob.settleDetached(ctx.sessionID)
    expect(LibraryDB.Experience.get(ctx.userMessageID)?.id).toBe(ctx.userMessageID)
  })
}, 30_000)

test("non-abort assistant failures skip encoding entirely", async () => {
  const text = spyOn(AgentCall, "text").mockImplementation(
    async () =>
      ({
        text: "Investigate sidebar running state after completion",
      }) as never,
  )
  mocks.push(text)
  await fixture({}, async (ctx) => {
    const failed = {
      ...ctx.assistant,
      error: { name: "APIError", data: { message: "rate limited" } },
    } as MessageV2.Assistant
    await SessionContextContributions.onAssistantComplete(failed)
    await LoopJob.settleDetached(ctx.sessionID)
    expect(text).not.toHaveBeenCalled()
    expect(LibraryDB.Experience.get(ctx.userMessageID)).toBeNull()
  })
})

test("disabled experience encoding never reaches the model", async () => {
  const text = spyOn(AgentCall, "text").mockImplementation(
    async () =>
      ({
        text: "Investigate sidebar running state after completion",
      }) as never,
  )
  mocks.push(text)
  await fixture({ library: { experience: { encode: false } } }, async (ctx) => {
    await SessionContextContributions.onAssistantComplete(ctx.assistant)
    await LoopJob.settleDetached(ctx.sessionID)
    expect(text).not.toHaveBeenCalled()
    expect(LibraryDB.Experience.get(ctx.userMessageID)).toBeNull()
  })
})
