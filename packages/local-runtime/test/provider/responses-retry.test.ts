import { afterAll, expect, spyOn, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { LLM } from "@ericsanchezok/synergy-harness/test/internal/session/llm"
import { AgentTurnProtocol } from "@ericsanchezok/synergy-harness/test/internal/session/agent-turn/protocol"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionRetry } from "@ericsanchezok/synergy-harness/session/retry"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

const model: Provider.Model = {
  id: "fixture-model",
  providerID: "openai-codex",
  name: "Fixture",
  family: "test",
  api: { id: "fixture-model", url: "https://provider.invalid", npm: "@ai-sdk/openai" },
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

async function run(events: unknown[], holdOpen = false) {
  let requests = 0
  let cancelled = false
  const sdk = createOpenAI({
    apiKey: "fixture",
    baseURL: "https://provider.invalid",
    fetch: Object.assign(
      async () => {
        requests++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of events)
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
              if (!holdOpen) controller.close()
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      { preconnect() {} },
    ),
  })
  using language = spyOn(Provider, "getLanguage").mockResolvedValue(sdk.responses(model.id))
  const result = await LLM.stream({
    user: { id: "msg_fixture" },
    sessionID: "ses_fixture",
    agent: { name: "fixture" },
    model,
    system: [],
    tools: {},
    abort: new AbortController().signal,
    retries: 0,
    messages: [{ role: "user", content: "test" }],
    prepared: {
      system: [],
      baseSystemLength: 0,
      params: { options: {} },
      provider: { profileID: "openai-codex", options: {}, timeouts: { ttfbMs: 1000, idleMs: 1000, wallMs: 2000 } },
    },
  })
  const owned = LLM.takeFullStream(result)
  const received = []
  try {
    for await (const event of owned.stream) received.push(event)
  } catch (error) {
    received.push({ type: "error" as const, error })
  } finally {
    await owned.dispose()
  }
  const errors = received
    .filter((event) => event.type === "error")
    .map((event) => {
      const wire = AgentTurnProtocol.serializeError(event.error)
      return MessageV2.fromError(AgentTurnProtocol.deserializeError(wire), { providerID: "openai-codex" })
    })
  return { errors, received, requests, cancelled }
}

test.each(["error", "response.failed"])(
  "the actual SDK preserves %s classification and retry hints through IPC",
  (type) =>
    runtime.run(async () => {
      const error = {
        type: "service_unavailable_error",
        code: "server_is_overloaded",
        message: "Our servers are currently overloaded. Please try again later.",
        headers: { "Retry-After": "4" },
      }
      const event = type === "error" ? { type, sequence_number: 2, error } : { type, response: { error } }
      const result = await run([event], true)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({
        name: "APIError",
        data: { message: error.message, isRetryable: true, responseHeaders: { "retry-after": "4" } },
      })
      expect(SessionRetry.delay(1, result.errors[0] as MessageV2.APIError)).toBe(4000)
      expect(SessionRetry.retryable(result.errors[0])?.maxAttempts).toBe(10)
      expect(result.requests).toBe(1)
      expect(result.cancelled).toBe(true)
      expect(result.received.some((event) => event.type === "raw")).toBe(false)
    }),
)

test("quota and policy errors stay terminal when the SDK would otherwise discard response.failed", () =>
  runtime.run(async () => {
    for (const code of ["usage_limit_reached", "insufficient_quota", "context_length_exceeded", "invalid_prompt"]) {
      const result = await run([{ type: "response.failed", response: { error: { code, message: "Unavailable" } } }])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({ name: "APIError", data: { isRetryable: false } })
      expect(SessionRetry.retryable(result.errors[0])).toBeUndefined()
      expect(result.requests).toBe(1)
    }
  }))

test("flat capacity errors and slow_down failures reach the same retry owner", () =>
  runtime.run(async () => {
    for (const event of [
      { type: "error", message: "Selected model is at capacity. Please try a different model." },
      { type: "response.failed", response: { error: { code: "slow_down", message: "Please wait" } } },
    ]) {
      const result = await run([event])
      expect(result.errors).toHaveLength(1)
      expect(SessionRetry.retryable(result.errors[0])).toBeDefined()
    }
  }))

test("normal Responses output passes through without exporting raw provider events", () =>
  runtime.run(async () => {
    const result = await run([
      { type: "response.created", response: { id: "resp_fixture", created_at: 1, model: model.id } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "answer" } },
      { type: "response.output_text.delta", item_id: "answer", delta: "answer" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "answer", content: [] } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
    expect(result.errors).toHaveLength(0)
    expect(result.received.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual([
      "answer",
    ])
    expect(result.received.some((event) => event.type === "raw")).toBe(false)
  }))

test("unknown failed responses remain failures without gaining retries from an advisory header", () =>
  runtime.run(async () => {
    const result = await run([
      { type: "response.failed", response: { error: { code: "unknown_failure", headers: { "retry-after": "1" } } } },
    ])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ name: "APIError", data: { isRetryable: false } })
    expect(SessionRetry.retryable(result.errors[0])).toBeUndefined()
    expect(result.requests).toBe(1)
  }))
