import { expect, test } from "bun:test"
import { generateText, streamText } from "ai"
import { loadBundledProvider } from "@ericsanchezok/synergy-local-runtime/provider/sdk-registry"
import { OrganizationGatewayProtocol as Gateway } from "@ericsanchezok/synergy-organization-protocol"
import { executionFixture } from "../../../organization/test/support/execution"

for (const protocol of ["openai-compatible", "anthropic-compatible"] as const)
  test(`${protocol} fixed SDK reads JSON and SSE through an admitted gateway with no upstream credentials`, async () => {
    const observed: {
      path: string
      authorization: string | null
      apiKey: string | null
      version: string | null
      beta: string | null
      model: unknown
    }[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = (await request.json()) as { model: string; stream?: boolean }
        observed.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          version: request.headers.get("anthropic-version"),
          beta: request.headers.get("anthropic-beta"),
          model: input.model,
        })
        if (!input.stream)
          return Response.json(
            protocol === "openai-compatible"
              ? {
                  id: "chatcmpl-fixture",
                  created: 1,
                  model: "fixture-model",
                  choices: [
                    { index: 0, message: { role: "assistant", content: "Fixture answer" }, finish_reason: "stop" },
                  ],
                  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
                }
              : {
                  id: "msg_fixture",
                  type: "message",
                  role: "assistant",
                  model: "fixture-model",
                  content: [{ type: "text", text: "Fixture answer" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 4, output_tokens: 2 },
                },
          )
        const events =
          protocol === "openai-compatible"
            ? [
                {
                  id: "chatcmpl-fixture",
                  created: 1,
                  model: "fixture-model",
                  choices: [{ index: 0, delta: { role: "assistant", content: "Fixture answer" }, finish_reason: null }],
                },
                {
                  id: "chatcmpl-fixture",
                  created: 1,
                  model: "fixture-model",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
                },
              ]
            : [
                {
                  type: "message_start",
                  message: {
                    id: "msg_fixture",
                    type: "message",
                    role: "assistant",
                    model: "fixture-model",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 4, output_tokens: 0 },
                  },
                },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture answer" } },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { output_tokens: 2 },
                },
                { type: "message_stop" },
              ]
        const data =
          events
            .map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
            .join("") + (protocol === "openai-compatible" ? "data: [DONE]\n\n" : "")
        return new Response(data, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      await using f = await executionFixture({ protocol, endpoint: new URL("/v1", upstream.url).href })
      const factory = await loadBundledProvider(
        protocol === "openai-compatible" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic",
      )
      if (!factory) throw new Error("Fixed model SDK missing")
      async function model(callID: string) {
        const proof = await f.proof(callID)
        const authorization = await f.run(() => f.gateway.calls.reserve(proof))
        return factory!({
          name: "organization",
          apiKey: Gateway.encode(authorization),
          baseURL: new URL(`/runtime/v1/gateway/models/${authorization.permit.resourceID}`, f.baseUrl).href,
          headers: protocol === "anthropic-compatible" ? { "anthropic-beta": "structured-outputs-2025-11-13" } : {},
        }).languageModel("fixture-model")
      }
      const complete = await generateText({
        model: await model("json"),
        prompt: "Fixture prompt",
        maxOutputTokens: 32,
        maxRetries: 0,
      })
      expect(complete.text).toBe("Fixture answer")
      expect(complete.usage.inputTokens).toBe(4)
      const stream = streamText({
        model: await model("stream"),
        prompt: "Fixture prompt",
        maxOutputTokens: 32,
        maxRetries: 0,
      })
      expect(await stream.text).toBe("Fixture answer")
      expect((await stream.usage).outputTokens).toBe(2)
      expect(observed).toHaveLength(2)
      for (const request of observed)
        expect(request).toEqual(
          protocol === "openai-compatible"
            ? {
                path: "/v1/chat/completions",
                authorization: "Bearer private-upstream-key",
                apiKey: null,
                version: null,
                beta: null,
                model: "fixture-model",
              }
            : {
                path: "/v1/messages",
                authorization: null,
                apiKey: "private-upstream-key",
                version: "2023-06-01",
                beta: "structured-outputs-2025-11-13",
                model: "fixture-model",
              },
        )
    } finally {
      await upstream.stop(true)
    }
  })
