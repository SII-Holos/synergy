import { expect, test } from "bun:test"
import { simulateReadableStream } from "ai"
import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV2 } from "@ai-sdk/provider"
import { z } from "zod"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionContextContributions } from "../../src/session/context-contributions"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { RuntimeAdvisory } from "../../src/session/runtime-context"
import { SessionCortexRuntime } from "../../src/session/cortex-runtime"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { testRuntime } from "../support/runtime"
import { configureRuntimeEndpoint } from "../../src/util/runtime-endpoint"

for (const profile of ["openai-codex", "openai", "anthropic"] as const) {
  test(`${profile}: real loop preserves advisory authority, history order and latest memory`, async () => {
    const prompts: Parameters<LanguageModelV2["doStream"]>[0]["prompt"][] = []
    let calls = 0
    let executed = 0
    let fact = "The complete current fact is ALPHA-419."
    const permanent = "The permanent complete reference is FIXED-205."
    let progress = 0
    const recallQueries: string[] = []
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Unexpected non-streaming call")
      },
      async doStream(input) {
        const protocol = input.prompt
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n")
        // Only the durable observation layout emits <context-source> entries, so the state-semantics
        // protocol is present exactly when one is in this prompt. The case below switches providers
        // mid-session, so pair the two facts instead of assuming one profile for the whole test.
        const carriesObservation = JSON.stringify(input.prompt).includes("<context-source ")
        expect(protocol.split("<runtime-context-protocol>").length - 1).toBe(carriesObservation ? 1 : 0)
        expect(JSON.stringify(input.prompt.filter((message) => message.role !== "system"))).not.toContain(
          "<runtime-context-protocol>",
        )
        prompts.push(structuredClone(input.prompt))
        const chunks: LanguageModelV2StreamPart[] = [0, 4].includes(calls++)
          ? [
              ...[1, 2, 3, 4].map((index): LanguageModelV2StreamPart => ({
                type: "tool-call",
                toolCallId: `step-${index}`,
                toolName: "fixture_step",
                input: "{}",
              })),
              {
                type: "finish",
                finishReason: "tool-calls",
                usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
              },
            ]
          : [
              { type: "text-start", id: "reply" },
              { type: "text-delta", id: "reply", delta: "Completed." },
              { type: "text-end", id: "reply" },
              { type: "finish", finishReason: "stop", usage: { inputTokens: 60, outputTokens: 5, totalTokens: 65 } },
            ]
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }
      },
    }
    const auxiliary: LanguageModelV2 = {
      ...model,
      modelId: "auxiliary",
      async doStream() {
        const chunks: LanguageModelV2StreamPart[] = [
          { type: "text-start", id: "aux" },
          { type: "text-delta", id: "aux", delta: "Fixture" },
          { type: "text-end", id: "aux" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]
        return { stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) }
      },
    }
    const sdk: ProviderV2 & { responses: (id: string) => LanguageModelV2 } = {
      languageModel: (id) => (id === "auxiliary" ? auxiliary : model),
      responses: (id) => (id === "auxiliary" ? auxiliary : model),
      textEmbeddingModel() {
        throw new Error("Unexpected embedding")
      },
      imageModel() {
        throw new Error("Unexpected image")
      },
    }
    const config = {
      model: "fixture/fixture",
      nano_model: "fixture/auxiliary",
      mini_model: "fixture/auxiliary",
      provider: {
        fixture: {
          profile,
          npm: profile === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai",
          options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
          models: {
            auxiliary: {
              id: "auxiliary",
              name: "Auxiliary",
              release_date: "2026-10-01",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: false,
              limit: { context: 128000, output: 8000 },
              options: {},
            },
            fixture: {
              id: "fixture",
              name: "Fixture",
              release_date: "2026-10-01",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              limit: { context: 128000, output: 8000 },
              options: {},
            },
          },
        },
      },
      agent: {
        fixture: { mode: "all", permission: { "*": "allow", doom_loop: "deny" }, prompt: "Complete the fixture task." },
      },
    }
    await using runtime = await testRuntime({
      env: {
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          ...config,
          provider: {
            ...config.provider,
            alternate: { ...config.provider.fixture, profile: "anthropic" },
          },
        }),
      },
      register() {
        ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
        SessionContextContributions.register("fixture-memory", {
          refresh: "model",
          async contribute(input) {
            expect(input.agentIdentity).toMatchObject({ registrationKey: "fixture", source: "config" })
            const lastUser = input.messages.findLast((message) => message.info.role === "user")
            recallQueries.push(lastUser ? MessageV2.extractText(lastUser.parts) : "")
            return {
              context: [permanent, fact].join("\n"),
              injection: { fixture: "complete" },
              knowledge: {
                guidance: "Apply the selected references.",
                entries: [
                  { id: "fixed", text: permanent, selection: "always" },
                  { id: "fact", text: fact, selection: "contextual" },
                ],
              },
            }
          },
        })
        SessionCortexRuntime.register({
          async delegatedTask() {
            return undefined
          },
          async runningTaskRows() {
            return [
              {
                id: "task_fixture",
                agent: "worker",
                description: "Independent work",
                startedAt: Date.now() - ++progress * 20_000,
                health: progress % 2 ? "active" : "tool-running",
                lastTool: progress % 2 ? "read" : "grep",
                lastToolStatus: "running",
              },
            ]
          },
          async activeTaskRows() {
            return []
          },
          async reconcileParentNotifications() {},
          async cancelAllForParent() {},
          pluginTaskSnapshot() {
            return undefined
          },
          taskInfo() {
            return undefined
          },
          async waitForTask() {},
        })
        const tool = Tool.define(
          "fixture_step",
          {
            description: "Update the current fact.",
            parameters: z.object({}),
            async execute() {
              executed++
              fact = "The complete current fact is BETA-827."
              return { title: "Updated", output: "A real tool continuation.", metadata: {} }
            },
          },
          { requiresWorkspace: false },
        )
        ToolRegistry.registerToolProvider("fixture", () => [{ ...tool, exposure: { mode: "resident" } }])
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          configureRuntimeEndpoint({ hostname: "127.0.0.1", port: 45173, generation: "fixture-listener" })
          const session = await Session.create({ workspace: null, title: "Fixture" })
          await SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            model: { providerID: "fixture", modelID: "fixture" },
            parts: [{ type: "text", text: "Use the tool once and finish." }],
          })
          expect(prompts).toHaveLength(2)
          expect(executed).toBe(4)
          expect(recallQueries).toEqual(["Use the tool once and finish.", "Use the tool once and finish."])
          expect(JSON.stringify(prompts[0])).toContain("ALPHA-419")
          expect(JSON.stringify(prompts[1])).toContain("BETA-827")
          const serialized = prompts.map((prompt) => JSON.stringify(prompt))
          for (const text of serialized) {
            expect(text.match(/<synergy-runtime>/g)).toHaveLength(1)
            expect(text).toContain("Backend URL: http://127.0.0.1:45173")
            expect(text.indexOf("<synergy-runtime>")).toBeGreaterThan(text.indexOf("<attachment-presentation>"))
            expect(text.indexOf("<synergy-runtime>")).toBeLessThan(
              text.indexOf("ALPHA-419") === -1 ? text.indexOf("BETA-827") : text.indexOf("ALPHA-419"),
            )
          }
          const systemPrefix = (prompt: (typeof prompts)[number]) =>
            prompt.filter((message) => message.role === "system")
          expect(systemPrefix(prompts[1]!)).toEqual(systemPrefix(prompts[0]!))
          expect(JSON.stringify(systemPrefix(prompts[0]!))).not.toContain("<synergy-runtime>")
          const runtimeMessage = prompts[0]!.find((message) => JSON.stringify(message).includes("<synergy-runtime>"))!
          expect(runtimeMessage.role).toBe("user")
          const messages = await Session.messages({ sessionID: session.id })
          const events = messages.filter((m) => RuntimeAdvisory.read(m.info))
          expect(messages.filter((m) => m.info.role === "user" && m.info.isRoot)).toHaveLength(1)
          if (profile === "openai-codex") {
            expect(events).toHaveLength(2)
            // Static policy lives in the cached system prefix, so the durable observation starts
            // with the volatile host identity instead of replaying those blocks as advisory sources.
            expect(RuntimeAdvisory.read(events[0]!.info)!.sources[0]!.id).toBe("synergy-runtime")
            const observed = events.flatMap((event) =>
              RuntimeAdvisory.read(event.info)!.sources.map((source) => source.id),
            )
            expect(observed).not.toContain("tool-intent")
            expect(observed).not.toContain("attachment-guidance")
            expect(
              RuntimeAdvisory.read(events[1]!.info)!.sources.some((source) => source.id === "synergy-runtime"),
            ).toBe(false)
            const first = prompts[0]!
            expect(prompts[1]!.slice(0, first.length)).toEqual(first)
            expect(JSON.stringify(prompts[1]).split(permanent)).toHaveLength(2)
            expect(
              events
                .flatMap((event) => RuntimeAdvisory.read(event.info)!.sources)
                .filter((source) => source.id === "cortex:task_fixture"),
            ).toHaveLength(1)
            for (const event of events) {
              const position = messages.indexOf(event)
              expect(messages[position + 1]!.info.role).toBe("assistant")
              expect(event.info.visible).toBe(false)
            }
            fact = "The complete current fact is GAMMA-613."
            await SessionInvoke.invoke({
              sessionID: session.id,
              agent: "fixture",
              model: { providerID: "alternate", modelID: "fixture" },
              parts: [{ type: "text", text: "Continue with the selected provider." }],
            })
            expect(prompts).toHaveLength(3)
            expect(JSON.stringify(prompts[2])).toContain("GAMMA-613")
            expect(JSON.stringify(prompts[2])).not.toContain("ALPHA-419")
            expect(JSON.stringify(prompts[2])).not.toContain("BETA-827")
            expect(
              (await Session.messages({ sessionID: session.id })).filter((m) => RuntimeAdvisory.read(m.info)),
            ).toHaveLength(2)
            fact = "The complete current fact is DELTA-951."
            await SessionInvoke.invoke({
              sessionID: session.id,
              agent: "fixture",
              model: { providerID: "fixture", modelID: "fixture" },
              parts: [{ type: "text", text: "Continue after switching back." }],
            })
            expect(JSON.stringify(prompts[3])).toContain("DELTA-951")
            await SessionInvoke.invoke({
              sessionID: session.id,
              agent: "fixture",
              model: { providerID: "fixture", modelID: "fixture" },
              parts: [{ type: "text", text: "Continue with the same references and use the tool." }],
            })
            expect(prompts).toHaveLength(6)
            expect(prompts[5]!.slice(0, prompts[4]!.length)).toEqual(prompts[4])
            expect(JSON.stringify(prompts[5]).split(permanent)).toHaveLength(2)
            const retained = (await Session.messages({ sessionID: session.id })).flatMap(
              (message) => RuntimeAdvisory.read(message.info)?.sources ?? [],
            )
            expect(retained.filter((source) => source.id === "cortex:task_fixture")).toHaveLength(1)
            expect(retained.filter((source) => source.id === "time")).toHaveLength(2)
            expect(
              retained
                .filter((source) => source.id === "time")
                .every((source) => source.kind === "event" && source.state === "present"),
            ).toBe(true)
          } else {
            expect(events).toHaveLength(0)
            expect(JSON.stringify(prompts[1])).not.toContain("ALPHA-419")
          }
        },
      }),
    )
  }, 20_000)
}
