import { afterEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { LibraryDB, closeDB } from "../../src/library/database"
import { ExperienceEncoder } from "../../src/library/experience-encoder"
import { ExperienceReencode } from "../../src/library/experience-reencode"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { SessionMemoryPressure } from "../../src/session/memory-pressure"
import type { MessageV2 } from "../../src/session/message-v2"
import { Embedding } from "../../src/vector/embedding"
import { tmpdir } from "../fixture/fixture"

function candidate(id: string) {
  return {
    id,
    sessionID: `session-${id}`,
    scopeID: "scope-reencode",
    reason: "invalid" as const,
    detail: "invalid encoded content",
  }
}

const originalAgentGet = Agent.get
const originalAgentModel = Agent.getAvailableModel
const originalConfigCurrent = Config.current
const originalExperienceGet = LibraryDB.Experience.get
const originalEmbeddingGenerate = Embedding.generate
const originalProviderGetModel = Provider.getModel
const originalSessionGet = Session.get
const originalSessionMessages = Session.messages
const originalMemorySnapshot = SessionMemoryPressure.currentSnapshotWithCgroup
const originalMaybeCollect = SessionMemoryPressure.maybeCollect
const originalStream = LLM.stream

async function waitForTerminalJob(id: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = ExperienceReencode.get(id)
    if (job && job.status !== "running") return job
    await Bun.sleep(10)
  }
  throw new Error(`Experience reencode job ${id} did not finish within ${timeoutMs}ms`)
}

function installReencodeModelMocks(concurrency = 2) {
  ;(Config.current as any) = mock(async () => ({
    library: {
      experience: {
        learning: { reencodeConcurrency: concurrency, reencodeRetries: 0, reencodeRetryBackoffMs: 0 },
      },
    },
  }))
  ;(Agent.get as any) = mock(async (name: string) => ({ name, prompt: name }))
  ;(Agent.getAvailableModel as any) = mock(async () => ({
    providerID: "test-provider",
    modelID: "test-model",
  }))
  ;(Provider.getModel as any) = mock(async () => ({
    id: "test-model",
    providerID: "test-provider",
    modelID: "test-model",
  }))
  ;(Embedding.generate as any) = mock(async (input: { id: string }) => ({
    id: input.id,
    vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    model: "test-embedding",
  }))
  ;(LLM.stream as any) = mock(async (input: { agent: { name: string } }) => {
    const text =
      input.agent.name === "intent"
        ? "Bounded maintenance reencode"
        : "1. Read the stored experience\n2. Rebuild the reusable trajectory\n3. Persist the fresh embedding"
    return {
      textStream: (async function* () {
        yield text
      })(),
      text: Promise.resolve(text),
    }
  })
}

function insertExperience(input: {
  id: string
  sessionID: string
  scopeID: string
  intent?: string
  script?: string
  raw?: string
}) {
  LibraryDB.Experience.insert({
    id: input.id,
    sessionID: input.sessionID,
    scopeID: input.scopeID,
    intent: input.intent ?? "Reusable experience",
    sourceProviderID: "test-provider",
    sourceModelID: "test-model",
    intentEmbedding: {
      id: input.id,
      vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      model: "test-embedding",
    },
    scriptEmbedding: undefined,
    content: { script: input.script, raw: input.raw },
    metadata: {},
    retrievedExperienceIDs: [],
    createdAt: Date.now(),
  })
}

async function createTurn(sessionID: string, userText: string, assistantText: string) {
  const user = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
  })) as MessageV2.User
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID,
    type: "text",
    text: userText,
  })
  const assistant = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: user.id,
    rootID: user.id,
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now(), completed: Date.now() },
    mode: "synergy",
    agent: "synergy",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: assistantText,
  })
  return user
}

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.getAvailableModel as any) = originalAgentModel
  ;(Config.current as any) = originalConfigCurrent
  ;(LibraryDB.Experience.get as any) = originalExperienceGet
  ;(Embedding.generate as any) = originalEmbeddingGenerate
  ;(Provider.getModel as any) = originalProviderGetModel
  ;(Session.get as any) = originalSessionGet
  ;(Session.messages as any) = originalSessionMessages
  ;(SessionMemoryPressure.currentSnapshotWithCgroup as any) = originalMemorySnapshot
  ;(SessionMemoryPressure.maybeCollect as any) = originalMaybeCollect
  ;(LLM.stream as any) = originalStream
  LibraryDB.Experience.removeAll()
  LibraryDB.ReencodeJob.removeAll()
  closeDB()
})

