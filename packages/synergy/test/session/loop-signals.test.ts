import { describe, expect, test, beforeAll, mock } from "bun:test"
import { LoopJob } from "../../src/session/loop-job"
import { LLM } from "../../src/session/llm"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import type { Provider } from "../../src/provider/provider"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Info } from "../../src/session/types"
import type { Scope } from "../../src/scope/types"

Log.init({ print: false })

// ─── helpers ───────────────────────────────────────────────────────

function createModel(opts: { context: number; output: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test-provider",
    name: "Test",
    limit: { context: opts.context, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    api: { id: "test", url: "http://localhost", npm: "@ai-sdk/openai" },
    options: {},
    headers: {},
    status: "active",
    release_date: "2025-01-01",
  } as Provider.Model
}

function makeTokens(input: number, output: number, cacheRead = 0) {
  return { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } }
}

function makeUserMsg(overrides?: Partial<MessageV2.User>): MessageV2.User {
  return {
    id: Identifier.ascending("message"),
    role: "user" as const,
    sessionID: "ses_test",
    time: { created: Date.now() },
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    ...overrides,
  } as MessageV2.User
}

function makeAssistantMsg(overrides?: Partial<MessageV2.Assistant>): MessageV2.Assistant {
  return {
    id: Identifier.ascending("message"),
    role: "assistant" as const,
    sessionID: "ses_test",
    parentID: Identifier.ascending("message"),
    agent: "synergy",
    mode: "synergy",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: makeTokens(0, 0),
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now(), completed: Date.now() },
    ...overrides,
  } as MessageV2.Assistant
}

function makeSession(): Info {
  return {
    id: Identifier.ascending("session"),
    scope: { id: "scope_test", directory: "/tmp" } as Scope,
    title: "Test Session",
    version: "1",
    time: { created: Date.now(), updated: Date.now() },
  } as Info
}

function makeContext(overrides: Partial<LoopJob.Context>): LoopJob.Context {
  return {
    session: makeSession(),
    sessionID: "ses_test",
    step: 1,
    messages: [],
    lastUser: makeUserMsg(),
    lastUserParts: [],
    abort: new AbortController().signal,
    ...overrides,
  }
}

// ─── mocks ─────────────────────────────────────────────────────────

const TEST_MODEL = createModel({ context: 200_000, output: 8_192 })

mock.module("../../src/config/config", () => ({
  Config: {
    get: async () => ({}),
  },
}))

mock.module("../../src/provider/provider", () => ({
  Provider: {
    getModel: async () => TEST_MODEL,
  },
}))

mock.module("../../src/session", () => ({
  Session: {
    updatePart: async (part: any) => part,
  },
}))

// ─── import signals (registers them into LoopJob) ──────────────────

beforeAll(async () => {
  await import("../../src/session/loop-signals")
})

// ─── tests ─────────────────────────────────────────────────────────

