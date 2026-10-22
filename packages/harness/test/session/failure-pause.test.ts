import { afterAll, expect, test } from "bun:test"
import { APICallError, simulateReadableStream } from "ai"
import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { SessionLifecycle } from "../../src/session/lifecycle"
import { SessionManager } from "../../src/session/manager"
import { testRuntime } from "../support/runtime"

const failure = "Fixture provider refused the request"
let calls = 0
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
    throw new APICallError({
      message: failure,
      url: "https://fixture.invalid/v1/responses",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    })
  },
}
const auxiliary: LanguageModelV4 = {
  ...model,
  modelId: "auxiliary",
  async doStream() {
    return {
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          { type: "text-start", id: "reply" },
          { type: "text-delta", id: "reply", delta: "Fixture" },
          { type: "text-end", id: "reply" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }
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

test("terminal provider errors pause interactive sessions", () =>
  runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({
          workspace: null,
          title: "Failure fixture",
        })
        const before = calls
        await expect(
          SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "Answer once." }],
          }),
        ).rejects.toMatchObject({ name: "SessionTerminalError", data: { message: failure } })
        const messages = await Session.messages({ sessionID: session.id })
        const assistant = messages.findLast((message) => message.info.role === "assistant")!.info
        expect(assistant).toMatchObject({ finish: "error", error: { name: "APIError" } })
        expect(calls - before).toBe(1)
        expect(SessionManager.isRunning(session.id)).toBe(false)
        const paused = await SessionLifecycle.snapshot(session.id)
        expect(paused).toMatchObject({ reason: "failed", description: failure })
        const previous = messages.find((message) => message.info.role === "user")!
        const next = { ...previous, info: { ...previous.info, id: "new-root", rootID: "new-root" } }
        expect(SessionInvoke.selectResultMessage([...messages, next])).toBeUndefined()
      },
    }),
  ))
