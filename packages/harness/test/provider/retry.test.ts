import { afterEach, expect, spyOn, test } from "bun:test"
import type { LanguageModelV2, LanguageModelV2StreamPart } from "@ai-sdk/provider"
import { APICallError, RetryError } from "ai"
import { Provider } from "../../src/provider/provider"
import { normalizeProviderError, providerRetryable } from "../../src/provider/retry"
import { LLM } from "../../src/session/llm"
import { RolloutRecordingError } from "../../src/session/rollout/error"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const model: Provider.Model = {
  id: "test",
  providerID: "test",
  name: "Test",
  family: "test",
  api: { id: "test", url: "https://provider.invalid", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 32000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const originalLanguage = Provider.getLanguage
afterEach(() =>
  runtime.run(() => {
    Provider.getLanguage = originalLanguage
  }),
)

async function run(doStream: LanguageModelV2["doStream"], retries: number) {
  const language: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("unexpected generation")
    },
    doStream,
  }
  spyOn(Provider, "getLanguage").mockResolvedValue(language)
  const result = await LLM.stream({
    user: { id: "msg_test" },
    sessionID: "ses_test",
    agent: { name: "synergy" },
    model,
    system: [],
    tools: {},
    abort: new AbortController().signal,
    retries,
    messages: [{ role: "user", content: "test" }],
    prepared: {
      system: [],
      baseSystemLength: 0,
      params: { options: {} },
      provider: { options: {}, timeouts: { ttfbMs: 1000, idleMs: false, wallMs: false } },
    },
  })
  const owned = LLM.takeFullStream(result)
  const events = []
  try {
    for await (const event of owned.stream) events.push(event)
  } finally {
    await owned.dispose()
  }
  return events
}

function success() {
  return {
    stream: new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "text" })
        controller.enqueue({ type: "text-delta", id: "text", delta: "recovered" })
        controller.enqueue({ type: "text-end", id: "text" })
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })
        controller.close()
      },
    }),
  }
}

test(
  "the real SDK retries raw DNS failures inside the caller's retry budget",
  () =>
    runtime.run(async () => {
      let calls = 0
      const events = await run(async () => {
        if (++calls === 1)
          throw Object.assign(new TypeError("getaddrinfo ETIMEOUT provider.invalid"), { code: "ETIMEOUT" })
        return success()
      }, 1)
      expect(calls).toBe(2)
      expect(events.some((event) => event.type === "text-delta" && event.text === "recovered")).toBe(true)
    }),
  10000,
)

test("normal session calls leave retry ownership with the processor", () =>
  runtime.run(async () => {
    let calls = 0
    const events = await run(async () => {
      calls++
      throw Object.assign(new TypeError("getaddrinfo ETIMEOUT provider.invalid"), { code: "ETIMEOUT" })
    }, 0)
    expect(calls).toBe(1)
    expect(events.some((event) => event.type === "error")).toBe(true)
  }))

test("the SDK does not retry a certificate failure hidden by fetch failed", () =>
  runtime.run(async () => {
    let calls = 0
    await run(async () => {
      calls++
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }) })
    }, 2)
    expect(calls).toBe(1)
  }))

test("stream failures after content are left to the owning session", () =>
  runtime.run(async () => {
    let calls = 0
    const events = await run(async () => {
      calls++
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text" })
            controller.enqueue({ type: "text-delta", id: "text", delta: "partial" })
            controller.enqueue({
              type: "error",
              error: Object.assign(new Error("disconnected"), { code: "ECONNRESET" }),
            })
            controller.close()
          },
        }),
      }
    }, 2)
    expect(calls).toBe(1)
    expect(events.some((event) => event.type === "error")).toBe(true)
  }))

test("recording failures retain their identity despite transient causes", () =>
  runtime.run(() => {
    const error = new RolloutRecordingError(
      { message: "recording failed" },
      { cause: Object.assign(new Error("lost"), { code: "ECONNRESET" }) },
    )
    expect(normalizeProviderError(error)).toBe(error)
    expect(providerRetryable(error)).toBe(false)
  }))

test("exhausted billing quota is terminal even when represented by HTTP 429", () =>
  runtime.run(() => {
    const error = new APICallError({
      message: "quota",
      url: "https://provider.invalid",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }),
    })
    expect(providerRetryable(error)).toBe(false)
    expect(normalizeProviderError(error)).toMatchObject({ message: "quota", isRetryable: false, statusCode: 429 })
  }))

test("an exhausted SDK retry budget does not become another outer retry budget", () =>
  runtime.run(() => {
    const error = new RetryError({
      message: "Failed after 2 attempts",
      reason: "maxRetriesExceeded",
      errors: [Object.assign(new Error("connection lost"), { code: "ECONNRESET" })],
    })
    expect(providerRetryable(error)).toBe(false)
  }))

test("normalization preserves HTTP diagnostics from a plain transport error", () =>
  runtime.run(() => {
    const error = Object.assign(new Error("unavailable"), {
      statusCode: 503,
      responseHeaders: { "retry-after": "3" },
      responseBody: "upstream unavailable",
    })
    expect(normalizeProviderError(error)).toMatchObject({
      message: "unavailable",
      statusCode: 503,
      responseHeaders: { "retry-after": "3" },
      responseBody: "upstream unavailable",
      isRetryable: true,
    })
  }))

test("explicit provider KV capacity failures retain their transient classification", () =>
  runtime.run(() => {
    expect(providerRetryable({ error: { message: "no_kv_space" } })).toBe(true)
    expect(providerRetryable({ code: "no_kv_space" })).toBe(true)
    expect(providerRetryable({ error: { message: "unknown server detail" } })).toBeUndefined()
  }))

afterRuntimeTests(() => runtime.close())