describe.serial("ExperienceReencode persistence", () => {
  test("creates a durable job with ordered pending items", () => {
    const state = ExperienceReencode.createJob({
      type: "intent",
      candidates: [candidate("exp-1"), candidate("exp-2")],
    })

    expect(state).toMatchObject({
      status: "running",
      type: "intent",
      reason: null,
      totalCount: 2,
      completedCount: 0,
      okCount: 0,
      skippedCount: 0,
      failedCount: 0,
      completedAt: null,
    })
    expect(state.items.map((item) => [item.id, item.status])).toEqual([
      ["exp-1", "pending"],
      ["exp-2", "pending"],
    ])

    closeDB()
    expect(ExperienceReencode.current()?.id).toBe(state.id)
  })

  test("rejects a second active job", () => {
    ExperienceReencode.createJob({ type: "intent", candidates: [candidate("exp-1")] })

    expect(() => ExperienceReencode.createJob({ type: "script", candidates: [candidate("exp-2")] })).toThrow(
      "already running",
    )
  })

  test("marks running work interrupted when the database reopens", () => {
    const state = ExperienceReencode.createJob({ type: "intent", candidates: [candidate("exp-1")] })
    LibraryDB.ReencodeJob.markItemProcessing(state.id, "exp-1")

    closeDB()

    const recovered = ExperienceReencode.current()
    expect(recovered?.status).toBe("interrupted")
    expect(recovered?.completedAt).toEqual(expect.any(Number))
    expect(recovered?.items[0]?.status).toBe("pending")
  })

  test("cancellation is durable and leaves unfinished items pending", async () => {
    const state = ExperienceReencode.createJob({
      type: "intent",
      candidates: [candidate("exp-1"), candidate("exp-2")],
    })
    LibraryDB.ReencodeJob.markItemProcessing(state.id, "exp-1")
    LibraryDB.ReencodeJob.finishItem(state.id, "exp-1", "ok")
    LibraryDB.ReencodeJob.finishItem(state.id, "exp-1", "failed", "duplicate completion")
    const afterDuplicate = ExperienceReencode.get(state.id)
    expect(afterDuplicate).toMatchObject({ okCount: 1, skippedCount: 0, failedCount: 0, completedCount: 1 })
    expect(afterDuplicate?.items[0]).toMatchObject({ id: "exp-1", status: "ok" })

    const summary = ExperienceReencode.currentSummary()
    expect(summary).not.toHaveProperty("items")
    expect(summary).toMatchObject({ id: state.id, okCount: 1, completedCount: 1 })

    const cancelled = await ExperienceReencode.cancel(state.id)

    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.completedAt).toEqual(expect.any(Number))
    expect(cancelled.completedCount).toBe(1)
    expect(cancelled).not.toHaveProperty("items")
    expect(ExperienceReencode.get(state.id)?.items.map((item) => item.status)).toEqual(["ok", "pending"])

    closeDB()
    expect(ExperienceReencode.current()?.status).toBe("cancelled")
  })
})

