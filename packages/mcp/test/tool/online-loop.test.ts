import type { LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { expect, spyOn, test } from "bun:test"
import { jsonSchema, simulateReadableStream, type JSONSchema7 } from "ai"
import { z } from "zod"
import { Cortex } from "@ericsanchezok/synergy-harness/cortex"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ProviderSdkSource } from "@ericsanchezok/synergy-harness/provider/sdk-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { createUserMessage } from "@ericsanchezok/synergy-harness/session/input"
import { SessionInvoke } from "@ericsanchezok/synergy-harness/session/invoke"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { ToolIntent } from "@ericsanchezok/synergy-harness/session/tool-intent"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { MCP } from "../../src"
import { registerAgentPermissions } from "../../src/agent-permissions"
import { registerConfig } from "../../src/config-schema"
import { registerMcpToolSource } from "../../src/tool-source"
import definitions from "../fixtures/scholight-tools.json"

type FixtureModel = LanguageModelV2
type ModelRequest = Pick<Parameters<FixtureModel["doStream"]>[0], "prompt" | "tools" | "toolChoice">
type StreamPart =
  Awaited<ReturnType<FixtureModel["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never

test("a review child auto-expands MCP, executes once and retains exposure through compaction", async () => {
  const toolID = "mcp__scholight__search_papers"
  const callID = "online-fixture-call"
  const args = { query: "fixture AI literature", strength: "thorough" }
  const output = "Fixture paper result: https://fixture.invalid/paper"
  const summary = "The source lookup is complete. Resume with the final answer without repeating the lookup."
  const schema: JSONSchema7 = {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      strength: { type: "string", enum: ["standard", "thorough"] },
      filters: {
        type: "object",
        properties: { authors: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    },
    required: ["query", "strength"],
    additionalProperties: false,
  }
  const originalSchema = structuredClone(schema)
  const executions: Array<{ args: unknown; callID: string }> = []
  const entry: MCP.ToolEntry = {
    id: toolID,
    serverName: "scholight",
    toolName: "search_papers",
    source: "builtin",
    requiresWorkspace: false,
    inputSchema: schema,
    display: { icon: "telescope" },
    tool: {
      description: definitions.find((tool) => tool.name === "search_papers")!.description,
      inputSchema: jsonSchema(schema),
      async execute(input, options) {
        executions.push({ args: structuredClone(input), callID: options.toolCallId })
        return { content: [{ type: "text", text: output }] }
      },
    },
  }
  const requests: ModelRequest[] = []
  const compactRequests: ModelRequest[] = []
  const sequence: string[] = []
  let compactionRequests = 0
  const stream = (chunks: StreamPart[]) => ({
    stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
  })
  const finish = (finishReason: "stop" | "tool-calls"): StreamPart => ({
    type: "finish",
    finishReason,
    usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 },
  })
  const text = (value: string): StreamPart[] => [
    { type: "text-start", id: "reply" },
    { type: "text-delta", id: "reply", delta: value },
    { type: "text-end", id: "reply" },
    finish("stop"),
  ]
  const models: Record<string, FixtureModel> = {
    primary: {
      specificationVersion: "v2",
      provider: "online-fixture",
      supportedUrls: {},
      modelId: "primary",
      async doGenerate() {
        throw new Error("Unexpected non-streaming model call")
      },
      async doStream(input) {
        if (input.toolChoice?.type === "none") {
          compactRequests.push(
            structuredClone({ prompt: input.prompt, tools: input.tools, toolChoice: input.toolChoice }),
          )
          sequence.push("compact")
          return stream(text(summary))
        }
        requests.push(structuredClone({ prompt: input.prompt, tools: input.tools }))
        sequence.push("primary")
        if (requests.length === 1)
          return stream([
            { type: "tool-call", toolCallId: callID, toolName: toolID, input: JSON.stringify(args) },
            finish("tool-calls"),
          ])
        if (requests.length === 2)
          return stream([
            { type: "tool-call", toolCallId: "compact-fixture-call", toolName: "fixture_compact", input: "{}" },
            finish("tool-calls"),
          ])
        if (requests.length === 3) return stream(text("Completed after compaction."))
        throw new Error("Unexpected extra primary model call")
      },
    },
    compact: {
      specificationVersion: "v2",
      provider: "online-fixture",
      supportedUrls: {},
      modelId: "compact",
      async doGenerate() {
        throw new Error("Unexpected non-streaming compaction call")
      },
      async doStream() {
        throw new Error("Native compaction must reuse the primary model")
      },
    },
    auxiliary: {
      specificationVersion: "v2",
      provider: "online-fixture",
      supportedUrls: {},
      modelId: "auxiliary",
      async doGenerate() {
        throw new Error("Unexpected non-streaming auxiliary call")
      },
      async doStream(input) {
        expect(input.tools ?? []).toEqual([])
        return stream(text("Fixture title."))
      },
    },
  }
  const sdk: ProviderV2 = {
    languageModel(id) {
      const model = models[id]
      if (!model) throw new Error(`Unexpected fixture model: ${id}`)
      return model
    },
    textEmbeddingModel() {
      throw new Error("Unexpected embedding call")
    },
    imageModel() {
      throw new Error("Unexpected image call")
    },
  }
  const model = {
    name: "Fixture",
    release_date: "2026-10-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    limit: { context: 128000, output: 8000 },
    options: {},
  }
  await using runtime = await testRuntime({
    env: {
      SYNERGY_DISABLE_BUILTIN_MCP: "true",
      SYNERGY_CONFIG_CONTENT: JSON.stringify({
        model: "online-fixture/primary",
        nano_model: "online-fixture/auxiliary",
        mini_model: "online-fixture/auxiliary",
        long_context_model: "online-fixture/compact",
        enabled_providers: ["online-fixture"],
        controlProfile: "full_access",
        provider: {
          "online-fixture": {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "synthetic-fixture-key", baseURL: "https://fixture.invalid/v1" },
            models: {
              primary: { ...model, id: "primary" },
              compact: { ...model, id: "compact" },
              auxiliary: { ...model, id: "auxiliary" },
            },
          },
        },
        agent: { inspector: { permission: { fixture_compact: "allow" }, prompt: "Complete the synthetic task." } },
      }),
    },
    composition: {
      register() {
        registerLocalRuntime({ environment: false })
        registerConfig()
        registerAgentPermissions()
        registerMcpToolSource()
        ProviderSdkSource.register(undefined)
        ProviderSdkSource.register({ load: async () => () => sdk, loadSync: () => () => sdk })
        const compact = Tool.define(
          "fixture_compact",
          {
            description: "Request context compaction before continuing the fixture task.",
            parameters: z.object({}),
            async execute(_, context) {
              compactionRequests++
              const message = await MessageV2.get({ sessionID: context.sessionID, messageID: context.messageID })
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: context.sessionID,
                messageID: message.info.rootID ?? context.messageID,
                type: "compaction",
                auto: true,
              })
              return { title: "Compaction requested", output: "Continue after compaction.", metadata: {} }
            },
          },
          { requiresWorkspace: false },
        )
        ToolRegistry.registerToolProvider("online-loop-fixture", () => [{ ...compact, exposure: { mode: "resident" } }])
      },
    },
  })
  try {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        async fn() {
          using source = spyOn(MCP, "toolEntries").mockResolvedValue([entry])
          const parent = await Session.create({ workspace: null, controlProfile: "full_access" })
          const session = await Session.create({ parentID: parent.id })
          expect(session.toolState?.expandedGroups ?? []).not.toContain("online")
          const input = {
            sessionID: session.id,
            messageID: Identifier.ascending("message"),
            agent: "inspector",
            model: { providerID: "online-fixture", modelID: "primary" },
            parts: [{ type: "text" as const, text: "Look up the fixture source, compact the context, then finish." }],
          }
          await createUserMessage(input)
          const result = await SessionInvoke.invoke(input)

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected a completed assistant reply")
          expect(result.info.error).toBeUndefined()
          expect(result.info).toMatchObject({ parentID: input.messageID, rootID: input.messageID, finish: "stop" })
          expect(result.parts).toContainEqual(
            expect.objectContaining({ type: "text", text: "Completed after compaction." }),
          )
          expect(sequence).toEqual(["primary", "primary", "compact", "primary"])
          expect(executions).toEqual([{ args, callID }])
          expect(compactionRequests).toBe(1)
          expect(requests).toHaveLength(3)
          expect(compactRequests).toHaveLength(1)
          expect(requests[0].tools?.some((tool) => tool.name === toolID)).toBe(false)
          const expand = requests[0].tools?.find((tool) => tool.name === "expand_tools")
          if (!expand || expand.type !== "function") throw new Error("Missing expansion directory at model boundary")
          expect(expand.description).toContain("online (Online search and reading)")
          expect(JSON.stringify(requests[1].prompt)).toContain(output)
          for (const request of requests.slice(1)) {
            const definition = request.tools?.find((tool) => tool.name === toolID)
            expect(definition?.type).toBe("function")
            if (!definition || definition.type !== "function") throw new Error("Online tool missing at model boundary")
            expect(definition.description).toBe(String(entry.tool.description))
            expect(definition.inputSchema).toEqual({
              ...originalSchema,
              properties: {
                ...originalSchema.properties,
                workBrief: { type: "string", description: ToolIntent.description },
              },
            })
          }
          expect(schema).toEqual(originalSchema)
          expect(entry.tool.description).toBe(definitions.find((tool) => tool.name === "search_papers")!.description)
          expect(compactRequests[0].tools).toEqual(requests[1].tools)
          expect(compactRequests[0].toolChoice).toEqual({ type: "none" })
          expect(JSON.stringify(compactRequests[0].prompt)).toContain(output)
          expect(JSON.stringify(requests[2].prompt)).toContain(summary)
          expect(JSON.stringify(requests[2].prompt)).toContain("Continue if you have next steps")
          expect(JSON.stringify(requests[2].prompt)).not.toContain(output)

          const messages = await Session.messages({ sessionID: session.id })
          const calls = messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
          expect(calls.filter((part) => part.tool === toolID)).toEqual([
            expect.objectContaining({
              callID,
              state: expect.objectContaining({
                status: "completed",
                input: args,
                output,
                metadata: expect.objectContaining({ autoExpanded: true, display: { icon: "telescope" } }),
              }),
            }),
          ])
          const summaries = messages.filter((message) => message.info.role === "assistant" && message.info.summary)
          expect(summaries).toHaveLength(1)
          expect(summaries[0].info).toMatchObject({
            parentID: input.messageID,
            rootID: input.messageID,
            metadata: { compactionAttempt: { state: "committed" } },
          })
          expect(summaries[0].parts).toContainEqual(
            expect.objectContaining({ type: "compaction_recovery", summary, mechanical: false, validated: true }),
          )
          expect(
            messages.some(
              (message) =>
                message.info.role === "user" &&
                message.info.origin?.type === "compaction" &&
                message.info.rootID === input.messageID,
            ),
          ).toBe(true)
          expect((await Session.get(session.id)).toolState).toEqual({ expandedGroups: ["online"], activatedTools: [] })
        },
      }),
    )
  } finally {
    await runtime.run(() => Cortex.stop())
  }
}, 20_000)
