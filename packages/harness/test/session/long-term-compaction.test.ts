import { expect, spyOn, test } from "bun:test"
import { APICallError, simulateReadableStream } from "ai"
import type { LanguageModelV4, LanguageModelV4StreamPart, ProviderV4 } from "@ai-sdk/provider"
import { FeatureSelection } from "@ericsanchezok/synergy-util/features"
import { Identifier } from "../../src/id/id"
import { Features } from "../../src/lifecycle/features"
import { Provider } from "../../src/provider/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { createUserMessage } from "../../src/session/input"
import { SessionInvoke } from "../../src/session/invoke"
import type { MessageV2 } from "../../src/session/message-v2"
import { RuntimeAdvisory } from "../../src/session/runtime-context"
import { SessionLongTermMemory } from "../../src/session/long-term-memory"
import { PartContent } from "../../src/session/part-content"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import {
  StorageCommitUnknownError,
  StorageIntegrityError,
  StorageOwnershipError,
  StorageUnavailableError,
} from "../../src/storage/errors"
import { testRuntime } from "../support/runtime"

const LONG_TEXT = "# Session history\n\nTopic A selected P because Q lacked requirement K.\n"
const SHORT_TEXT = "Recent topic C is ready for the next discussion."

type Request = {
  model: string
  prompt: Parameters<LanguageModelV4["doStream"]>[0]["prompt"]
  toolChoice: Parameters<LanguageModelV4["doStream"]>[0]["toolChoice"]
  signal?: AbortSignal
}

async function fixture(
  options: {
    enabled?: boolean
    codex?: boolean
    prune?: boolean
    onRequest?: (request: Request) => void | Promise<void>
  } = {},
) {
  const requests: Request[] = []
  const makeModel = (modelId: string): LanguageModelV4 => ({
    specificationVersion: "v4",
    provider: "fixture",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Unexpected non-streaming call")
    },
    async doStream(input) {
      const request = {
        model: modelId,
        prompt: structuredClone(input.prompt),
        toolChoice: input.toolChoice,
        signal: input.abortSignal,
      }
      requests.push(request)
      await options.onRequest?.(request)
      const value = modelId === "memory" ? LONG_TEXT : SHORT_TEXT
      const chunks: LanguageModelV4StreamPart[] = [
        { type: "text-start", id: "reply" },
        { type: "text-delta", id: "reply", delta: value },
        { type: "text-end", id: "reply" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
        },
      ]
      return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }
    },
  })
  const sdk: ProviderV4 & { responses(id: string): LanguageModelV4 } = {
    specificationVersion: "v4",
    languageModel: makeModel,
    responses: makeModel,
    embeddingModel() {
      throw new Error("Unexpected embedding call")
    },
    imageModel() {
      throw new Error("Unexpected image call")
    },
  }
  const model = {
    name: "Fixture",
    release_date: "2026-10-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    limit: { context: 65_536, output: 8_192 },
  }
  const runtime = await testRuntime({
    env: {
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "fixture/main",
        nano_model: "fixture/auxiliary",
        mini_model: "fixture/auxiliary",
        long_context_model: "fixture/short",
        compaction: { prune: options.prune ?? false, codexRemote: false },
        provider: {
          fixture: {
            ...(options.codex ? { profile: "openai-codex" } : {}),
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
            models: {
              main: { ...model, id: "main" },
              short: { ...model, id: "short" },
              memory: { ...model, id: "memory" },
              auxiliary: { ...model, id: "auxiliary" },
            },
          },
        },
        agent: {
          fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Continue the synthetic conversation." },
          "session-long-term-memory": { model: "fixture/memory" },
        },
      }),
    },
    register() {
      Features.register(
        FeatureSelection.resolve(
          [
            {
              id: "fixture",
              version: "1.0.0",
              features: {
                kind: "foundation",
                definitions: [
                  {
                    id: "session-long-term-memory",
                    owner: "fixture",
                    name: "Session long-term summary",
                    description: "Maintain a Session-owned long-term summary independently of compaction.",
                    maturity: "experimental",
                    activation: "live",
                  },
                ],
              },
            },
          ],
          { optIn: options.enabled === false ? [] : ["session-long-term-memory"] },
        ),
      )
      ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
    },
  })
  return {
    requests,
    run<T>(fn: () => Promise<T>) {
      return runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))
    },
    async [Symbol.asyncDispose]() {
      await runtime.close()
    },
  }
}

