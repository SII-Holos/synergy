import { expect, test } from "bun:test"
import { simulateReadableStream } from "ai"
import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV2 } from "@ai-sdk/provider"
import { z } from "zod"
import { ConfigSource } from "../../src/config/source"
import { Identifier } from "../../src/id/id"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { createUserMessage } from "../../src/session/input"
import { SessionInvoke } from "../../src/session/invoke"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { testRuntime } from "../support/runtime"

for (const mode of ["zero-complete", "override-complete", "zero-cancel", "tool-deadline", "step-deadline"] as const) {
  test(`${mode}: configured deadlines preserve execution and caller cancellation`, async () => {
    const completes = mode === "zero-complete" || mode === "override-complete"
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let observedAbort: unknown
    let calls = 0
    const text: LanguageModelV2StreamPart[] = [
      { type: "text-start", id: "reply" },
      { type: "text-delta", id: "reply", delta: "Complete." },
      { type: "text-end", id: "reply" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ]
    const stream = (chunks: LanguageModelV2StreamPart[]) => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    })
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "fixture",
      modelId: "approved",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Unexpected non-streaming fixture")
      },
      async doStream(input) {
        if (mode === "step-deadline") {
          const signal = input.abortSignal
          if (!signal) throw new Error("A model call requires cancellation")
          signal.throwIfAborted()
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        }
        return stream(
          calls++ === 0
            ? [
                { type: "tool-call", toolCallId: "deadline-call", toolName: "fixture_wait", input: "{}" },
                {
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
                },
              ]
            : text,
        )
      },
    }
    const sdk: ProviderV2 = {
      languageModel(id) {
        return id === "approved" ? model : { ...model, modelId: id, doStream: async () => stream(text) }
      },
      textEmbeddingModel() {
        throw new Error("Unexpected embedding")
      },
      imageModel() {
        throw new Error("Unexpected image")
      },
    }
    await using runtime = await testRuntime({
      register() {
        ConfigSource.register({
          resolve: async () => ({
            model: "fixture/approved",
            nano_model: "fixture/auxiliary",
            mini_model: "fixture/auxiliary",
            timeout: {
              invoke_sec: mode === "step-deadline" ? 0.02 : 0,
              tool: {
                default_sec: mode === "tool-deadline" ? 0.02 : mode === "override-complete" ? 0.01 : 0,
                ...(mode === "override-complete" ? { overrides: { fixture_wait: 0 } } : {}),
              },
            },
            provider: {
              fixture: {
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "synthetic-fixture-key", baseURL: "https://fixture.invalid/v1" },
                models: Object.fromEntries(
                  ["approved", "auxiliary"].map((id) => [
                    id,
                    {
                      id,
                      name: id,
                      release_date: "2026-10-02",
                      attachment: false,
                      reasoning: false,
                      temperature: false,
                      tool_call: true,
                      limit: { context: 128000, output: 8000 },
                      options: {},
                    },
                  ]),
                ),
              },
            },
            agent: { fixture: { mode: "all", permission: { "*": "allow" }, prompt: "Complete the fixture task." } },
          }),
        })
        ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
        const wait = Tool.define(
          "fixture_wait",
          {
            description: "Wait for an explicitly owned fixture event.",
            parameters: z.object({}),
            async execute(_, context) {
              entered.resolve()
              const abort = Promise.withResolvers<never>()
              const onAbort = () => {
                observedAbort = context.abort.reason
                abort.reject(observedAbort)
              }
              context.abort.addEventListener("abort", onAbort, { once: true })
              try {
                context.abort.throwIfAborted()
                await Promise.race([release.promise, abort.promise])
                return { title: "Released", output: "Finished after release.", metadata: {} }
              } finally {
                context.abort.removeEventListener("abort", onAbort)
              }
            },
          },
          { requiresWorkspace: false },
        )
        ToolRegistry.registerToolProvider("fixture", () => [{ ...wait, exposure: { mode: "resident" } }])
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          const session = await Session.create({ workspace: null })
          const input = {
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
            agent: "fixture",
            model: { providerID: "fixture", modelID: "approved" },
            parts: [{ type: "text" as const, text: "Perform the deadline fixture." }],
          }
          await createUserMessage(input)
          const pending = SessionInvoke.invoke(input)
          try {
            if (mode !== "step-deadline") {
              await Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Tool never entered")
                }),
              ])
              if (completes) {
                // Cross an actual timer turn: a zero-millisecond deadline would fire before release.
                await new Promise<void>((resolve) => setTimeout(resolve, 15))
                release.resolve()
              }
              if (mode === "zero-cancel") SessionInvoke.cancel(session.id)
            }
            if (mode === "step-deadline") {
              await expect(pending).rejects.toMatchObject({
                data: { errorName: "MessageAbortedError", message: "Assistant step timed out after 20ms" },
              })
              const messages = await Session.messages({ sessionID: session.id })
              expect(
                messages.some(
                  (message) => message.info.role === "assistant" && message.info.error?.name === "MessageAbortedError",
                ),
              ).toBe(true)
              return
            }
            const result = await pending
            const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
            if (completes) {
              expect(observedAbort).toBeUndefined()
              if (result.info.role !== "assistant") throw new Error("Expected an assistant result")
              expect(result.info.error).toBeUndefined()
              expect(parts.some((part) => part.type === "tool" && part.state.status === "completed")).toBe(true)
              expect(parts.some((part) => part.type === "text" && part.text === "Complete.")).toBe(true)
            } else {
              expect(observedAbort).toBeInstanceOf(DOMException)
              expect((observedAbort as DOMException).name).toBe(
                mode === "tool-deadline" ? "TimeoutError" : "AbortError",
              )
              expect(parts.some((part) => part.type === "tool" && part.state.status === "error")).toBe(true)
            }
          } finally {
            release.resolve()
            SessionInvoke.cancel(session.id)
            await pending.catch(() => {})
          }
        },
      }),
    )
  }, 30_000)
}
