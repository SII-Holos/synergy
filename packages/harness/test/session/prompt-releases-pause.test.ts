import { afterAll, expect, test } from "bun:test"
import { APICallError, simulateReadableStream } from "ai"
import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { testRuntime } from "../support/runtime"

const failure = "Fixture provider refused the request"
let calls = 0

function streamed(text: string) {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        { type: "text-start" as const, id: "reply" },
        { type: "text-delta" as const, id: "reply", delta: text },
        { type: "text-end" as const, id: "reply" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }),
  }
}

const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "fixture",
  modelId: "fixture",
  supportedUrls: {},
  async doGenerate() {
    throw new Error("Unexpected non-streaming call")
  },
  async doStream() {
    calls++
    if (calls === 1)
      throw new APICallError({
        message: failure,
        url: "https://fixture.invalid/v1/responses",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      })
    return streamed("Recovered after the pause.")
  },
}
const auxiliary: LanguageModelV4 = {
  ...model,
  modelId: "auxiliary",
  async doStream() {
    return streamed("Fixture")
  },
}
const sdk: ProviderV4 & { responses: (id: string) => LanguageModelV4 } = {
  specificationVersion: "v4",
  languageModel: (id) => (id === "auxiliary" ? auxiliary : model),
  responses: (id) => (id === "auxiliary" ? auxiliary : model),
  embeddingModel() {
    throw new Error("Unexpected embedding call")
  },
  imageModel() {
    throw new Error("Unexpected image call")
  },
}
const runtime = await testRuntime({
  env: {
    SYNERGY_CONFIG_CONTENT: JSON.stringify({
      model: "fixture/fixture",
      nano_model: "fixture/auxiliary",
      mini_model: "fixture/auxiliary",
      provider: {
        fixture: {
          profile: "openai-codex",
          npm: "@ai-sdk/openai",
          options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
          models: Object.fromEntries(
            ["fixture", "auxiliary"].map((id) => [
              id,
              {
                id,
                name: "Fixture",
                release_date: "2026-10-01",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: false,
                limit: { context: 128000, output: 8000 },
                options: {},
              },
            ]),
          ),
        },
      },
      agent: { fixture: { mode: "all", prompt: "Answer the request." } },
    }),
  },
  register() {
    ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
  },
})
afterAll(() => runtime.close())

test("an explicit prompt takes the session back instead of replaying the previous error", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ workspace: null, title: "Prompt after failure" })

        await expect(
          SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "First attempt." }],
          }),
        ).rejects.toMatchObject({ name: "SessionTerminalError", data: { message: failure } })
        expect((await SessionLifecycle.snapshot(session.id))?.reason).toBe("failed")

        const reply = await SessionInvoke.invoke({
          sessionID: session.id,
          agent: "fixture",
          parts: [{ type: "text", text: "Second attempt." }],
        })

        // The second turn owns its outcome: it must not inherit the first
        // turn's terminal error, and it must run its own model call.
        expect(reply.info.role).toBe("assistant")
        expect((reply.info as { error?: unknown }).error).toBeUndefined()
        expect((reply.info as { finish?: string }).finish).toBe("stop")
        expect(calls).toBe(2)
        expect(await SessionLifecycle.snapshot(session.id)).toBeUndefined()
      },
    }),
  ))