async function compact(options: { loop?: boolean; signal?: AbortSignal; trailingAdvisory?: boolean } = {}) {
  const session = await Session.create({ workspace: null, title: "Session summary integration" })
  const previous = await createUserMessage({
    sessionID: session.id,
    messageID: Identifier.ascending("message"),
    agent: "fixture",
    model: { providerID: "fixture", modelID: "main" },
    parts: [
      {
        type: "text",
        text: `Topic A evidence: ${"P was selected rather than Q because requirement K was missing. ".repeat(300)}`,
      },
    ],
  })
  const now = Date.now()
  const reply = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID: session.id,
    role: "assistant",
    rootID: previous.info.id,
    parentID: previous.info.id,
    agent: "fixture",
    mode: "fixture",
    modelID: "main",
    providerID: "fixture",
    path: { cwd: null, root: null },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    time: { created: now, completed: now },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: reply.id,
    type: "text",
    text: "Topic A completed with decision P.",
  })
  const root = await createUserMessage({
    sessionID: session.id,
    messageID: Identifier.ascending("message"),
    agent: "fixture",
    model: { providerID: "fixture", modelID: "main" },
    parts: [{ type: "text", text: "Continue discussing topic C." }],
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: root.info.id,
    type: "compaction",
    auto: options.loop ?? false,
  })
  if (options.trailingAdvisory) {
    const observation = RuntimeAdvisory.prepare({
      scope: session.id,
      sources: [RuntimeAdvisory.present("fixture-control", "Latest runtime observation, not conversation evidence.")],
      previous: [],
    })!
    const message = RuntimeAdvisory.message({
      id: Identifier.ascending("message"),
      partID: Identifier.ascending("part"),
      created: root.info.time.created + 1,
      root: root.info as MessageV2.User,
      observation,
    })
    await Session.updateMessage(message.info)
    for (const part of message.parts) await Session.updatePart(part)
  }
  if (options.loop) {
    await SessionInvoke.loop(session.id)
  } else {
    await SessionCompaction.process({
      sessionID: session.id,
      parentID: root.info.id,
      messages: await Session.messages({ sessionID: session.id }),
      auto: false,
      abort: options.signal ?? new AbortController().signal,
    })
  }
  return session.id
}

test("compaction maintains independent long and short Markdown summaries for one Session", async () => {
  await using current = await fixture()
  await current.run(async () => {
    const sessionID = await compact()
    expect(current.requests.filter((request) => request.model === "short")).toHaveLength(1)
    expect(current.requests.filter((request) => request.model === "memory")).toHaveLength(1)
    expect(await Session.get(sessionID)).toMatchObject({ longTermMemory: { markdown: LONG_TEXT, revision: 1 } })
    const summaries = (await Session.messages({ sessionID })).filter(
      (message) => message.info.role === "assistant" && message.info.summary,
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0].parts.some((part) => part.type === "text" && part.text.includes(SHORT_TEXT))).toBe(true)
  })
}, 30_000)

test("a trailing runtime observation cannot become the L evidence cursor", async () => {
  await using current = await fixture()
  await current.run(async () => {
    const sessionID = await compact({ trailingAdvisory: true })
    expect(current.requests.filter((request) => request.model === "memory")).toHaveLength(1)
    expect((await Session.get(sessionID)).longTermMemory?.markdown).toBe(LONG_TEXT)
  })
}, 30_000)

