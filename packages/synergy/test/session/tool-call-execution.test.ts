import { expect, mock, test } from "bun:test"
import { streamText } from "ai"
import z from "zod"
// SessionToolContext/ToolMcpSource must be mounted: the resolver reaches
// plugin hooks and MCP entries through the L1 ports (adapters are
// late-bound to the mocked Plugin.trigger / MCP.toolEntries).
import "../../src/product-registration"
import { Config } from "../../src/config/config"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { SessionProcessor } from "../../src/session/processor"
import { ToolResolver } from "../../src/session/tool-resolver"
import { tmpdir } from "../fixture/fixture"
import { SessionBounds } from "../../src/session/bounds"
import { ToolRegistry } from "../../src/tool/registry"
import { TimeoutConfig } from "../../src/util/timeout-config"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"

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
            tools: resolved.executionTools,
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

test("rejects oversized tool input before the handler executes", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const sessionID = "ses_tool_input_bound"
      const processor = SessionProcessor.create({
        assistantMessage: {
          id: "msg_tool_input_bound",
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
              id: "bounded_execution",
              description: "Rejects oversized input before execution",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              async execute() {
                executionCount++
                return { title: "Unexpected", output: "unexpected" }
              },
            },
          ],
          userTools: { bounded_execution: true },
          includeMCP: false,
        })

        await expect(
          (resolved.executionTools.bounded_execution as any).execute(
            { value: "x".repeat(SessionBounds.TOOL_INPUT_MAX_BYTES + 1) },
            { toolCallId: "call_oversized" },
          ),
        ).rejects.toThrow(`Tool input exceeded ${SessionBounds.TOOL_INPUT_MAX_BYTES} bytes`)
        expect(executionCount).toBe(0)
      } finally {
        processor.dispose("test")
      }
    },
  })
})

test("configured tool timeout settles a non-cooperative built-in execution exactly once", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const originalConfigCurrent = Config.current
      const originalRegistryTools = ToolRegistry.tools
      let releaseTool!: () => void
      const toolRelease = new Promise<void>((resolve) => {
        releaseTool = resolve
      })
      let markToolFinished!: () => void
      const toolFinished = new Promise<void>((resolve) => {
        markToolFinished = resolve
      })
      let executionCount = 0
      ;(Config.current as any) = mock(async () => ({
        timeout: {
          tool: {
            default_sec: 0.01,
          },
        },
      }))
      ;(ToolRegistry.tools as any) = mock(async () => [
        {
          id: "file_search",
          description: "Waits without observing AbortSignal",
          parameters: z.object({ query: z.string() }),
          async execute() {
            executionCount++
            await toolRelease
            markToolFinished()
            return {
              title: "Late result",
              output: "late",
              metadata: {},
            }
          },
        },
      ])
      TimeoutConfig.invalidate()

      const sessionID = "ses_tool_timeout"
      const callID = "call_tool_timeout"
      const processor = SessionProcessor.create({
        assistantMessage: {
          id: "msg_tool_timeout",
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

      try {
        const resolved = await ToolResolver.resolveWithAvailability({
          agent: allowAllAgent,
          model,
          sessionID,
          processor,
          userTools: { file_search: true },
          includeMCP: false,
        })
        const execution = (resolved.executionTools.file_search as any).execute(
          { query: "evidence" },
          { toolCallId: callID },
        )

        await expect(
          Promise.race([
            execution,
            Bun.sleep(1_000).then(() => {
              throw new Error("Tool execution did not settle after its configured timeout")
            }),
          ]),
        ).rejects.toThrow("Tool execution timed out")

        const slot = processor.beginExecution(callID)
        const outcome = await slot.promise
        expect(outcome.status).toBe("error")
        if (outcome.status === "error") {
          expect(outcome.error).toContain("Tool execution timed out")
        }
        expect(executionCount).toBe(1)

        releaseTool()
        await toolFinished
        await Bun.sleep(0)
        expect(slot.outcome?.status).toBe("error")
        if (slot.outcome?.status === "error") {
          expect(slot.outcome.error).toContain("Tool execution timed out")
        }
        expect(executionCount).toBe(1)
      } finally {
        releaseTool()
        processor.dispose("test")
        ;(Config.current as any) = originalConfigCurrent
        ;(ToolRegistry.tools as any) = originalRegistryTools
        TimeoutConfig.invalidate()
      }
    },
  })
})

