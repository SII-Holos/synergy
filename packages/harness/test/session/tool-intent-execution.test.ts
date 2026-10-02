import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test"
import { z } from "zod"
import type { JSONSchema7 } from "ai"
import { AgentTurn } from "../../src/session/agent-turn"
import { Identifier } from "../../src/id/id"
import type { Provider } from "../../src/provider/provider"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { createUserMessage } from "../../src/session/input"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutCall } from "../../src/session/rollout/call"
import { RolloutLedger } from "../../src/session/rollout/ledger"
import { ToolIntent } from "../../src/session/tool-intent"
import { ToolScheduler } from "../../src/session/tool-scheduler"
import { SecretMask } from "../../src/secrets/mask"
import { SecretVault } from "../../src/secrets/vault"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const secretIDs: string[] = []
afterAll(() => runtime.close())
afterEach(() =>
  runtime.run(async () => {
    mock.restore()
    await ToolScheduler.stop()
    ToolScheduler.configure()
    for (const id of secretIDs.splice(0)) await SecretVault.remove(id)
  }),
)

const model: Provider.Model = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  api: { id: "test-model", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  family: "test",
}

test("canonical execution strips common intent, preserves native values, and replays the original model shape", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const user = await createUserMessage({
          sessionID: session.id,
          model: { providerID: model.providerID, modelID: model.id },
          parts: [{ type: "text", text: "inspect records" }],
        })
        const assistant: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: user.info.id,
          rootID: user.info.id,
          modelID: model.id,
          providerID: model.providerID,
          mode: "test",
          agent: "synergy",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        await Session.updateMessage(assistant)
        const abort = new AbortController()
        const processor = SessionProcessor.create({
          assistantMessage: assistant,
          sessionID: session.id,
          model,
          abort: abort.signal,
        })
        const native: JSONSchema7 = {
          type: "object",
          properties: { workBrief: { type: "integer" }, value: { type: "string" } },
          required: ["workBrief", "value"],
        }
        const definitions = [
          {
            id: "flat",
            description: "Inspect a record",
            inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } } },
          },
          { id: "conflict", description: "Inspect a native record", inputSchema: native },
          {
            id: "array",
            description: "Inspect labels",
            inputSchema: { type: "array" as const, items: { type: "string" as const } },
          },
          {
            id: "failure",
            description: "Try an unavailable operation",
            inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } } },
          },
        ]
        const bindings = new Map(
          definitions.map((definition) => [definition.id, ToolIntent.snapshot(definition.inputSchema)]),
        )
        const secret = `registered-${crypto.randomUUID()}`
        const entry = await SecretVault.register(secret, { kind: "user" })
        secretIDs.push(entry.id)
        const proposed = [
          {
            name: "flat",
            input: { value: "one", workBrief: `Read the record for ${secret}` },
            business: { value: "one" },
          },
          {
            name: "conflict",
            input: { workBrief: "Inspect record seven", toolInput: { workBrief: 7, value: "native" } },
            business: { workBrief: 7, value: "native" },
          },
          { name: "array", input: { workBrief: "Check the labels", toolInput: ["a", "b"] }, business: ["a", "b"] },
          {
            name: "failure",
            input: { workBrief: "Try the missing record", value: "missing" },
            business: { value: "missing" },
          },
        ]
        const owner = { kind: "session" as const, scopeID: session.scope.id, sessionID: session.id }
        const received: unknown[] = []
        spyOn(AgentTurn, "stream").mockImplementation(async (stream) => {
          native.properties!.value = { type: "number" }
          return RolloutCall.stream(
            {
              owner,
              retryIndex: stream.retryIndex,
              usageRole: stream.usageRole,
              runID: user.info.id,
              purpose: "test",
              request: {},
              model: { providerID: model.providerID, modelID: model.id, sdk: "test", pricing: null },
            },
            async () => ({
              fullStream: (async function* () {
                yield { type: "start-step" as const }
                for (const call of proposed)
                  yield { type: "tool-call" as const, toolCallId: call.name, toolName: call.name, input: call.input }
                yield {
                  type: "finish-step" as const,
                  finishReason: "tool-calls" as const,
                  usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
                }
                yield { type: "finish" as const }
              })(),
              usage: Promise.resolve(undefined),
              async dispose() {},
            }),
          )
        })
        await processor.process({
          user: user.info,
          sessionID: session.id,
          model,
          agent: { name: "synergy", mode: "primary", permission: [], options: {}, native: true },
          system: [],
          messages: [{ role: "user", content: "inspect records" }],
          abort: abort.signal,
          toolDefinitions: definitions,
          intentBindings: bindings,
          executionTools: Object.fromEntries(
            proposed.map((call) => [
              call.name,
              {
                inputSchema: z.unknown(),
                async execute(input: unknown, options: { toolCallId: string }) {
                  received.push(input)
                  const slot = processor.beginExecution(options.toolCallId)
                  if (call.name === "failure") {
                    slot.fail(input, "Missing record")
                    throw new Error("Missing record")
                  }
                  const result = { title: call.name, metadata: {}, output: "read" }
                  slot.complete(input, result)
                  return result
                },
              },
            ]),
          ),
          executorKinds: Object.fromEntries(proposed.map((call) => [call.name, "control_plane" as const])),
        })
        expect(received).toEqual(proposed.map((call) => call.business))
        const message = await MessageV2.get({ sessionID: session.id, messageID: assistant.id })
        const parts = message.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool")
        const briefs = await Promise.all(proposed.map((call) => SecretMask.apply(call.input.workBrief)))
        expect(parts.map((part) => part.workBrief)).toEqual(briefs)
        expect(JSON.stringify(parts)).not.toContain(secret)
        expect(parts.map((part) => part.state.input)).toEqual(proposed.map((call) => call.business))
        expect(parts.at(-1)?.state.status).toBe("error")
        const replay = MessageV2.toModelMessage([{ info: user.info, parts: user.parts }, message])
        const modelCalls = replay
          .filter((item) => item.role === "assistant")
          .flatMap((item) =>
            Array.isArray(item.content) ? item.content.filter((content) => content.type === "tool-call") : [],
          )
        expect(modelCalls.map((call) => (call.type === "tool-call" ? call.input : undefined))).toEqual(
          proposed.map((call, index) => ({ ...call.input, workBrief: briefs[index] })),
        )
        const calls = await RolloutLedger.calls(owner, user.info.id)
        const captured: string[] = []
        for (const call of calls) {
          if (!call.response) continue
          const chunks: Uint8Array[] = []
          for await (const chunk of RolloutArtifact.read(owner, call.response)) chunks.push(chunk)
          captured.push(Buffer.concat(chunks).toString())
        }
        expect(captured.join("\n")).toContain("Inspect record seven")
        expect(captured.join("\n")).toContain(secret)
        expect(captured.join("\n")).toContain('"toolInput":{"workBrief":7,"value":"native"}')
      },
    })
  }))
