import { afterEach, describe, expect, mock, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { LibraryDB, closeDB } from "../../src/library/database"
import { ExperienceReencode } from "../../src/library/experience-reencode"
import { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
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
const originalEmbeddingGenerate = Embedding.generate
const originalProviderGetModel = Provider.getModel
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

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.getAvailableModel as any) = originalAgentModel
  ;(Config.current as any) = originalConfigCurrent
  ;(Embedding.generate as any) = originalEmbeddingGenerate
  ;(Provider.getModel as any) = originalProviderGetModel
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

  test("pauses before claiming new work under pressure and stops waiting after cancellation", async () => {
    const abort = new AbortController()
    const started: number[] = []
    let critical = false
    let gateCalls = 0

    const pending = ExperienceReencode.runPool({
      items: [1, 2, 3],
      concurrency: 1,
      signal: abort.signal,
      pressurePollMs: 5,
      pressureGate() {
        gateCalls++
        return critical
      },
      async process(item) {
        started.push(item)
        critical = true
      },
    })

    await Bun.sleep(20)
    expect(started).toEqual([1])
    expect(gateCalls).toBeGreaterThan(0)

    abort.abort()
    await pending
    expect(started).toEqual([1])
  })

  test("resumes claiming work after memory pressure clears", async () => {
    const started: number[] = []
    let critical = false

    const pending = ExperienceReencode.runPool({
      items: [1, 2, 3],
      concurrency: 1,
      signal: new AbortController().signal,
      pressurePollMs: 5,
      pressureGate: () => critical,
      async process(item) {
        started.push(item)
        if (item === 1) critical = true
      },
    })

    await Bun.sleep(20)
    expect(started).toEqual([1])

    critical = false
    await pending
    expect(started).toEqual([1, 2, 3])
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