describe("loop-signals: compact signal", () => {
  test("detects when compaction part exists", async () => {
    const ctx = makeContext({
      lastUserParts: [
        {
          id: "part_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          type: "compaction",
          auto: false,
        } as MessageV2.CompactionPart,
      ],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
  })

  test("does not detect when no compaction part", async () => {
    const ctx = makeContext({
      lastUserParts: [
        { id: "part_1", sessionID: "ses_test", messageID: "msg_1", type: "text", text: "hello" } as MessageV2.TextPart,
      ],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("compact")
  })
})

describe("loop-signals: overflow signal", () => {
  test("does not fire when no assistant message exists", async () => {
    const ctx = makeContext({
      lastFinished: undefined,
      lastAssistant: undefined,
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("overflow")
  })

  test("does not fire when source is a summary message", async () => {
    const summary = makeAssistantMsg({ summary: true, finish: "stop", tokens: makeTokens(180_000, 15_000) })
    const ctx = makeContext({
      lastFinished: summary,
      lastAssistant: summary,
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("overflow")
  })

  test("does not fire when token usage is within limit", async () => {
    // usable = 200000 - 8192 = 191808; count = 105000 < 191808
    const ctx = makeContext({
      lastAssistant: makeAssistantMsg({ finish: "stop", tokens: makeTokens(100_000, 5_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("overflow")
  })

  test("fires when token usage exceeds usable context", async () => {
    // usable = 200000 - 8192 = 191808; count = 195000 > 191808
    const ctx = makeContext({
      lastAssistant: makeAssistantMsg({ finish: "stop", tokens: makeTokens(180_000, 15_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("overflow")
  })

  test("includes cache.read in token count", async () => {
    // count = 100000 + 80000 + 15000 = 195000 > 191808
    const ctx = makeContext({
      lastAssistant: makeAssistantMsg({ finish: "stop", tokens: makeTokens(100_000, 15_000, 80_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("overflow")
  })

  test("skips when compaction part already exists", async () => {
    const ctx = makeContext({
      lastAssistant: makeAssistantMsg({ finish: "stop", tokens: makeTokens(180_000, 15_000) }),
      lastUserParts: [
        {
          id: "part_1",
          sessionID: "ses_test",
          messageID: "msg_1",
          type: "compaction",
          auto: true,
        } as MessageV2.CompactionPart,
      ],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("compact")
    expect(fired).not.toContain("overflow")
  })

  test("caps output reserve at OUTPUT_TOKEN_MAX", () => {
    expect(Math.min(TEST_MODEL.limit.output, LLM.OUTPUT_TOKEN_MAX)).toBe(8_192)

    const highOutputModel = createModel({ context: 200_000, output: 100_000 })
    expect(Math.min(highOutputModel.limit.output, LLM.OUTPUT_TOKEN_MAX)).toBe(LLM.OUTPUT_TOKEN_MAX)
  })
})

describe("loop-signals: overflow via lastAssistant (regression)", () => {
  test("fires during tool loop when lastAssistant has high tokens but lastFinished is stale", async () => {
    // Scenario: agent is mid-tool-loop. lastFinished points to a previous turn's
    // terminal message with low tokens; lastAssistant is the latest tool-calls
    // message with current (high) token usage.
    const ctx = makeContext({
      step: 8,
      lastFinished: makeAssistantMsg({ finish: "stop", tokens: makeTokens(40_000, 5_000) }),
      lastAssistant: makeAssistantMsg({ finish: "tool-calls", tokens: makeTokens(180_000, 15_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("overflow")
  })

  test("fires in first turn when no terminal assistant exists yet", async () => {
    // First user message triggers a long tool loop. No lastFinished at all,
    // but lastAssistant reflects the growing context.
    const ctx = makeContext({
      step: 15,
      lastFinished: undefined,
      lastAssistant: makeAssistantMsg({ finish: "tool-calls", tokens: makeTokens(185_000, 10_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("overflow")
  })

  test("does not fire when lastAssistant tokens are within limit despite many steps", async () => {
    const ctx = makeContext({
      step: 20,
      lastFinished: undefined,
      lastAssistant: makeAssistantMsg({ finish: "tool-calls", tokens: makeTokens(80_000, 5_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("overflow")
  })

  test("falls back to lastFinished when lastAssistant is undefined", async () => {
    // Edge case: lastAssistant somehow not set, but lastFinished exists with high tokens
    const ctx = makeContext({
      lastFinished: makeAssistantMsg({ finish: "stop", tokens: makeTokens(180_000, 15_000) }),
      lastAssistant: undefined,
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("overflow")
  })

  test("prefers lastAssistant over lastFinished for token check", async () => {
    // lastFinished says low tokens; lastAssistant says high tokens → should fire
    const ctx = makeContext({
      lastFinished: makeAssistantMsg({ finish: "stop", tokens: makeTokens(10_000, 2_000) }),
      lastAssistant: makeAssistantMsg({ finish: "tool-calls", tokens: makeTokens(190_000, 5_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).toContain("overflow")

    // Inverse: lastFinished says high, lastAssistant says low → should NOT fire
    const ctxInverse = makeContext({
      lastFinished: makeAssistantMsg({ finish: "stop", tokens: makeTokens(190_000, 5_000) }),
      lastAssistant: makeAssistantMsg({ finish: "tool-calls", tokens: makeTokens(10_000, 2_000) }),
      lastUserParts: [],
    })
    const firedInverse = await LoopJob.detectSignals(ctxInverse)
    expect(firedInverse).not.toContain("overflow")
  })

  test("does not re-trigger after compaction summary", async () => {
    // After compaction, the summary message becomes lastAssistant.
    // Its summary=true flag prevents re-triggering.
    const ctx = makeContext({
      lastAssistant: makeAssistantMsg({ summary: true, finish: "stop", tokens: makeTokens(10_000, 2_000) }),
      lastUserParts: [],
    })
    const fired = await LoopJob.detectSignals(ctx)
    expect(fired).not.toContain("overflow")
  })
})