describe.serial("ExperienceReencode repair integration", () => {
  test("repairs an encoding_failed experience through the complete encoder pipeline", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const user = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test-provider", modelID: "test-model" },
        })) as MessageV2.User
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "Repair the failed library experience",
        })

        const assistant = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: user.id,
          rootID: user.id,
          modelID: "test-model",
          providerID: "test-provider",
          time: { created: Date.now(), completed: Date.now() },
          mode: "synergy",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        })) as MessageV2.Assistant
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: session.id,
          type: "text",
          text: "Rebuilt the reusable experience from the completed turn.",
        })

        LibraryDB.Experience.insertFailed({
          id: user.id,
          sessionID: session.id,
          scopeID: scope.id,
          sourceProviderID: "test-provider",
          sourceModelID: "test-model",
          createdAt: user.time.created,
        })
        expect(LibraryDB.Experience.getContent(user.id)).toBeNull()
        ;(Config.current as any) = mock(async () => ({
          library: {
            experience: {
              encode: false,
              learning: { reencodeConcurrency: 1, reencodeRetries: 1, reencodeRetryBackoffMs: 0 },
            },
          },
        }))
        ;(Agent.get as any) = mock(async (name: string) => ({ name, prompt: name }))
        ;(Agent.getAvailableModel as any) = mock(async () => ({
          providerID: "test-provider",
          modelID: "test-model",
        }))
        ;(Provider.getModel as any) = mock(async () => ({
          id: "test-model",
          providerID: "test-provider",
          modelID: "test-model",
        }))
        let embeddingAttempts = 0
        ;(Embedding.generate as any) = mock(async (input: { id: string }) => {
          embeddingAttempts++
          if (embeddingAttempts === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
          return {
            id: input.id,
            vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            model: "test-embedding",
          }
        })
        const llmRetries: number[] = []
        ;(LLM.stream as any) = mock(async (input: { agent: { name: string }; retries: number }) => {
          llmRetries.push(input.retries)
          const text =
            input.agent.name === "intent"
              ? "Repair failed library experience"
              : [
                  "1. Inspect the failed experience and completed conversation turn",
                  "2. Rebuild the reusable intent and trajectory script",
                  "3. Persist the repaired experience with fresh embeddings",
                ].join("\n")
          return {
            textStream: (async function* () {
              yield text
            })(),
            text: Promise.resolve(text),
          }
        })

        let sessionMessageReads = 0
        ;(Session.messages as any) = mock(async (input: Parameters<typeof Session.messages>[0]) => {
          sessionMessageReads++
          return originalSessionMessages(input)
        })
        const started = ExperienceReencode.start({ type: "intent", reason: "encoding_failed" })
        expect(started).toMatchObject({ status: "running", totalCount: 1 })

        const finished = await waitForTerminalJob(started.id)
        expect(finished).toMatchObject({
          status: "completed",
          totalCount: 1,
          completedCount: 1,
          okCount: 1,
          skippedCount: 0,
          failedCount: 0,
        })
        expect(embeddingAttempts).toBe(3)
        expect(llmRetries).toEqual([0, 0, 0])
        expect(finished.items).toEqual([expect.objectContaining({ id: user.id, sessionID: session.id, status: "ok" })])

        const repaired = LibraryDB.Experience.get(user.id)
        expect(repaired).toMatchObject({
          intent: "Repair failed library experience",
          reward_status: "pending",
          intent_embedding_model: "test-embedding",
          script_embedding_model: "test-embedding",
        })
        const content = LibraryDB.Experience.getContent(user.id)
        expect(content?.script).toContain("1. Inspect the failed experience")
        expect(content?.raw).toContain("Repair the failed library experience")
        expect(content?.raw).toContain("Rebuilt the reusable experience")
        expect(sessionMessageReads).toBe(1)
        LibraryDB.Experience.insertFailed({
          id: user.id,
          sessionID: session.id,
          scopeID: scope.id,
          sourceProviderID: "test-provider",
          sourceModelID: "test-model",
          createdAt: user.time.created,
        })
        const positionalLearning = {
          ...Config.LEARNING_DEFAULTS,
          encoderRetries: 7,
          rewardWeights: { ...Config.REWARD_WEIGHT_DEFAULTS },
        } as Required<Config.Learning>
        const positionalOutcome = await ExperienceEncoder.repairFailedExperience(
          session.id,
          user.id,
          positionalLearning,
        )

        expect(positionalOutcome.encoded).toBe(true)
        expect(llmRetries.slice(-2)).toEqual([7, 7])
      },
    })
  })
})

