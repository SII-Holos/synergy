import { afterAll, expect, test } from "bun:test"
import { z } from "zod"
import { ProviderPricing } from "../../src/provider/pricing"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutTransport } from "../../src/session/rollout/transport"
import { Storage } from "../../src/storage/storage"
import { UsageQuery } from "../../src/usage/query"
import { testRuntime } from "../support/runtime"
import { pngImage } from "../support/image"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const remoteImage = "https://private-image.invalid/fixture.png?private=image-token"
const prompt = "private-image-prompt: describe these images"

const smallImage = pngImage(1)
const largeImage = pngImage(320)
const protocols = ["chat", "responses", "anthropic", "google"] as const
type Protocol = (typeof protocols)[number]

function fixture(protocol: Protocol, large = false, imageOnly = false) {
  const image = large ? largeImage : smallImage
  const data = `data:image/png;base64,${image}`
  const images = [data, remoteImage]
  const model = "fixture-vision-resolved"
  const sdk =
    protocol === "anthropic" ? "@ai-sdk/anthropic" : protocol === "google" ? "@ai-sdk/google" : "@ai-sdk/openai"
  const tokens = {
    input_tokens: 1000,
    output_tokens: 40,
    total_tokens: 1040,
    input_tokens_details: { cached_tokens: 400 },
    output_tokens_details: { reasoning_tokens: 10 },
  }
  if (protocol === "chat") {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 40,
      total_tokens: 1040,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 10 },
      private: { image: data, url: remoteImage, note: "private-provider-image-echo" },
    }
    return {
      sdk,
      model,
      request: {
        model,
        messages: [
          {
            role: "user",
            content: imageOnly
              ? [{ type: "image_url", image_url: { url: data } }]
              : [{ type: "text", text: prompt }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))],
          },
        ],
      },
      json: { model, choices: [{ message: { content: "two images" }, finish_reason: "stop" }], usage },
      events: [
        { model, choices: [{ delta: { reasoning_content: "Inspect" } }] },
        { choices: [{ delta: { content: "two images" } }] },
        { choices: [], usage },
      ],
    }
  }
  if (protocol === "responses")
    return {
      sdk,
      model,
      request: {
        model,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              ...images.map((image_url) => ({ type: "input_image", image_url, detail: "auto" })),
            ],
          },
        ],
      },
      json: { model, status: "completed", usage: tokens },
      events: [
        { type: "response.reasoning_summary_text.delta", delta: "Inspect" },
        { type: "response.output_text.delta", delta: "two images" },
        { type: "response.completed", response: { model, usage: tokens } },
      ],
    }
  if (protocol === "anthropic") {
    const usage = {
      input_tokens: 500,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 100,
      output_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
    }
    return {
      sdk,
      model,
      request: {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
              { type: "image", source: { type: "url", url: remoteImage } },
            ],
          },
        ],
      },
      json: { type: "message", model, usage },
      events: [
        { type: "message_start", message: { model, usage: { ...usage, output_tokens: 1 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "two" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: " images" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
        { type: "message_stop" },
      ],
    }
  }
  const usageMetadata = {
    promptTokenCount: 1000,
    cachedContentTokenCount: 400,
    candidatesTokenCount: 30,
    thoughtsTokenCount: 10,
    totalTokenCount: 1040,
    promptTokensDetails: [
      { modality: "TEXT", tokenCount: 200 },
      { modality: "IMAGE", tokenCount: 800 },
    ],
  }
  return {
    sdk,
    model,
    request: {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/png", data: image } },
            { fileData: { mimeType: "image/png", fileUri: remoteImage } },
          ],
        },
      ],
    },
    json: {
      modelVersion: model,
      candidates: [{ content: { parts: [{ text: "two images" }] }, finishReason: "STOP" }],
      usageMetadata,
    },
    events: [
      { modelVersion: model, candidates: [{ content: { parts: [{ text: "Inspect", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "two images" }] }, finishReason: "STOP" }], usageMetadata },
    ],
  }
}

function sse(events: unknown[], open = false) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        if (!open) controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function invoke(
  protocol: Protocol,
  responses: () => Response,
  options: { large?: boolean; imageOnly?: boolean; cancel?: boolean; retries?: number } = {},
) {
  const input = fixture(protocol, options.large, options.imageOnly)
  const owner = { kind: "operation" as const, scopeID: crypto.randomUUID(), operationID: crypto.randomUUID() }
  const received: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(await request.json())
      return responses()
    },
  })
  let error: unknown
  try {
    await RolloutCall.execute(
      {
        owner,
        runID: "vision",
        kind: "chat",
        purpose: "model.validation",
        request: z.json().parse(input.request),
        model: {
          providerID: protocol,
          modelID: "fixture-vision",
          sdk: input.sdk,
          billingMode: "api",
          pricing: ProviderPricing.resolve({
            providerID: protocol,
            modelID: "fixture-vision",
            source: "configuration",
            cost: { input: 3, output: 15, cache_read: 1, cache_write: 4 },
          }),
        },
      },
      async () => {
        for (let attempt = 0; ; attempt++) {
          const response = await RolloutTransport.sdkFetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input.request),
            signal: AbortSignal.timeout(10000),
          })
          if (options.cancel) {
            const reader = response.body!.getReader()
            await reader.read()
            await reader.cancel()
            reader.releaseLock()
            throw new DOMException("Fixture image request cancelled", "AbortError")
          }
          await response.text()
          if (!response.ok) {
            if (attempt < (options.retries ?? 0)) continue
            throw new Error(`Vision fixture HTTP ${response.status}`)
          }
          return { value: undefined, response: { status: response.status } }
        }
      },
    )
  } catch (cause) {
    error = cause
  } finally {
    await server.stop(true)
  }
  expect(received.length).toBeGreaterThan(0)
  for (const request of received) expect(request).toEqual(input.request)
  const filter = { scopeID: owner.scopeID }
  const summary = await UsageQuery.summary(filter)
  const records = await UsageQuery.records(filter)
  const compact = JSON.stringify(records)
  for (const secret of [smallImage, largeImage.slice(0, 100), remoteImage, prompt, "private-provider-image-echo"])
    expect(compact).not.toContain(secret)
  await Storage.removeTree(["operations", owner.scopeID, owner.operationID])
  expect((await UsageQuery.summary(filter)).accounting).toEqual(summary.accounting)
  return { summary, records, error, received }
}

