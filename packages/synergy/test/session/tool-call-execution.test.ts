import { expect, test } from "bun:test"
import { streamText } from "ai"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { tmpdir } from "../fixture/fixture"

for (const scenario of [
  { name: "successful", terminalEvent: "tool-result", error: false },
  { name: "failed", terminalEvent: "tool-error", error: true },
] as const) {
  test(`executes a replayed ${scenario.name} provider tool call only once`, async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = "ses_tool_call_execution"
        const processor = SessionProcessor.create({
          assistantMessage: {
            id: "msg_tool_call_execution",
            sessionID,
            role: "assistant",
            parentID: "msg_user",
            modelID: "test-model",
            providerID: "test-provider",
            mode: "build",
            agent: "synergy",
            path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0 },
          },
          sessionID,
          model,
          abort: new AbortController().signal,
        })
        let executionCount = 0

        try {
          const resolved = await ToolResolver.resolveWithAvailability({
            agent: allowAllAgent,
            model,
            sessionID,
            processor,
            ephemeralTools: [
              {
                id: "count_execution",
                description: "Counts actual handler executions",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                async execute() {
                  executionCount++
                  if (scenario.error) throw new Error("expected tool failure")
                  return { title: "Counted", output: "done" }
                },
              },
            ],
            userTools: { count_execution: true },
            includeMCP: false,
          })
          const result = streamText({
            model: replayingModel,
            prompt: "Run the counter",
            tools: resolved.tools,
          })
          const events: string[] = []
          for await (const event of result.fullStream) events.push(event.type)

          expect(events.filter((event) => event === "tool-call")).toHaveLength(2)
          expect(events.filter((event) => event === scenario.terminalEvent)).toHaveLength(2)
          expect(executionCount).toBe(1)
        } finally {
          processor.dispose("test")
        }
      },
    })
  })
}

const allowAllAgent = {
  name: "synergy",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  controlProfile: "full_access",
} as any

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any

const replayingModel = {
  specificationVersion: "v2",
  provider: "test-provider",
  modelId: "test-model",
  supportedUrls: {},
  async doStream() {
    const chunks = [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "call_replayed", toolName: "count_execution", input: "{}" },
      { type: "tool-call", toolCallId: "call_replayed", toolName: "count_execution", input: "{}" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
    }
  },
} as any