describe.serial("ExperienceReencode bounded session loading", () => {
  test("reencodes stored scripts without loading session messages", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        insertExperience({
          id: "exp-script-fast-path",
          sessionID: session.id,
          scopeID: scope.id,
          script: "",
          raw: "### User\nRepair the build\n\n### Response\nThe build is repaired.",
        })
        installReencodeModelMocks()

        let embeddingSignal: AbortSignal | undefined
        ;(Embedding.generate as any) = mock(async (input: { id: string; signal?: AbortSignal }) => {
          embeddingSignal = input.signal
          return {
            id: input.id,
            vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            model: "test-embedding",
          }
        })
        let messageReads = 0
        ;(Session.messages as any) = mock(async () => {
          messageReads++
          throw new Error("script reencode must not load session messages")
        })

        const started = ExperienceReencode.start({ type: "script", reason: "empty" })
        const finished = await waitForTerminalJob(started.id)

        expect(finished).toMatchObject({ status: "completed", totalCount: 1, okCount: 1, failedCount: 0 })
        expect(messageReads).toBe(0)
        expect(embeddingSignal).toBeInstanceOf(AbortSignal)
      },
    })
  })

  test("keeps direct script work on its classified lane when the stored row changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        insertExperience({
          id: "exp-script-classified",
          sessionID: session.id,
          scopeID: scope.id,
          script: "",
          raw: "### User\nKeep the direct lane\n\n### Response\nUse the classified row snapshot.",
        })
        installReencodeModelMocks()

        let reads = 0
        ;(LibraryDB.Experience.get as any) = mock((id: string) => {
          const experience = originalExperienceGet(id)
          reads++
          return reads === 1 || !experience ? experience : { ...experience, reward_status: "encoding_failed" }
        })
        let messageReads = 0
        ;(Session.messages as any) = mock(async () => {
          messageReads++
          throw new Error("classified direct work must not switch to session history")
        })

        const started = ExperienceReencode.start({ type: "script", reason: "empty" })
        const finished = await waitForTerminalJob(started.id)

        expect(finished).toMatchObject({ status: "completed", okCount: 1, failedCount: 0 })
        expect(messageReads).toBe(0)
      },
    })
  })

  test("cancels an in-flight model call before embedding and restores the item to pending", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        insertExperience({
          id: "exp-script-cancel",
          sessionID: session.id,
          scopeID: scope.id,
          script: "",
          raw: "### User\nCancel this reencode\n\n### Response\nThis output must not be embedded.",
        })
        installReencodeModelMocks()

        let resolveStreamStarted: ((signal: AbortSignal) => void) | undefined
        const streamStarted = new Promise<AbortSignal>((resolve) => {
          resolveStreamStarted = resolve
        })
        ;(LLM.stream as any) = mock(async (input: { abort: AbortSignal }) => {
          resolveStreamStarted?.(input.abort)
          return {
            textStream: (async function* () {
              await new Promise<void>((_resolve, reject) => {
                const rejectAborted = () => reject(new DOMException("The operation was aborted", "AbortError"))
                if (input.abort.aborted) rejectAborted()
                else input.abort.addEventListener("abort", rejectAborted, { once: true })
              })
              yield "unreachable"
            })(),
            text: new Promise<string>(() => {}),
          }
        })
        const embeddingGenerate = mock(async () => {
          throw new Error("embedding must not run after cancellation")
        })
        ;(Embedding.generate as any) = embeddingGenerate

        const started = ExperienceReencode.start({ type: "script", reason: "empty" })
        const modelSignal = await streamStarted
        const cancelled = await ExperienceReencode.cancel(started.id)

        expect(modelSignal.aborted).toBe(true)
        expect(embeddingGenerate).not.toHaveBeenCalled()
        expect(cancelled).toMatchObject({ status: "cancelled", completedCount: 0 })
        expect(ExperienceReencode.get(started.id)?.items).toEqual([
          expect.objectContaining({ id: "exp-script-cancel", status: "pending" }),
        ])
      },
    })
  })

  test("loads at most one session history at a time and once per session", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const firstSession = await Session.create({})
        const secondSession = await Session.create({})
        const firstUser = await createTurn(firstSession.id, "First request", "First response")
        const secondUser = await createTurn(firstSession.id, "Second request", "Second response")
        const thirdUser = await createTurn(secondSession.id, "Third request", "Third response")
        for (const [user, sessionID] of [
          [firstUser, firstSession.id],
          [secondUser, firstSession.id],
          [thirdUser, secondSession.id],
        ] as const) {
          insertExperience({
            id: user.id,
            sessionID,
            scopeID: scope.id,
            intent: "",
            script: "1. Preserve the completed turn",
            raw: "Stored turn",
          })
        }

        let releaseFirstRead: (() => void) | undefined
        const firstReadBlocked = new Promise<void>((resolve) => {
          releaseFirstRead = resolve
        })
        let resolveFirstReadStarted: (() => void) | undefined
        const firstReadStarted = new Promise<void>((resolve) => {
          resolveFirstReadStarted = resolve
        })
        installReencodeModelMocks(3)

        let activeReads = 0
        let peakReads = 0
        let totalReads = 0
        ;(Session.messages as any) = mock(async (input: Parameters<typeof Session.messages>[0]) => {
          totalReads++
          activeReads++
          peakReads = Math.max(peakReads, activeReads)
          if (totalReads === 1) {
            resolveFirstReadStarted?.()
            await firstReadBlocked
          }
          try {
            return await originalSessionMessages(input)
          } finally {
            activeReads--
          }
        })

        const started = ExperienceReencode.start({ type: "intent", reason: "empty" })
        await firstReadStarted
        await Bun.sleep(0)
        expect(totalReads).toBe(1)
        releaseFirstRead?.()
        const finished = await waitForTerminalJob(started.id)

        expect(finished).toMatchObject({ status: "completed", totalCount: 3, okCount: 3, failedCount: 0 })
        expect(totalReads).toBe(2)
        expect(peakReads).toBe(1)
      },
    })
  })

  test("stops before the next session when critical memory cannot be collected", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const firstSession = await Session.create({})
        const secondSession = await Session.create({})
        const firstUser = await createTurn(firstSession.id, "First critical request", "First response")
        const secondUser = await createTurn(secondSession.id, "Second pending request", "Second response")
        for (const [user, sessionID] of [
          [firstUser, firstSession.id],
          [secondUser, secondSession.id],
        ] as const) {
          insertExperience({
            id: user.id,
            sessionID,
            scopeID: scope.id,
            intent: "",
            script: "1. Preserve the completed turn",
            raw: "Stored turn",
          })
        }
        installReencodeModelMocks()

        const critical = {
          rssBytes: Number.MAX_SAFE_INTEGER,
          heapUsedBytes: 0,
          heapTotalBytes: 0,
          externalBytes: 0,
          arrayBuffersBytes: 0,
        }
        ;(SessionMemoryPressure.currentSnapshotWithCgroup as any) = mock(async () => critical)
        ;(SessionMemoryPressure.maybeCollect as any) = mock(async () => ({
          decision: { action: "unavailable", reason: "gc_unavailable", critical: true },
          before: critical,
        }))

        const started = ExperienceReencode.start({ type: "intent", reason: "empty" })
        const finished = await waitForTerminalJob(started.id)

        expect(finished).toMatchObject({
          status: "failed",
          completedCount: 1,
          error: "reencode stopped because memory is critical and garbage collection is unavailable",
        })
        expect(finished.items.map((item) => item.status)).toEqual(["ok", "pending"])
      },
    })
  })
})