for (const protocol of protocols) {
  for (const streaming of [false, true]) {
    test(`${protocol} retains exact image-inclusive usage for mixed text and multiple images (${streaming ? "stream" : "JSON"})`, () =>
      runtime.run(async () => {
        const input = fixture(protocol)
        const result = await invoke(protocol, () => (streaming ? sse(input.events) : Response.json(input.json)))
        expect(result.error).toBeUndefined()
        expect(result.summary.accounting.tokens.input.total).toBe(1000)
        expect(result.summary.accounting.tokens.output.total).toBe(40)
        expect(result.summary.accounting.tokens.total.total).toBe(1040)
        expect(result.summary.cache.ratio).toBe(0.4)
        expect(result.summary.accounting.apiEstimate.total).toBeCloseTo(protocol === "anthropic" ? 0.0029 : 0.0028)
        expect(result.summary.latestRequest?.responseModel).toBe(input.model)
        expect(result.summary.latestRequest?.timing?.streaming).toBe(streaming)
        expect(result.summary.latency.request.samples).toBe(1)
        if (!streaming) expect(result.summary.rates.generation.value).toBeNull()
      }))
  }
}

test("a large valid PNG upload does not turn byte size into estimated input tokens", () =>
  runtime.run(async () => {
    expect(Buffer.from(largeImage, "base64").byteLength).toBeGreaterThan(256 * 1024)
    const input = fixture("chat", true)
    const result = await invoke("chat", () => sse(input.events), { large: true })
    expect(result.error).toBeUndefined()
    expect(result.summary.accounting.tokens.total.total).toBe(1040)
    expect(result.summary.accounting.attempts).toBe(1)
  }))

test("an image response without usage stays unknown instead of counting image data or URLs", () =>
  runtime.run(async () => {
    const result = await invoke("chat", () =>
      Response.json({ model: "fixture-vision-resolved", choices: [{ message: { content: "two images" } }] }),
    )
    expect(result.error).toBeUndefined()
    expect(result.summary.accounting.tokens.input).toEqual({ known: 0, total: null, unknown: 1 })
    expect(result.summary.accounting.apiEstimate.total).toBeNull()
  }))

test("rejected images retain an unknown attempt and HTTP outcome", () =>
  runtime.run(async () => {
    const result = await invoke("chat", () =>
      Response.json({ error: { message: "Unsupported image format" } }, { status: 400 }),
    )
    expect(result.error).toBeInstanceOf(Error)
    expect(result.records.items.find((record) => record.kind === "attempt")).toMatchObject({
      status: "failed",
      httpStatus: 400,
    })
    expect(result.summary.accounting.tokens.total.total).toBeNull()
    expect(result.summary.accounting.apiEstimate.total).toBeNull()
  }))

test("a retried image request counts both physical attempts without duplicating the successful image tokens", () =>
  runtime.run(async () => {
    let request = 0
    const result = await invoke(
      "chat",
      () =>
        request++ === 0
          ? Response.json({ error: { message: "Retry later" } }, { status: 429 })
          : sse(fixture("chat").events),
      { retries: 1 },
    )
    expect(result.error).toBeUndefined()
    expect(result.received).toHaveLength(2)
    expect(result.summary.accounting.tokens.total).toEqual({ known: 1040, unknown: 1, total: null })
    expect(result.summary.accounting.attempts).toBe(2)
    expect(result.summary.outcomes.transportRetries).toBe(1)
    expect(result.summary.accounting.apiEstimate.known).toBeCloseTo(0.0028)
  }))

test("cancelling image analysis preserves partial usage separately from final billing", () =>
  runtime.run(async () => {
    const input = fixture("anthropic")
    const result = await invoke("anthropic", () => sse(input.events.slice(0, 2), true), { cancel: true })
    expect(result.error).toMatchObject({ name: "AbortError" })
    expect(result.records.items.find((record) => record.kind === "attempt")).toMatchObject({
      status: "cancelled",
      usageFinal: false,
    })
    expect(result.summary.accounting.tokens.total.total).toBeNull()
    expect(result.summary.provisional.tokens.input.known).toBe(1000)
    expect(result.summary.accounting.apiEstimate.total).toBeNull()
  }))

test("a single image without user text is still counted from provider usage", () =>
  runtime.run(async () => {
    const result = await invoke("chat", () => Response.json(fixture("chat").json), { imageOnly: true })
    expect(result.error).toBeUndefined()
    expect(result.summary.accounting.tokens.input.total).toBe(1000)
    expect(result.summary.accounting.tokens.output.total).toBe(40)
  }))
