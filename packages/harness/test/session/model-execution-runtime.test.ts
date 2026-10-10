import { expect, test } from "bun:test"
import type { LanguageModelV2CallOptions } from "@ai-sdk/provider"
import type { Provider as SDK } from "ai"
import { testRuntime } from "../support/runtime"
import { Provider } from "../../src/provider/provider"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { ProviderCatalogSource } from "../../src/provider/catalog-source"
import { ProviderRequestSource } from "../../src/provider/request-source"
import { ModelExecution } from "../../src/execution/model-execution"
import { AgentTurn } from "../../src/session/agent-turn"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

test.each([false, true])(
  "production same-process execution preserves isolation after upstream failure: %s",
  async (failFirst) => {
    const requests: Array<{ auth: string | null; invocation: string | null; body: unknown }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          auth: request.headers.get("authorization"),
          invocation: request.headers.get("x-invocation"),
          body: await request.json(),
        })
        return Response.json({ text: "hello", fail: failFirst && requests.length === 1 })
      },
    })
    const catalog = Provider.fromModelsDevProvider({
      id: "managed",
      name: "managed",
      env: [],
      npm: "fixture-sdk",
      api: server.url.href,
      models: {
        chat: {
          id: "chat",
          name: "chat",
          release_date: "2026-01-01",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          limit: { context: 32000, output: 8000 },
          options: {},
        },
      },
    })
    const factory: ProviderSdkSource.Factory = (options) =>
      ({
        languageModel: () => ({
          specificationVersion: "v2",
          provider: "fixture",
          modelId: "chat",
          supportedUrls: {},
          doGenerate: async () => {
            throw new Error("Only streaming is supported")
          },
          doStream: async (call: LanguageModelV2CallOptions) => {
            const fetch = options.fetch as typeof globalThis.fetch
            const response = await fetch(server.url, {
              method: "POST",
              signal: call.abortSignal,
              headers: { ...(options.headers as Record<string, string>), authorization: `Bearer ${options.apiKey}` },
              body: JSON.stringify({ prompt: call.prompt, tools: call.tools }),
            })
            const value = (await response.json()) as { text: string; fail: boolean }
            return {
              stream: new ReadableStream({
                start(output) {
                  if (value.fail) {
                    output.error(new Error("upstream connection lost"))
                    return
                  }
                  output.enqueue({ type: "text-start", id: "text" })
                  output.enqueue({ type: "text-delta", id: "text", delta: value.text })
                  output.enqueue({ type: "text-end", id: "text" })
                  output.enqueue({
                    type: "finish",
                    finishReason: "stop",
                    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
                  })
                  output.close()
                },
              }),
            }
          },
        }),
      }) as unknown as SDK
    try {
      await using runtime = await testRuntime({
        register() {
          ModelExecution.register("in-process")
          AgentTurn.setInProcessStream(undefined)
          ProviderCatalogSource.register({ providers: async () => ({ managed: catalog }) })
          ProviderSdkSource.register({ load: async () => factory, loadSync: () => factory })
          ProviderRequestSource.register({
            prepare: async ({ user }) => ({
              key: `fixture-${user.id}`,
              headers: { "x-invocation": user.id },
            }),
          })
        },
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          async fn() {
            AgentTurn.configure({ size: 2, minIdle: 0 })
            const invoke = async (id: string) => {
              const operationID = crypto.randomUUID()
              const owner = { kind: "operation" as const, scopeID: "home", operationID }
              const phases: string[] = []
              const stream = await AgentTurn.stream({
                sessionID: `ses_${id}`,
                user: { id } as AgentTurn.Input["user"],
                agent: { name: "managed", mode: "primary", permission: [], options: {} },
                model: catalog.models.chat!,
                system: ["Reply briefly."],
                messages: [{ role: "user", content: id }],
                abort: new AbortController().signal,
                toolDefinitions: [],
                recording: { owner, runID: operationID, purpose: "test" },
                usageRole: "conversation",
                onPhase: (phase) => phases.push(phase),
              })
              let text = ""
              for await (const part of stream.fullStream) if (part.type === "text-delta") text += part.text
              await stream.dispose()
              expect(text).toBe("hello")
              expect(phases).toEqual(["queued_agent", "waiting_model"])
              expect(await stream.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 })
              expect(await RolloutLedger.calls(owner, operationID)).toMatchObject([
                { usageRole: "conversation", status: "completed", transportCaptured: true },
              ])
            }
            if (failFirst) await expect(invoke("failed")).rejects.toThrow("upstream connection lost")
            await Promise.all([invoke("one"), invoke("two")])
            expect(AgentTurn.stats()).toMatchObject({ workers: 0, active: 0, queued: 0 })
            expect((await Provider.list()).managed!.key).toBeUndefined()
            expect(() => ModelExecution.register("worker")).toThrow("before opening")
          },
        }),
      )
      expect(requests.map((r) => [r.auth, r.invocation]).sort()).toEqual([
        ...(failFirst ? [["Bearer fixture-failed", "failed"]] : []),
        ["Bearer fixture-one", "one"],
        ["Bearer fixture-two", "two"],
      ])
      await using other = await testRuntime()
      expect(other.run(ModelExecution.mode)).toBe("worker")
    } finally {
      await server.stop(true)
    }
  },
)