describe("ExperienceReencode worker primitives", () => {
  test("runs a continuous worker pool without exceeding concurrency", async () => {
    let active = 0
    let peak = 0
    const completed: string[] = []

    await ExperienceReencode.runPool({
      items: ["slow", "fast-1", "fast-2", "fast-3"],
      concurrency: 2,
      signal: new AbortController().signal,
      async process(item) {
        active++
        peak = Math.max(peak, active)
        await Bun.sleep(item === "slow" ? 35 : 5)
        completed.push(item)
        active--
      },
    })

    expect(peak).toBe(2)
    expect(completed).toHaveLength(4)
    expect(completed.indexOf("fast-2")).toBeLessThan(completed.indexOf("slow"))
  })

  test("stops claiming new work after cancellation", async () => {
    const abort = new AbortController()
    const started: number[] = []

    await ExperienceReencode.runPool({
      items: [1, 2, 3, 4],
      concurrency: 1,
      signal: abort.signal,
      async process(item) {
        started.push(item)
        abort.abort()
      },
    })

    expect(started).toEqual([1])
  })

  test("retries only classified transient stage failures", async () => {
    let transientAttempts = 0
    const transient = await ExperienceReencode.withStageRetry({
      retries: 2,
      backoffMs: 0,
      signal: new AbortController().signal,
      operation() {
        transientAttempts++
        if (transientAttempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 })
        if (transientAttempts === 2) throw Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" })
        return "ok"
      },
    })
    expect(transient).toBe("ok")
    expect(transientAttempts).toBe(3)

    let permanentAttempts = 0
    await expect(
      ExperienceReencode.withStageRetry({
        retries: 3,
        backoffMs: 0,
        signal: new AbortController().signal,
        operation() {
          permanentAttempts++
          throw new Error("no-user-text")
        },
      }),
    ).rejects.toThrow("no-user-text")
    expect(permanentAttempts).toBe(1)
  })
})
