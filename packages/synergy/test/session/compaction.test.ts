import { describe, expect, mock, test } from "bun:test"
import { Token } from "../../src/util/token"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Config } from "../../src/config/config"
import type { Provider } from "../../src/provider/provider"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"

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

// Preflight compaction triggering now lives in session/invoke.ts via PromptBudgeter;
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
  test("ModelLimit.usableInput uses full context for shared-context models", () => {
    expect(ModelLimit.usableInput({ context: 202_752, output: 32_768 })).toBe(202_752)
  })

  test("ModelLimit.usableInput uses input cap directly without buffer by default", () => {
    expect(ModelLimit.usableInput({ context: 400_000, input: 272_000, output: 128_000 })).toBe(272_000)
  })

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

  test("extracts DeepSeek prompt cache metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        openaiCompatible: {
          prompt_cache_hit_tokens: 256,
          prompt_cache_miss_tokens: 744,
        },
      },
    })

    expect(result.tokens.input).toBe(744)
    expect(result.tokens.cache.read).toBe(256)
  })

  test("extracts DeepSeek prompt cache tokens from usage fields", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        prompt_cache_hit_tokens: 384,
        prompt_cache_miss_tokens: 616,
      } as Parameters<typeof Session.getUsage>[0]["usage"],
    })

    expect(result.tokens.input).toBe(616)
    expect(result.tokens.cache.read).toBe(384)
  })

  test("extracts OpenAI prompt cache hit and miss metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        openai: {
          prompt_cache_hit_tokens: 300,
          prompt_cache_miss_tokens: 700,
        },
      },
    })

    expect(result.tokens.input).toBe(700)
    expect(result.tokens.cache.read).toBe(300)
  })

  test("extracts DeepSeek prompt cache metadata from provider namespace", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        deepseek: {
          prompt_cache_hit_tokens: 128,
          prompt_cache_miss_tokens: 872,
        },
      },
    })

    expect(result.tokens.input).toBe(872)
    expect(result.tokens.cache.read).toBe(128)
  })

  test("extracts hyphenated openai-compatible prompt cache metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        "openai-compatible": {
          prompt_cache_hit_tokens: 64,
          prompt_cache_miss_tokens: 936,
        },
      },
    })

    expect(result.tokens.input).toBe(936)
    expect(result.tokens.cache.read).toBe(64)
  })

  test("handles Bedrock cache write metadata without subtracting cached reads from input", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 150,
      },
      metadata: {
        bedrock: {
          usage: {
            cacheWriteInputTokens: 225,
          },
        },
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.cache.read).toBe(150)
    expect(result.tokens.cache.write).toBe(225)
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

  // issue #321: recognize the context-window signal even when the error was
  // wrapped or normalized to a shape other than APIError.
  test("detects a wrapped/plain error via top-level message", () => {
    expect(SessionCompaction.isContextExceeded({ name: "Error", message: "context_length_exceeded" })).toBe(true)
  })

  test("detects a nested error code when the shape was rewritten", () => {
    expect(
      SessionCompaction.isContextExceeded({
        name: "ProviderError",
        data: { error: { type: "invalid_request_error", code: "context_length_exceeded" } },
      }),
    ).toBe(true)
  })

  test("still rejects unrelated wrapped errors", () => {
    expect(SessionCompaction.isContextExceeded({ name: "Error", message: "network timeout" })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SessionCompaction.hasPendingCompaction (issue #321)
// ---------------------------------------------------------------------------

describe("session.compaction.hasPendingCompaction", () => {
  const rootID = "msg_root"
  const compactionPart = () => ({ type: "compaction" }) as any
  const textPart = () => ({ type: "text", text: "hi" }) as any
  const summary = (parentID = rootID) =>
    ({ info: { role: "assistant", summary: true, finish: "stop", parentID }, parts: [] }) as any
  const assistant = () => ({ info: { role: "assistant", finish: "stop" }, parts: [] }) as any

  test("no compaction part → not pending", () => {
    expect(SessionCompaction.hasPendingCompaction([textPart()], [assistant()], rootID)).toBe(false)
  })

  test("one compaction part, no summary yet → pending", () => {
    expect(SessionCompaction.hasPendingCompaction([compactionPart()], [assistant()], rootID)).toBe(true)
  })

  test("one compaction part fulfilled by a summary → not pending (task resumes)", () => {
    expect(SessionCompaction.hasPendingCompaction([compactionPart()], [summary()], rootID)).toBe(false)
  })

  test("second compaction request after a fulfilled first → pending again (repeatable)", () => {
    // Two compaction parts on R but only one completed summary so far.
    expect(
      SessionCompaction.hasPendingCompaction([compactionPart(), compactionPart()], [summary(), assistant()], rootID),
    ).toBe(true)
  })

  test("a summary anchored on a different root does not count", () => {
    expect(SessionCompaction.hasPendingCompaction([compactionPart()], [summary("msg_other")], rootID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SessionCompaction.buildAnchor
// ---------------------------------------------------------------------------

describe("session.compaction.buildAnchor", () => {
  const now = Date.now()

  function userMsg(
    id: string,
    parts: Array<{ text: string; synthetic?: boolean }>,
    metadata?: Record<string, any>,
  ): MessageV2.WithParts {
    return {
      info: {
        id,
        role: "user",
        sessionID: "test-session",
        time: { created: now },
        agent: "synergy",
        model: { providerID: "test", modelID: "test-model" },
        ...(metadata ? { metadata } : {}),
      },
      parts: parts.map((part, index) => ({
        id: `text-${id}-${index}`,
        sessionID: "test-session",
        messageID: id,
        type: "text",
        text: part.text,
        ...(part.synthetic ? { synthetic: true } : {}),
      })),
    }
  }

  test("anchors the active parent user request when it has real text", () => {
    const messages = [
      userMsg("previous", [{ text: "will gh pr create be blocked?" }]),
      userMsg("active", [{ text: "allow ordinary branch push and gh pr create in autonomous mode" }]),
    ]

    const anchor = SessionCompaction.buildAnchor(messages, "active")

    expect(anchor).toContain("allow ordinary branch push and gh pr create in autonomous mode")
    expect(anchor).not.toContain("will gh pr create be blocked?")
  })

  test("anchors the root by parentID, not a later synthetic continue", () => {
    // The loop always passes the task root R as parentID (issue #281 §7), so
    // the anchor is R's text regardless of any later synthetic/steer messages.
    const messages = [
      userMsg("active", [{ text: "keep this active request across compaction" }]),
      userMsg("continue", [{ text: "Continue if you have next steps", synthetic: true }]),
    ]

    const anchor = SessionCompaction.buildAnchor(messages, "active")

    expect(anchor).toContain("keep this active request across compaction")
    expect(anchor).not.toContain("Continue if you have next steps")
  })

  test("anchors the root by parentID, not a later guided steer", () => {
    const messages = [
      userMsg("active", [{ text: "implement the active task" }]),
      userMsg("guided", [{ text: "temporary steering context" }], { guided: true }),
    ]

    const anchor = SessionCompaction.buildAnchor(messages, "active")

    expect(anchor).toContain("implement the active task")
    expect(anchor).not.toContain("temporary steering context")
  })

  test("resolves the root by id in O(1) without scanning neighbours", () => {
    const messages = [
      userMsg("earlier", [{ text: "an earlier request" }]),
      userMsg("active", [{ text: "the current root request" }]),
      userMsg("guided", [{ text: "some steering context" }], { guided: true }),
    ]

    const anchor = SessionCompaction.buildAnchor(messages, "active")

    expect(anchor).toContain("the current root request")
    expect(anchor).not.toContain("an earlier request")
    expect(anchor).not.toContain("some steering context")
  })

  test("ignores system-origin text parts when extracting anchor text", () => {
    const messages = [
      userMsg("active", [{ text: "hidden synthetic text", synthetic: true }, { text: "visible active request" }]),
    ]

    const anchor = SessionCompaction.buildAnchor(messages, "active")

    expect(anchor).toContain("visible active request")
    expect(anchor).not.toContain("hidden synthetic text")
  })

  test("falls back to the root summary title when it has no user-authored text", () => {
    const messages = [
      userMsg("active", [{ text: "only synthetic content", synthetic: true }], {
        summary: { title: "Scheduled task", diffs: [] },
      }),
    ]
    // summary lives on info, not metadata — attach it directly
    ;(messages[0].info as MessageV2.User).summary = { title: "Scheduled task", diffs: [] }

    const anchor = SessionCompaction.buildAnchor(messages, "active")

    expect(anchor).toContain("Scheduled task")
  })

  test("returns undefined when the root is missing", () => {
    const messages = [userMsg("active", [{ text: "a request" }])]

    expect(SessionCompaction.buildAnchor(messages, "does-not-exist")).toBeUndefined()
  })
})

describe("session.compaction.buildRecoveryHint", () => {
  test("points the continuation at durable history around the compaction boundary", () => {
    const hint = SessionCompaction.buildRecoveryHint({
      sessionID: "ses_test",
      summaryMessageID: "msg_summary",
    })

    expect(hint).toContain("<recovery-hint>")
    expect(hint).toContain("Do not read the earlier history unless the continuation summary is insufficient")
    expect(hint).toContain('expand the "session" tool group')
    expect(hint).toContain('target session "ses_test"')
    expect(hint).toContain('around message "msg_summary"')
    expect(hint).toContain("limit 50")
    expect(hint).toContain("</recovery-hint>")
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

// ---------------------------------------------------------------------------
// SessionCompaction.selectPartsToPrune — regression tests
// ---------------------------------------------------------------------------

describe("session.compaction.selectPartsToPrune", () => {
  const now = Date.now()

  function toolPart(opts: { id?: string; tool?: string; output?: string; compacted?: number }): MessageV2.ToolPart {
    return {
      id: opts.id ?? `part-${Math.random().toString(36).slice(2, 8)}`,
      sessionID: "test-session",
      messageID: "msg-assistant",
      type: "tool",
      callID: `call-${Math.random().toString(36).slice(2, 8)}`,
      tool: opts.tool ?? "bash",
      state: {
        status: "completed",
        input: {},
        output: opts.output ?? "",
        title: "test",
        metadata: {},
        time: {
          start: now - 1000,
          end: now,
          ...(opts.compacted ? { compacted: opts.compacted } : {}),
        },
      },
    }
  }

  function userMsg(id: string): MessageV2.WithParts {
    return {
      info: {
        id,
        role: "user",
        sessionID: "test-session",
        time: { created: now },
        agent: "synergy",
        model: { providerID: "test", modelID: "test-model" },
      },
      parts: [{ id: `text-${id}`, sessionID: "test-session", messageID: id, type: "text", text: "hello" }],
    }
  }

  function assistantMsg(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
    return {
      info: {
        id,
        role: "assistant",
        sessionID: "test-session",
        time: { created: now },
        parentID: "msg-user",
        modelID: "test-model",
        providerID: "test",
        mode: "default",
        agent: "synergy",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts,
    }
  }

  test("skips already-compacted parts and continues scanning earlier messages", () => {
    // Regression: old code did `break loop` on compacted parts, stopping the
    // entire backward scan. This meant that once any tool part was compacted,
    // all earlier parts became invisible to pruning — even if they had huge
    // output that should be pruned.
    //
    // Layout (oldest → newest):
    //   [user0, asst0(tool: 50K tokens, not compacted), user1, asst1(tool: already compacted), user2, asst2(tool: recent)]
    //
    // After the fix (continue instead of break), the scanner should skip the
    // compacted part in asst1 and still find the large part in asst0.

    const bigOutput = "x".repeat(50_000 * 4) // ~50K tokens (4 chars/token)

    const msgs: MessageV2.WithParts[] = [
      userMsg("u0"),
      assistantMsg("a0", [toolPart({ id: "old-big-tool", output: bigOutput })]),
      userMsg("u1"),
      assistantMsg("a1", [toolPart({ id: "mid-compacted-tool", output: "small", compacted: now - 500 })]),
      userMsg("u2"),
      assistantMsg("a2", [toolPart({ id: "recent-tool", output: "small" })]),
    ]

    const result = SessionCompaction.selectPartsToPrune(msgs)

    // The old-big-tool in a0 should be found and eligible for pruning
    // (it exceeds PRUNE_PROTECT=40K and the pruned total exceeds PRUNE_MINIMUM=20K)
    expect(result.some((p) => p.id === "old-big-tool")).toBe(true)
  })

  test("returns empty when total output is below PRUNE_MINIMUM", () => {
    const smallOutput = "x".repeat(100)
    const msgs: MessageV2.WithParts[] = [
      userMsg("u0"),
      assistantMsg("a0", [toolPart({ output: smallOutput })]),
      userMsg("u1"),
      assistantMsg("a1", [toolPart({ output: smallOutput })]),
    ]

    const result = SessionCompaction.selectPartsToPrune(msgs)
    expect(result).toHaveLength(0)
  })

  test("protects recent turns from pruning", () => {
    // The most recent 2 user turns are protected — only older parts are
    // candidates for pruning.
    const bigOutput = "x".repeat(50_000 * 4) // ~50K tokens

    // Layout: [u0, a0(big old tool), u1, a1(big recent tool), u2, a2(small)]
    // countRecentTurns(msgs, 2) returns index 2 (u1) as the boundary.
    // Scan range: msgIndex 1 down to 0 → only a0 is scanned.
    const msgs: MessageV2.WithParts[] = [
      userMsg("u0"),
      assistantMsg("a0", [toolPart({ id: "old-tool", output: bigOutput })]),
      userMsg("u1"),
      assistantMsg("a1", [toolPart({ id: "recent-tool", output: bigOutput })]),
      userMsg("u2"),
      assistantMsg("a2", [toolPart({ id: "newest-tool", output: "small" })]),
    ]

    const result = SessionCompaction.selectPartsToPrune(msgs)

    // "old-tool" (before the protect boundary) should be prunable,
    // "recent-tool" (within the protected zone) should not appear.
    expect(result.some((p) => p.id === "old-tool")).toBe(true)
    expect(result.some((p) => p.id === "recent-tool")).toBe(false)
  })

  test("skips protected tools like skill", () => {
    const bigOutput = "x".repeat(50_000 * 4)

    const msgs: MessageV2.WithParts[] = [
      userMsg("u0"),
      assistantMsg("a0", [toolPart({ id: "skill-tool", tool: "skill", output: bigOutput })]),
      userMsg("u1"),
      assistantMsg("a1", []),
    ]

    const result = SessionCompaction.selectPartsToPrune(msgs)
    expect(result).toHaveLength(0)
  })

  test("accepts optional modelID parameter", () => {
    // Verify that selectPartsToPrune accepts and uses modelID without error.
    // Use a small output string — the plumbing test doesn't need large data.
    // Other tests already cover the threshold logic with heuristic estimation.
    const output = "x".repeat(400)
    const msgs: MessageV2.WithParts[] = [
      userMsg("u0"),
      assistantMsg("a0", [toolPart({ id: "old-tool", output })]),
      userMsg("u1"),
      assistantMsg("a1", [toolPart({ id: "mid-tool", output: "small" })]),
      userMsg("u2"),
      assistantMsg("a2", [toolPart({ id: "recent-tool", output: "small" })]),
    ]

    // Should not throw with modelID — both return empty since output is small
    const withoutModel = SessionCompaction.selectPartsToPrune(msgs)
    const withModel = SessionCompaction.selectPartsToPrune(msgs, "gpt-4o")

    expect(withoutModel).toHaveLength(0)
    expect(withModel).toHaveLength(0)
  })

  test("prunes from the loop snapshot without rereading or mutating it", async () => {
    const oldPart = toolPart({ id: "old-tool", output: "x".repeat(300_000) })
    const msgs: MessageV2.WithParts[] = [
      userMsg("u0"),
      assistantMsg("a0", [oldPart]),
      userMsg("u1"),
      assistantMsg("a1", []),
      userMsg("u2"),
      assistantMsg("a2", []),
    ]
    const originalMessages = Session.messages
    const originalUpdatePart = Session.updatePart
    const originalConfigCurrent = Config.current
    let persisted: MessageV2.Part | undefined
    ;(Config.current as any) = mock(async () => ({ compaction: {} }))
    ;(Session.messages as any) = mock(async () => {
      throw new Error("prune reread full history")
    })
    ;(Session.updatePart as any) = mock(async (part: MessageV2.Part) => {
      persisted = part
      return part
    })

    try {
      await SessionCompaction.prune({ sessionID: "test-session", messages: msgs })
    } finally {
      ;(Config.current as any) = originalConfigCurrent
      ;(Session.messages as any) = originalMessages
      ;(Session.updatePart as any) = originalUpdatePart
    }

    expect(oldPart.state.status).toBe("completed")
    if (oldPart.state.status === "completed") {
      expect(oldPart.state.output.length).toBe(300_000)
      expect(oldPart.state.time.compacted).toBeUndefined()
    }
    expect(persisted?.type).toBe("tool")
    if (persisted?.type === "tool" && persisted.state.status === "completed") {
      expect(persisted.state.output).toBe("")
      expect(persisted.state.time.compacted).toBeNumber()
    }
  })
})
