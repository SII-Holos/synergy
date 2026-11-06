import { expect, spyOn, test } from "bun:test"
import { simulateReadableStream } from "ai"
import type { LanguageModelV4, LanguageModelV4StreamPart, ProviderV4 } from "@ai-sdk/provider"
import { z } from "zod"
import { ProviderSdkSource } from "../../src/provider/sdk-source"
import { Provider } from "../../src/provider/provider"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { LoopJob } from "../../src/session/loop-job"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { SessionPluginHooks } from "../../src/session/plugin-hooks"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { SessionCompaction } from "../../src/session/compaction"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { SessionAbort } from "../../src/session/abort"
import { SessionInbox } from "../../src/session/inbox"
import { testRuntime } from "../support/runtime"

const evidence = "evidence-419 ".repeat(2_000)

for (const scenario of [
  { name: "preserves the request prefix without pressure across tool continuations", pressure: "none" },
  { name: "prunes and remeasures before soft-budget compaction", pressure: "soft" },
  { name: "keeps in-place message transforms out of canonical pruning writes", pressure: "soft", inPlace: true },
  {
    name: "reuses actual usage after a pressure-pruned request returns a tool call",
    pressure: "soft",
    continuation: true,
  },
  { name: "prunes before hard-overflow recovery", pressure: "hard" },
  { name: "allows pressure-driven pruning with automatic summaries disabled", pressure: "hard", auto: false },
  { name: "uses full compaction when pruning is disabled", pressure: "soft", prune: false },
  { name: "uses full compaction when only protected task evidence remains", pressure: "soft", protected: true },
  { name: "summarizes residual pressure after pruning older results", pressure: "soft", residual: true },
  { name: "summarizes a single long task without pruning its evidence", pressure: "soft", single: true },
  {
    name: "stops on hard overflow when pruning cannot help and summaries are disabled",
    pressure: "hard",
    protected: true,
    auto: false,
  },
  {
    name: "permits residual soft pressure when automatic summaries are disabled",
    pressure: "soft",
    protected: true,
    auto: false,
  },
  { name: "preserves the resumable breakpoint when stopped during pruning", pressure: "soft", interrupt: true },
  { name: "settles a pruning preparation failure without dispatching a stale prompt", pressure: "soft", failure: true },
] as const) {
  test(
    scenario.name,
    async () => {
      const prompts: Parameters<LanguageModelV4["doStream"]>[0]["prompt"][] = []
      const compactionPrompts: typeof prompts = []
      let mainCalls = 0
      let toolCalls = 0
      const stream = (chunks: LanguageModelV4StreamPart[]) => ({
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      })
      const reply = (text: string) =>
        stream([
          { type: "text-start", id: "reply" },
          { type: "text-delta", id: "reply", delta: text },
          { type: "text-end", id: "reply" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          },
        ])
      const model: LanguageModelV4 = {
        specificationVersion: "v4",
        provider: "fixture",
        modelId: "fixture",
        supportedUrls: {},
        async doGenerate() {
          throw new Error("Unexpected non-streaming call")
        },
        async doStream(input) {
          if (input.toolChoice?.type === "none") {
            compactionPrompts.push(structuredClone(input.prompt))
            return reply("## Goal\nContinue the fixture task.\n## Completed\nEarlier evidence was inspected.")
          }
          prompts.push(structuredClone(input.prompt))
          if ((scenario.pressure === "none" || "continuation" in scenario) && mainCalls++ === 0) {
            return stream([
              { type: "tool-call", toolCallId: "continue", toolName: "fixture_step", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: {
                    total: "continuation" in scenario ? 50000 : 180000,
                    noCache: "continuation" in scenario ? 50000 : 180000,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ])
          }
          return reply("Finished the fixture task.")
        },
      }
      const auxiliary: LanguageModelV4 = {
        ...model,
        modelId: "auxiliary",
        async doStream() {
          return reply("## Goal\nContinue the fixture task.\n## Completed\nEarlier evidence was inspected.")
        },
      }
      const sdk: ProviderV4 & { responses: (id: string) => LanguageModelV4 } = {
        specificationVersion: "v4",
        languageModel: (id) => (id === "auxiliary" ? auxiliary : model),
        responses: (id) => (id === "auxiliary" ? auxiliary : model),
        embeddingModel() {
          throw new Error("Unexpected embedding")
        },
        imageModel() {
          throw new Error("Unexpected image")
        },
      }
      const limit = {
        context: scenario.pressure === "none" ? 800000 : scenario.pressure === "hard" ? 80000 : 100000,
        input: scenario.pressure === "none" ? 800000 : scenario.pressure === "hard" ? 80000 : 100000,
        output: 8000,
      }
      const configuredModel = (id: string) => ({
        id,
        name: id,
        release_date: "2026-10-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: id === "fixture",
        limit,
        options: {},
      })
      await using runtime = await testRuntime({
        env: {
          SYNERGY_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/fixture",
            nano_model: "fixture/auxiliary",
            mini_model: "fixture/auxiliary",
            compaction: {
              auto: !("auto" in scenario) || scenario.auto,
              prune: !("prune" in scenario) || scenario.prune,
              codexRemote: false,
            },
            provider: {
              fixture: {
                profile: "openai-codex",
                npm: "@ai-sdk/openai",
                options: { apiKey: "synthetic-key", baseURL: "https://fixture.invalid/v1" },
                models: { fixture: configuredModel("fixture"), auxiliary: configuredModel("auxiliary") },
              },
            },
            agent: {
              fixture: {
                mode: "all",
                permission: { "*": "allow", doom_loop: "deny" },
                prompt: "Complete the fixture task.",
              },
              compaction: { model: "fixture/auxiliary" },
            },
          }),
        },
        register() {
          ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
          SessionPluginHooks.registerTrigger(async (point, _input, initial) => {
            if (point === "experimental.chat.messages.transform") {
              const messages = (initial as { messages: MessageV2.WithParts[] }).messages
              for (const message of messages) {
                message.parts = message.parts.map((part) => {
                  if (
                    part.type !== "tool" ||
                    part.state.status !== "completed" ||
                    !part.callID.startsWith("old-evidence-")
                  )
                    return part
                  if ("inPlace" in scenario) {
                    part.state.title = "Ephemeral fixture title"
                    part.state.output += "\nEphemeral fixture note"
                    return part
                  }
                  return {
                    ...part,
                    state: {
                      ...part.state,
                      title: "Ephemeral fixture title",
                      output: part.state.output + "\nEphemeral fixture note",
                    },
                  }
                })
              }
            }
            return initial
          })
          const tool = Tool.define(
            "fixture_step",
            {
              description: "Continue the fixture task.",
              parameters: z.object({}),
              async execute() {
                toolCalls++
                const output =
                  "continuation" in scenario ? "new-evidence-528 ".repeat(2_000) : "The continuation completed."
                return { title: "Continued", output, metadata: {} }
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
            const session = await Session.create({ workspace: null })
            let outputPartID = ""
            const roots = "single" in scenario ? 1 : 2
            for (let index = 0; index < roots; index++) {
              const userID = Identifier.ascending("message")
              await Session.updateMessage({
                id: userID,
                sessionID: session.id,
                role: "user",
                rootID: userID,
                isRoot: true,
                visible: true,
                includeInContext: true,
                origin: { type: "user" },
                agent: "fixture",
                model: { providerID: "fixture", modelID: "fixture" },
                time: { created: Date.now() },
              })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: userID,
                type: "text",
                origin: "user",
                text: `Completed task ${index}.`,
              })
              const hasEvidence = index === ("protected" in scenario ? 1 : 0) || ("residual" in scenario && index === 1)
              for (let result = 0; result < (hasEvidence ? 14 : 1); result++) {
                const assistantID = Identifier.ascending("message")
                const now = Date.now()
                await Session.updateMessage({
                  id: assistantID,
                  sessionID: session.id,
                  role: "assistant",
                  parentID: userID,
                  rootID: userID,
                  modelID: "fixture",
                  providerID: "fixture",
                  mode: "fixture",
                  agent: "fixture",
                  path: { cwd: "/", root: "/" },
                  cost: 0,
                  finish: "single" in scenario ? "tool-calls" : "stop",
                  time: { created: now, completed: now },
                  tokens: {
                    input: scenario.pressure === "hard" ? 220000 : 180000,
                    output: 5,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                })
                if (!hasEvidence) continue
                const part = await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistantID,
                  type: "tool",
                  tool: "fixture_step",
                  callID: `old-evidence-${result}`,
                  state: {
                    status: "completed",
                    input: {},
                    output: evidence,
                    title: "Earlier evidence",
                    metadata: {},
                    time: { start: now, end: now },
                  },
                })
                if (result === 0 && !outputPartID) outputPartID = part.id
              }
            }
            const originalPrune = SessionCompaction.prune
            let queuedItemID: string | undefined
            const prune =
              "interrupt" in scenario || "failure" in scenario
                ? spyOn(SessionCompaction, "prune").mockImplementation(async (input) => {
                    if ("failure" in scenario) {
                      if (queuedItemID) return originalPrune(input)
                      const item = await SessionInbox.enqueueUser({
                        sessionID: session.id,
                        agent: "fixture",
                        model: { providerID: "fixture", modelID: "fixture" },
                        parts: [{ type: "text", text: "Keep this queued task for explicit recovery." }],
                      })
                      queuedItemID = item.id
                      throw new Error("Fixture pruning preparation failed")
                    }
                    await SessionAbort.abort(session.id)
                    return originalPrune(input)
                  })
                : undefined
            let failed: unknown
            const calibrations: Array<PromptBudgeter.Calibration | undefined> = []
            const originalCalibrate = PromptBudgeter.calibrate
            const calibrate = spyOn(PromptBudgeter, "calibrate").mockImplementation(async (...args) => {
              const result = await originalCalibrate(...args)
              calibrations.push(result)
              return result
            })
            try {
              if ("single" in scenario) await SessionInvoke.loop.force(session.id)
              else {
                await SessionInvoke.invoke({
                  sessionID: session.id,
                  agent: "fixture",
                  model: { providerID: "fixture", modelID: "fixture" },
                  parts: [{ type: "text", text: "Continue with the next independent task." }],
                })
              }
            } catch (error) {
              failed = error
            } finally {
              prune?.mockRestore()
              calibrate.mockRestore()
            }
            await LoopJob.drain(session.id)
            const messages = await Session.messages({ sessionID: session.id })
            const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
            const output = messages.flatMap((message) => message.parts).find((part) => part.id === outputPartID)
            if (outputPartID) {
              const saved = await Storage.read<MessageV2.ToolPart>(
                StoragePath.messagePart(
                  Identifier.asScopeID(session.scope.id),
                  Identifier.asSessionID(session.id),
                  Identifier.asMessageID(output!.messageID),
                  Identifier.asPartID(outputPartID),
                ),
              )
              expect(saved.state.status === "completed" && saved.state.title).toBe("Earlier evidence")
              expect(saved.state.status === "completed" && saved.state.output.includes("Ephemeral fixture note")).toBe(
                false,
              )
            }
            const summariesDisabled = "auto" in scenario && !scenario.auto
            const interrupted = "interrupt" in scenario
            const preparationFailed = "failure" in scenario
            const expectedError =
              preparationFailed || (summariesDisabled && "protected" in scenario && scenario.pressure === "hard")
            if (expectedError) expect(failed).toBeInstanceOf(MessageV2.SessionTerminalError)
            else expect(failed).toBeUndefined()
            if (!("single" in scenario) && (output?.type !== "tool" || output.state.status !== "completed")) {
              throw new Error("Missing evidence tool")
            }
            const shouldPrune =
              scenario.pressure !== "none" &&
              !("prune" in scenario) &&
              !("protected" in scenario) &&
              !("single" in scenario) &&
              !interrupted &&
              !preparationFailed
            const shouldSummarize =
              !summariesDisabled &&
              ("prune" in scenario || "protected" in scenario || "residual" in scenario || "single" in scenario)
            if (output?.type === "tool" && output.state.status === "completed") {
              expect(!!output.state.time.compacted).toBe(shouldPrune)
            }
            expect(summaries).toHaveLength(shouldSummarize ? 1 : 0)
            expect(compactionPrompts).toHaveLength(shouldSummarize ? 1 : 0)
            expect(prompts).toHaveLength(
              expectedError || interrupted ? 0 : scenario.pressure === "none" || "continuation" in scenario ? 2 : 1,
            )
            if ("continuation" in scenario) {
              const anchor = messages.find(
                (message) => message.info.role === "assistant" && message.info.finish === "tool-calls",
              )
              expect(anchor?.info.metadata?.promptPruning).toBeString()
              const beforeReply = messages.slice(
                0,
                messages.findLastIndex((message) => message.info.role === "assistant"),
              )
              expect(beforeReply.findLast((message) => message.info.role === "assistant")?.info.id).toBe(
                anchor?.info.id,
              )
              expect(anchor?.info.role === "assistant" && anchor.info.tokens.input).toBe(50000)
              expect(SessionCompaction.pruningRevision(beforeReply.slice(0, beforeReply.indexOf(anchor!)))).toBe(
                anchor?.info.metadata?.promptPruning,
              )
              expect(calibrations.at(-1)).toMatchObject({ actualInput: 50000 })
              expect(toolCalls).toBe(1)
              expect(JSON.stringify(prompts[1]).includes("new-evidence-528")).toBe(true)
            }
            if (interrupted || preparationFailed) {
              const latest = messages.findLast((message) => message.info.role === "assistant")!
                .info as MessageV2.Assistant
              expect((await Session.get(session.id)).paused?.reason).toBe(interrupted ? "aborted" : "failed")
              if (interrupted) {
                expect(latest.finish).toBeUndefined()
                expect(latest.time.completed).toBeUndefined()
                expect(latest.error).toBeUndefined()
              } else {
                expect(latest.finish).toBe("error")
                expect(JSON.stringify(latest.error).includes("Fixture pruning preparation failed")).toBe(true)
                const queued = await SessionInbox.getStored(session.id, queuedItemID!)
                expect(messages.some((message) => message.info.id === queued.messageID)).toBe(false)
              }
            }
            if (scenario.pressure === "none") {
              expect(toolCalls).toBe(1)
              expect(JSON.stringify(prompts[1]!.slice(0, prompts[0]!.length)) === JSON.stringify(prompts[0])).toBe(true)
              expect(JSON.stringify(prompts[1]).includes(evidence)).toBe(true)
              expect(JSON.stringify(prompts[1]).includes("Ephemeral fixture note")).toBe(true)
            }
            if (shouldPrune && !shouldSummarize) {
              const result = prompts[0]!.flatMap((message) =>
                message.role === "tool"
                  ? message.content.filter(
                      (part) => part.type === "tool-result" && part.toolCallId === "old-evidence-0",
                    )
                  : [],
              )
              expect(JSON.stringify(result).includes("[Old tool result content cleared]")).toBe(true)
              expect(JSON.stringify(result).includes(evidence)).toBe(false)
            }
          },
        }),
      )
    },
    20_000,
  )
}