for (const changedPrefix of [false, true]) {
  test(
    changedPrefix
      ? "ordinary replay pruning cannot bless an actual earlier evidence edit"
      : "ordinary replay pruning preserves L progress without rereviewing old evidence",
    async () => {
      await using current = await fixture({ prune: true })
      await current.run(async () => {
        const session = await Session.create({ workspace: null, title: "Pruning and original evidence" })
        const root = async (text: string) =>
          createUserMessage({
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
            agent: "fixture",
            model: { providerID: "fixture", modelID: "main" },
            parts: [{ type: "text", text }],
          })
        const previous = await root(`ARCHIVED_ONLY_A ${"Original decision evidence. ".repeat(600)}`)
        const now = Date.now()
        const reply = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          rootID: previous.info.id,
          parentID: previous.info.id,
          agent: "fixture",
          mode: "fixture",
          modelID: "main",
          providerID: "fixture",
          path: { cwd: null, root: null },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: now, completed: now },
        })
        for (const sequence of [0, 1, 2, 3, 4, 5, 6, 7]) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: reply.id,
            type: "tool",
            callID: `prior-observation-${sequence}`,
            tool: "fixture_tool",
            state: {
              status: "completed",
              input: {},
              title: "Original observation",
              output: "Original evidence confirmed decision P. ".repeat(1_000),
              metadata: {},
              time: { start: now, end: now },
            },
          })
        }
        await root("Discuss unrelated topic B.")
        const latest = await root("Finish unrelated topic C.")
        const fallbackModel = await Provider.getModel("fixture", "memory")
        const signal = new AbortController().signal
        await SessionLongTermMemory.update({ sessionID: session.id, user: latest.info, fallbackModel, signal })
        const before = (await Session.get(session.id)).longTermMemory
        if (changedPrefix) {
          await Session.updatePart({
            id: previous.parts[0].id,
            sessionID: session.id,
            messageID: previous.info.id,
            type: "text",
            text: "CHANGED_PREFIX_E supersedes the earlier evidence.",
          })
        }
        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(4)
        expect(messages.filter((message) => message.info.role === "user" && message.info.isRoot)).toHaveLength(3)
        const selected = SessionCompaction.selectPartsToPrune(messages)
        expect(selected.length).toBeGreaterThan(0)
        const snapshot = structuredClone(messages)
        const requestCount = current.requests.length
        const read = PartContent.read
        const guard = spyOn(PartContent, "read").mockImplementation(async (key) => {
          if (!changedPrefix && key.at(-1) === previous.parts[0].id)
            throw new Error("Previously reviewed body was hydrated again")
          return read(key)
        })
        try {
          const history = spyOn(Session, "messages").mockRejectedValue(new Error("Prune reread full history"))
          const pruned = await SessionCompaction.prune({ sessionID: session.id, messages }).finally(() =>
            history.mockRestore(),
          )
          expect(pruned.map((part) => part.id)).toEqual(selected.map((part) => part.id))
          expect(messages).toEqual(snapshot)
          const next = await root("NEW_EVIDENCE_D is now available.")
          await SessionLongTermMemory.update({ sessionID: session.id, user: next.info, fallbackModel, signal })
          expect((await Session.get(session.id)).longTermMemory).toEqual(before)
          const requests = current.requests.slice(requestCount).filter((request) => request.model === "memory")
          expect(requests).toHaveLength(1)
          const prompt = JSON.stringify(requests[0].prompt)
          expect(prompt).toContain("NEW_EVIDENCE_D")
          expect(prompt).not.toContain("ARCHIVED_ONLY_A")
          if (changedPrefix) {
            expect(prompt).toContain("CHANGED_PREFIX_E")
            expect(prompt).not.toContain("Topic A selected P because Q lacked requirement K.")
          }
        } finally {
          guard.mockRestore()
        }
      })
    },
    30_000,
  )
}

test("recording failures keep priority when the other summary has a hard storage failure", async () => {
  await using current = await fixture()
  await current.run(async () => {
    const storage = new StorageIntegrityError("Synthetic short-summary storage failure")
    const recording = new RolloutRecordingError({ message: "Synthetic long-summary recording failure" })
    const writeMessage = Session.updateMessage
    const short = spyOn(Session, "updateMessage").mockImplementation(
      Object.assign(
        async (info: MessageV2.Info) => {
          if (info.role === "assistant" && info.mode === "compaction") throw storage
          return writeMessage(info)
        },
        { force: writeMessage.force, schema: writeMessage.schema },
      ),
    )
    const long = spyOn(SessionLongTermMemory, "update").mockRejectedValue(recording)
    try {
      await expect(compact()).rejects.toBe(recording)
    } finally {
      long.mockRestore()
      short.mockRestore()
    }
  })
}, 30_000)