for (const scenario of [
  { executor: "built-in", phase: "before", point: "tool.execute.before", expectedExecutionCount: 0 },
  { executor: "built-in", phase: "after", point: "tool.execute.after", expectedExecutionCount: 1 },
  { executor: "MCP", phase: "before", point: "tool.execute.before", expectedExecutionCount: 0 },
  { executor: "MCP", phase: "after", point: "tool.execute.after", expectedExecutionCount: 1 },
] as const) {
  test(`configured tool timeout settles a non-cooperative ${scenario.executor} ${scenario.phase} hook`, async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalConfigCurrent = Config.current
        const originalPluginTrigger = Plugin.trigger
        const originalRegistryTools = ToolRegistry.tools
        const originalMcpToolEntries = MCP.toolEntries
        let releaseHook!: () => void
        const hookRelease = new Promise<void>((resolve) => {
          releaseHook = resolve
        })
        let markHookStarted!: () => void
        const hookStarted = new Promise<void>((resolve) => {
          markHookStarted = resolve
        })
        let markHookFinished!: () => void
        const hookFinished = new Promise<void>((resolve) => {
          markHookFinished = resolve
        })
        let hookSignal: AbortSignal | undefined
        let executionCount = 0
        ;(Config.current as any) = mock(async () => ({
          timeout: {
            tool: {
              default_sec: 0.01,
            },
          },
        }))
        ;(Plugin.trigger as any) = mock(
          async (point: string, _input: unknown, output: unknown, options?: { signal?: AbortSignal }) => {
            if (point !== scenario.point) return output
            hookSignal = options?.signal
            markHookStarted()
            await hookRelease
            markHookFinished()
            return output
          },
        )
        ;(ToolRegistry.tools as any) = mock(async () =>
          scenario.executor === "built-in"
            ? [
                {
                  id: "file_search",
                  description: `Runs with a stalled ${scenario.phase} hook`,
                  parameters: z.object({ query: z.string() }),
                  async execute() {
                    executionCount++
                    return {
                      title: "Tool result",
                      output: "result",
                      metadata: {},
                    }
                  },
                },
              ]
            : [],
        )
        ;(MCP.toolEntries as any) = mock(async () =>
          scenario.executor === "MCP"
            ? [
                {
                  id: "mcp__fixture__ping",
                  serverName: "fixture",
                  toolName: "ping",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                    additionalProperties: false,
                  },
                  tool: {
                    description: `Runs with a stalled ${scenario.phase} hook`,
                    async execute() {
                      executionCount++
                      return { content: [{ type: "text", text: "result" }] }
                    },
                  },
                },
              ]
            : [],
        )
        TimeoutConfig.invalidate()

        const suffix = `${scenario.executor.toLowerCase().replace("-", "_")}_${scenario.phase}_hook_timeout`
        const sessionID = `ses_tool_${suffix}`
        const callID = `call_tool_${suffix}`
        const processor = SessionProcessor.create({
          assistantMessage: {
            id: `msg_tool_${suffix}`,
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

        try {
          const toolID = scenario.executor === "MCP" ? "mcp__fixture__ping" : "file_search"
          const resolved = await ToolResolver.resolveWithAvailability({
            agent: allowAllAgent,
            model,
            sessionID,
            processor,
            userTools: { [toolID]: true },
            includeMCP: scenario.executor === "MCP",
          })
          const execution = (resolved.executionTools[toolID] as any).execute(
            { query: "evidence" },
            { toolCallId: callID },
          )

          await Promise.race([
            hookStarted,
            Bun.sleep(1_000).then(() => {
              throw new Error(`${scenario.executor} ${scenario.phase} hook did not start`)
            }),
          ])
          await expect(
            Promise.race([
              execution,
              Bun.sleep(1_000).then(() => {
                throw new Error(
                  `Tool execution did not settle while its ${scenario.executor} ${scenario.phase} hook was stalled`,
                )
              }),
            ]),
          ).rejects.toThrow("Tool execution timed out")
          expect(hookSignal?.aborted).toBe(true)
          expect(executionCount).toBe(scenario.expectedExecutionCount)

          const slot = processor.beginExecution(callID)
          const outcome = await slot.promise
          expect(outcome.status).toBe("error")
          if (outcome.status === "error") expect(outcome.error).toContain("Tool execution timed out")

          releaseHook()
          await hookFinished
          await Bun.sleep(0)
          expect(slot.outcome?.status).toBe("error")
          if (slot.outcome?.status === "error") expect(slot.outcome.error).toContain("Tool execution timed out")
          expect(executionCount).toBe(scenario.expectedExecutionCount)
        } finally {
          releaseHook()
          processor.dispose("test")
          ;(Config.current as any) = originalConfigCurrent
          ;(Plugin.trigger as any) = originalPluginTrigger
          ;(ToolRegistry.tools as any) = originalRegistryTools
          ;(MCP.toolEntries as any) = originalMcpToolEntries
          TimeoutConfig.invalidate()
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
