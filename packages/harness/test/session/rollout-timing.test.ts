import { expect, test } from "bun:test"
import { RolloutTiming } from "../../src/session/rollout/timing"
import { RolloutTransport } from "../../src/session/rollout/transport"

test("generation rate requires observed output coverage and aggregates numerators and durations", () => {
  const timing: RolloutTiming.Info = {
    source: "transport",
    sentAt: 1000,
    firstContentAt: 1100,
    lastContentAt: 1300,
    endedAt: 1500,
    ttftMs: 100,
    generationMs: 200,
    requestMs: 500,
    contentEvents: 2,
    reasoningObserved: false,
    streaming: true,
  }
  expect(RolloutTiming.rates(timing, { total: 100, reasoning: 0 }).generation.value).toBe(500)
  expect(RolloutTiming.rates(timing, { total: 100, reasoning: 50 }).generation.value).toBeNull()
  expect(RolloutTiming.rates({ ...timing, contentEvents: 1 }, { total: 100, reasoning: 0 }).generation.value).toBeNull()
  expect(RolloutTiming.rates({ ...timing, streaming: false }, { total: 100, reasoning: 0 }).generation.value).toBeNull()
  expect(
    RolloutTiming.rates({ ...timing, backpressured: true }, { total: 100, reasoning: 0 }).generation.reasons,
  ).toEqual({ capture_backpressure: 1 })
  const combined = RolloutTiming.merge([
    RolloutTiming.rates(timing, { total: 100, reasoning: 0 }).generation,
    RolloutTiming.rates({ ...timing, generationMs: 800 }, { total: 100, reasoning: 0 }).generation,
  ])
  expect(combined).toMatchObject({ value: 200, tokens: 200, milliseconds: 1000, samples: 2, excluded: 0 })
})

test.each(["text/event-stream", "application/json", undefined])(
  "transport detects content before coalescing with media type %s",
  async (mediaType) => {
    const events: RolloutTransport.Event[] = []
    const payloads = [
      { choices: [{ delta: { content: "" } }] },
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] },
      { usage: { completion_tokens: 10 } },
    ]
    let index = 0
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (index === payloads.length) return controller.close()
          await Bun.sleep(5)
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payloads[index++])}\n\n`))
        },
      },
      { highWaterMark: 0 },
    )
    await RolloutTransport.provide(
      async (event) => {
        events.push(event)
        if (event.type === "chunk" || event.type === "body-end") await Bun.sleep(80)
      },
      async () =>
        (
          await RolloutTransport.fetch(
            async () =>
              new Response(source, {
                headers: mediaType ? { "content-type": mediaType } : {},
              }),
            "https://fixture.test",
          )
        ).text(),
    )
    const end = events.findLast((event) => event.type === "attempt-end")
    expect(end?.timing).toMatchObject({ contentEvents: 2, reasoningObserved: true, streaming: true })
    expect(end?.timing?.generationMs).toBeLessThan(70)
    expect(end?.timing?.requestMs).toBeLessThan(100)
    expect(end?.timing?.ttftMs).toBeGreaterThan(0)
    const headers = events.find((event) => event.type === "response")?.timing
    expect(end?.timing?.headersAt).toBe(headers?.headersAt)
    expect(end?.timing?.headersMs).toBe(headers?.headersMs)
  },
)

test("slow sent/header acknowledgement does not inflate first-content time", async () => {
  const events: RolloutTransport.Event[] = []
  await RolloutTransport.provide(
    async (event) => {
      events.push(event)
      if (event.type === "attempt-sent" || event.type === "response") await Bun.sleep(80)
    },
    async () => {
      const response = await RolloutTransport.fetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await Bun.sleep(5)
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n'))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        "https://fixture.test",
      )
      await response.text()
    },
  )
  const end = events.findLast((event) => event.type === "attempt-end")
  expect(end?.timing?.ttftMs).toBeLessThan(70)
  expect(end?.timing?.requestMs).toBeLessThan(70)
})