test("an unselected experiment preserves the existing S-only compaction", async () => {
  await using current = await fixture({ enabled: false })
  await current.run(async () => {
    const sessionID = await compact()
    expect(current.requests.map((request) => request.model)).toEqual(["short"])
    expect((await Session.get(sessionID)).longTermMemory).toBeUndefined()
  })
}, 30_000)

test("disabled L does not add a cleared source to Codex prompt history", async () => {
  await using current = await fixture({ enabled: false, codex: true })
  await current.run(async () => {
    await compact({ loop: true })
    expect(current.requests.filter((request) => request.model === "memory")).toHaveLength(0)
    for (const request of current.requests) {
      expect(JSON.stringify(request.prompt)).not.toContain('id=\\"session-long-term-memory\\"')
    }
  })
}, 30_000)

test("L and S both start before either model response is released", async () => {
  const started = new Set<string>()
  const bothStarted = Promise.withResolvers<void>()
  await using current = await fixture({
    async onRequest(request) {
      started.add(request.model)
      if (started.has("memory") && started.has("short")) bothStarted.resolve()
      await bothStarted.promise
    },
  })
  const timeout = setTimeout(() => bothStarted.reject(new Error("L and S did not overlap")), 5_000)
  try {
    await current.run(async () => {
      const sessionID = await compact()
      expect(started).toEqual(new Set(["memory", "short"]))
      expect(current.requests).toHaveLength(2)
      expect((await Session.get(sessionID)).longTermMemory?.markdown).toBe(LONG_TEXT)
    })
  } finally {
    clearTimeout(timeout)
  }
}, 30_000)

test("retrying L after a network failure does not rerun successful S", async () => {
  let memoryAttempts = 0
  await using current = await fixture({
    onRequest(request) {
      if (request.model !== "memory" || ++memoryAttempts !== 1) return
      throw new APICallError({
        message: "Synthetic temporary network failure",
        url: "https://fixture.invalid/v1/responses",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: { "retry-after-ms": "1" },
        isRetryable: true,
      })
    },
  })
  await current.run(async () => {
    const sessionID = await compact()
    expect(current.requests.filter((request) => request.model === "short")).toHaveLength(1)
    expect(memoryAttempts).toBe(2)
    expect((await Session.get(sessionID)).longTermMemory?.markdown).toBe(LONG_TEXT)
  })
}, 30_000)

