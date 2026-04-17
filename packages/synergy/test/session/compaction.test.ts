import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import type { Provider } from "../../src/provider/provider"

Log.init({ print: false })

function createModel(opts: { context: number; output: number; cost?: Provider.Model["cost"] }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

// Overflow detection now lives in loop-signals.ts as a LoopJob signal;
// isContextExceeded and Token.estimateJSON are tested below.

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("session.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("does not subtract cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles reasoning tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 100,
      },
    })

    expect(result.tokens.reasoning).toBe(100)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })
})

// ---------------------------------------------------------------------------
// Token.estimateJSON
// ---------------------------------------------------------------------------

describe("util.token.estimateJSON", () => {
  test("estimates a plain string like Token.estimate", () => {
    const text = "hello world"
    expect(Token.estimateJSON(text)).toBe(Token.estimate(text))
  })

  test("estimates an object via JSON serialization", () => {
    const obj = { role: "user", content: "hi" }
    expect(Token.estimateJSON(obj)).toBe(Token.estimate(JSON.stringify(obj)))
  })

  test("returns 0 for circular references", () => {
    const a: any = {}
    a.self = a
    expect(Token.estimateJSON(a)).toBe(0)
  })

  test("returns 0 for undefined", () => {
    expect(Token.estimateJSON(undefined)).toBe(0)
  })

  test("estimates arrays", () => {
    const arr = [1, 2, 3]
    expect(Token.estimateJSON(arr)).toBe(Token.estimate(JSON.stringify(arr)))
  })
})

// ---------------------------------------------------------------------------
// SessionCompaction.isContextExceeded
// ---------------------------------------------------------------------------

describe("session.compaction.isContextExceeded", () => {
  function apiError(message: string, opts?: { statusCode?: number; responseBody?: string }) {
    return {
      name: "APIError",
      data: {
        message,
        statusCode: opts?.statusCode ?? 400,
        isRetryable: false,
        responseBody: opts?.responseBody,
      },
    }
  }

  test("detects OpenAI context_length_exceeded", () => {
    expect(
      SessionCompaction.isContextExceeded(
        apiError(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
        ),
      ),
    ).toBe(true)
  })

  test("detects error code in message", () => {
    expect(SessionCompaction.isContextExceeded(apiError("context_length_exceeded"))).toBe(true)
  })

  test("detects Anthropic-style message", () => {
    expect(
      SessionCompaction.isContextExceeded(apiError("Your request exceeds the maximum number of tokens allowed.")),
    ).toBe(true)
  })

  test("detects max_tokens keyword", () => {
    expect(SessionCompaction.isContextExceeded(apiError("max_tokens: limit reached for this request"))).toBe(true)
  })

  test("detects context exceeded in responseBody when message is generic", () => {
    expect(
      SessionCompaction.isContextExceeded(
        apiError("Bad Request", {
          responseBody: '{"error":{"type":"context_length_exceeded","message":"too many tokens"}}',
        }),
      ),
    ).toBe(true)
  })

  test("rejects unrelated 400 errors", () => {
    expect(SessionCompaction.isContextExceeded(apiError("Invalid model specified"))).toBe(false)
  })

  test("rejects rate limit errors", () => {
    expect(SessionCompaction.isContextExceeded(apiError("Rate limit exceeded. Please retry later."))).toBe(false)
  })

  test("rejects non-APIError objects", () => {
    expect(SessionCompaction.isContextExceeded({ name: "AuthError", data: { message: "bad key" } })).toBe(false)
  })

  test("rejects null / undefined", () => {
    expect(SessionCompaction.isContextExceeded(null)).toBe(false)
    expect(SessionCompaction.isContextExceeded(undefined)).toBe(false)
  })

  test("rejects primitive values", () => {
    expect(SessionCompaction.isContextExceeded("context_length_exceeded")).toBe(false)
    expect(SessionCompaction.isContextExceeded(42)).toBe(false)
  })

  test("detects 'request too large' with token mention", () => {
    expect(SessionCompaction.isContextExceeded(apiError("request too large: total token count exceeds limit"))).toBe(
      true,
    )
  })
})
