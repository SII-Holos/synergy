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
import { ExperienceRecall } from "../src/experience-recall"
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

test("root-scoped cancellation reaches encoding when the assistant parent differs", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  mocks.push(
    spyOn(Provider, "getModel").mockResolvedValue({ providerID: "test", id: "test" } as never),
    spyOn(AgentCall, "text").mockImplementation(async (input) => {
      if (!input.signal) throw new Error("missing encode signal")
      started.resolve(input.signal)
      await release.promise
      input.signal.throwIfAborted()
      throw new Error("expected root cancellation")
    }),
  )
  await fixture({}, async (ctx) => {
    const rootID = Identifier.ascending("message")
    try {
      await SessionContextContributions.onAssistantComplete({ ...ctx.assistant, rootID })
      const signal = await started.promise
      LoopJob.cancelDetached(ctx.sessionID, new Set([rootID]))
      expect(signal.aborted).toBe(true)
      release.resolve()
      await LoopJob.settleDetached(ctx.sessionID, new Set([rootID]))
    } finally {
      release.resolve()
    }
  })
}, 30_000)

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

test("retrieval attribution is captured at schedule time, not consume time", async () => {
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
    // Turn 1's recall context was accepted for injection before completion.
    ExperienceRecall.trackRetrieval(ctx.sessionID, ["exp-first-turn"])
    await SessionContextContributions.onAssistantComplete(ctx.assistant)
    await encodeStarted.promise
    // Turn 2 starts while turn 1's detached encode is still queued on its
    // model call and tracks its own retrieval over the session-keyed entry.
    ExperienceRecall.trackRetrieval(ctx.sessionID, ["exp-second-turn"])
    releaseEncode.resolve()
    await LoopJob.settleDetached(ctx.sessionID)

    const row = LibraryDB.Experience.get(ctx.userMessageID)
    expect(row).not.toBeNull()
    expect(JSON.parse(row!.retrieved_experience_ids)).toEqual(["exp-first-turn"])
    // Turn 2's pending attribution must survive turn 1's late consume.
    expect(ExperienceRecall.consumeRetrieval(ctx.sessionID)).toEqual(["exp-second-turn"])
  })
}, 30_000)

test("cancelled encode does not launch retry or reward model calls", async () => {
  const encodeStarted = Promise.withResolvers<void>()
  const releaseEncode = Promise.withResolvers<void>()
  let calls = 0
  let cancelled = false
  mocks.push(
    spyOn(Provider, "getModel").mockResolvedValue({ providerID: "test", id: "test" } as never),
    spyOn(Embedding, "generate").mockImplementation(async (input: { id: string }) => ({
      id: input.id,
      vector: fakeVector(),
      model: "test-model",
    })),
    spyOn(AgentCall, "text").mockImplementation(async () => {
      calls++
      if (calls === 1) {
        encodeStarted.resolve()
        await releaseEncode.promise
        if (cancelled) throw new Error("simulated cancellation")
      }
      return { text: "Investigate sidebar running state after completion" } as never
    }),
  )
  await fixture({}, async (ctx) => {
    const session = await Session.get(ctx.sessionID)
    const scopeID = (session as { scope: { id: string } }).scope.id
    LibraryDB.Experience.insertFailed({
      id: "msg-failed-seed",
      sessionID: ctx.sessionID,
      scopeID,
      createdAt: Date.now(),
    })
    await SessionContextContributions.onAssistantComplete(ctx.assistant)
    await encodeStarted.promise
    LoopJob.cancelDetached(ctx.sessionID)
    cancelled = true
    releaseEncode.resolve()
    await LoopJob.settleDetached(ctx.sessionID)
    // Only the cancelled turn's own intent call may have run: the retry pass
    // over the seeded failed encoding must never reach the model.
    expect(calls).toBe(1)
  })
}, 30_000)

test("an encode queued behind a held session lock is cancelled without running", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let calls = 0
  mocks.push(
    spyOn(Provider, "getModel").mockResolvedValue({ providerID: "test", id: "test" } as never),
    spyOn(Embedding, "generate").mockImplementation(async (input: { id: string }) => ({
      id: input.id,
      vector: fakeVector(),
      model: "test-model",
    })),
    spyOn(AgentCall, "text").mockImplementation(async () => {
      calls++
      if (calls === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
        throw new Error("simulated cancellation")
      }
      return { text: "Investigate sidebar running state after completion" } as never
    }),
  )
  await fixture({}, async (ctx) => {
    const secondUser = await Session.updateMessage({
      id: Identifier.ascending("message"),
      sessionID: ctx.sessionID,
      role: "user",
      isRoot: true,
      time: { created: Date.now() },
      agent: "synergy",
      model: { providerID: "test", modelID: "test" },
    })
    if (secondUser.role !== "user") throw new Error("expected user")
    const secondAssistant = await Session.updateMessage({
      id: Identifier.ascending("message"),
      sessionID: ctx.sessionID,
      role: "assistant",
      parentID: secondUser.id,
      rootID: secondUser.id,
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
    if (secondAssistant.role !== "assistant") throw new Error("expected assistant")

    await SessionContextContributions.onAssistantComplete(ctx.assistant)
    await firstStarted.promise
    await SessionContextContributions.onAssistantComplete(secondAssistant as MessageV2.Assistant)
    // The second encode is queued on the session lock; cancelling the
    // session must abandon that wait without a model call.
    LoopJob.cancelDetached(ctx.sessionID)
    releaseFirst.resolve()
    await LoopJob.settleDetached(ctx.sessionID)
    expect(calls).toBe(1)
    expect(LibraryDB.Experience.get(secondUser.id)).toBeNull()
  })
}, 30_000)