test("cancelling compaction stops and settles both summary calls", async () => {
  const cancellation = new AbortController()
  const ready = Promise.withResolvers<void>()
  const active: Request[] = []
  await using current = await fixture({
    async onRequest(request) {
      active.push(request)
      if (active.length === 2) ready.resolve()
      await new Promise<void>((_resolve, reject) => {
        const signal = request.signal!
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
  })
  await current.run(async () => {
    const stopped = compact({ signal: cancellation.signal }).catch((error: unknown) => error)
    const timeout = setTimeout(() => ready.reject(new Error("Both summary calls did not start")), 5_000)
    try {
      await ready.promise
      cancellation.abort(new DOMException("Synthetic user stop", "AbortError"))
      expect(await stopped).toBeInstanceOf(DOMException)
      expect(active.map((request) => request.model).sort()).toEqual(["memory", "short"])
      expect(active.every((request) => request.signal?.aborted)).toBe(true)
    } finally {
      clearTimeout(timeout)
      cancellation.abort()
      await stopped
    }
  })
}, 30_000)

test("live disabling preserves the current invoke choice and applies to the next invoke", async () => {
  await using current = await fixture({
    onRequest(request) {
      if (request.model === "memory") Features.reload([])
    },
  })
  await current.run(async () => {
    const sessionID = await compact({ loop: true })
    expect(Features.enabled("session-long-term-memory")).toBe(false)
    const first = current.requests.find((request) => request.model === "main" && request.toolChoice?.type !== "none")
    expect(JSON.stringify(first?.prompt)).toContain("<session-long-term-memory>")
    const count = current.requests.length
    await SessionInvoke.invoke({
      sessionID,
      agent: "fixture",
      parts: [{ type: "text", text: "Now discuss the independent topic D." }],
    })
    const next = current.requests.slice(count).find((request) => request.model === "main")
    expect(next).toBeDefined()
    expect(JSON.stringify(next?.prompt)).not.toContain("<session-long-term-memory>")
    expect((await Session.get(sessionID)).longTermMemory?.markdown).toBe(LONG_TEXT)
  })
}, 30_000)

test("an L failure does not discard a successful S commit", async () => {
  await using current = await fixture({
    onRequest(request) {
      if (request.model !== "memory") return
      throw new APICallError({
        message: "Synthetic permanent L failure",
        url: "https://fixture.invalid/v1/responses",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      })
    },
  })
  await current.run(async () => {
    const sessionID = await compact()
    expect((await Session.get(sessionID)).longTermMemory).toBeUndefined()
    expect(current.requests.filter((request) => request.model === "short")).toHaveLength(1)
    expect(
      (await Session.messages({ sessionID })).some(
        (message) => message.info.role === "assistant" && message.info.summary,
      ),
    ).toBe(true)
  })
}, 30_000)

for (const mode of ["direct", "invoke"] as const) {
  test.each([
    ["integrity", new StorageIntegrityError("Synthetic integrity failure")],
    ["ownership", new StorageOwnershipError("Synthetic ownership failure")],
    ["unavailable store", new StorageUnavailableError("Synthetic unavailable store")],
    ["unknown commit", new StorageCommitUnknownError("synthetic-operation", new Error("Synthetic lost commit reply"))],
    [
      "wrapped integrity",
      new Error("Synthetic model wrapper", { cause: new StorageIntegrityError("Synthetic integrity cause") }),
    ],
  ] as const)(
    `hard L %s failure propagates after S commits (${mode})`,
    async (_label, failure) => {
      await using current = await fixture()
      await current.run(async () => {
        let sessionID = ""
        using update = spyOn(SessionLongTermMemory, "update").mockImplementation(async (input) => {
          sessionID = input.sessionID
          throw failure
        })
        await expect(compact({ loop: mode === "invoke" })).rejects.toBe(failure)
        expect(
          (await Session.messages({ sessionID })).some(
            (message) => message.info.role === "assistant" && message.info.summary,
          ),
        ).toBe(true)
        expect(
          current.requests.filter((request) => request.model === "main" && request.toolChoice?.type !== "none"),
        ).toHaveLength(0)
      })
    },
    30_000,
  )
}

test("an S failure does not discard a successful L commit", async () => {
  await using current = await fixture({
    onRequest(request) {
      if (request.model !== "short") return
      throw new APICallError({
        message: "Synthetic permanent S failure",
        url: "https://fixture.invalid/v1/responses",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      })
    },
  })
  await current.run(async () => {
    const sessionID = await compact()
    expect((await Session.get(sessionID)).longTermMemory?.markdown).toBe(LONG_TEXT)
    expect(current.requests.filter((request) => request.model === "memory")).toHaveLength(1)
    expect(
      (await Session.messages({ sessionID })).some(
        (message) => message.info.role === "assistant" && message.info.summary,
      ),
    ).toBe(false)
  })
}, 30_000)

test.each(["compatible", "codex"] as const)(
  "the same root sees newly committed L after compaction (%s)",
  async (profile) => {
    await using current = await fixture({ codex: profile === "codex" })
    await current.run(async () => {
      await compact({ loop: true })
      const primary = current.requests.filter(
        (request) => request.model === "main" && request.toolChoice?.type !== "none",
      )
      expect(
        current.requests.filter((request) => request.model === "main" && request.toolChoice?.type === "none"),
      ).toHaveLength(1)
      expect(primary).toHaveLength(1)
      const text = primary[0].prompt
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        )
        .join("\n")
      expect(text).toContain(LONG_TEXT)
      expect(text).toContain("Continue discussing topic C.")
      expect(current.requests.filter((request) => request.model === "memory")).toHaveLength(1)
    })
  },
  30_000,
)
