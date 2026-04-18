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

// ---------------------------------------------------------------------------
// Token.encodingForModelID
// ---------------------------------------------------------------------------

describe("util.token.encodingForModelID", () => {
  test("maps o200k models", () => {
    for (const id of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.5-preview",
      "gpt-5",
      "o1",
      "o3-mini",
      "o4-mini",
      "chatgpt-4o-latest",
    ]) {
      expect(Token.encodingForModelID(id)).toBe("o200k_base")
    }
  })

  test("maps cl100k models", () => {
    for (const id of ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo"]) {
      expect(Token.encodingForModelID(id)).toBe("cl100k_base")
    }
  })

  test("defaults non-OpenAI models to o200k_base", () => {
    for (const id of [
      "claude-3-opus-20240229",
      "gemini-1.5-pro",
      "qwen-72b",
      "deepseek-v3",
      "glm-4",
      "mistral-large",
    ]) {
      expect(Token.encodingForModelID(id)).toBe("o200k_base")
    }
  })

  test("defaults unknown OpenAI-ish models to o200k", () => {
    expect(Token.encodingForModelID("gpt-99-turbo")).toBe("o200k_base")
    expect(Token.encodingForModelID("o99")).toBe("o200k_base")
  })

  test("defaults completely unknown models to o200k_base", () => {
    expect(Token.encodingForModelID("some-random-model")).toBe("o200k_base")
  })
})

// ---------------------------------------------------------------------------
// Token.estimateModel (async)
// ---------------------------------------------------------------------------

describe("util.token.estimateModel", () => {
  const cjk = "这是一个中文测试"
  const heuristic = Token.estimate(cjk)

  test("returns accurate count for known OpenAI model", async () => {
    const count = await Token.estimateModel("gpt-4o", cjk)
    expect(count).toBeGreaterThan(heuristic)
  })

  test("returns o200k-based count for non-OpenAI model", async () => {
    const count = await Token.estimateModel("claude-3-opus-20240229", cjk)
    expect(count).toBeGreaterThan(heuristic)
  })

  test("returns 0 for empty string", async () => {
    expect(await Token.estimateModel("gpt-4o", "")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Token.estimateModelSync
// ---------------------------------------------------------------------------

describe("util.token.estimateModelSync", () => {
  const cjk = "这是一个中文测试"
  const heuristic = Token.estimate(cjk)

  test("returns heuristic before warmup for a cold encoding", () => {
    const count = Token.estimateModelSync("gpt-4-turbo", cjk)
    expect(count).toBe(heuristic)
  })

  test("returns accurate count after warmup", async () => {
    await Token.warmup("gpt-4o")
    const count = Token.estimateModelSync("gpt-4o", cjk)
    expect(count).toBeGreaterThan(heuristic)
  })
})

// ---------------------------------------------------------------------------
// Token.warmup
// ---------------------------------------------------------------------------

describe("util.token.warmup", () => {
  test("completes without error for known model", async () => {
    await Token.warmup("gpt-4o")
  })

  test("completes without error for unknown model", async () => {
    await Token.warmup("some-random-model")
  })
})
