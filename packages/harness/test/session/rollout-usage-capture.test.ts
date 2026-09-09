import { expect, test } from "bun:test"
import { RolloutUsageCapture } from "../../src/session/rollout/usage-capture"

const encoder = new TextEncoder()
test("OpenRouter account charges are separate from upstream cost and cached writes", () => {
  const capture = RolloutUsageCapture.create("@openrouter/ai-sdk-provider", "application/json", "openrouter")
  capture.append(
    encoder.encode(
      JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
          cost: 0.012,
          cost_details: { upstream_inference_cost: 0.01 },
        },
      }),
    ),
  )
  const usage = capture.finish()
  expect(usage.input).toEqual({ total: 100, uncached: 50, cacheRead: 20, cacheWrite: 30 })
  expect(usage.reported).toEqual({ amount: 0.012, currency: "USD", source: "openrouter.usage.cost" })
  const untrusted = RolloutUsageCapture.create("@ai-sdk/openai-compatible", "application/json", "custom")
  untrusted.append(encoder.encode('{"usage":{"cost":123}}'))
  expect(untrusted.finish().reported).toBeNull()
})
test("merges Anthropic usage across start and delta events without retaining message content", () => {
  const capture = RolloutUsageCapture.create("@ai-sdk/anthropic", "text/event-stream")
  const events =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":80}}\n\n'
  for (const byte of encoder.encode(events)) capture.append(Uint8Array.of(byte))
  const usage = capture.finish()
  expect(usage.input.total).toBe(100)
  expect(usage.output.total).toBe(80)
  expect(usage.raw).toEqual({
    input_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 80,
  })
})

test("captures Responses usage from a final event after oversized content", () => {
  const capture = RolloutUsageCapture.create("@ai-sdk/openai", "text/event-stream")
  capture.append(encoder.encode("data: " + "x".repeat(2 * RolloutUsageCapture.MAX_EVENT_CHARS) + "\n\n"))
  capture.append(
    encoder.encode(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":2},"output_tokens":5}}}\n\n',
    ),
  )
  expect(capture.finish().input.uncached).toBe(8)
})

test("supports JSON and preserves absent usage as unknown", () => {
  const json = RolloutUsageCapture.create("@ai-sdk/google", "application/json")
  json.append(
    encoder.encode(
      '{"usageMetadata":{"promptTokenCount":5,"cachedContentTokenCount":0,"candidatesTokenCount":4,"thoughtsTokenCount":1}}',
    ),
  )
  expect(json.finish().output.total).toBe(5)
  const unknown = RolloutUsageCapture.create("custom-sdk", "application/json")
  unknown.append(encoder.encode('{"result":"without usage"}'))
  expect(unknown.finish().raw).toBeNull()
  expect(unknown.finish().input.total).toBeNull()
})
