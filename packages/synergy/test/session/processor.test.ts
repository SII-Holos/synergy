import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { TimeoutConfig } from "../../src/util/timeout-config"
import { Config } from "../../src/config/config"
import { ExperienceEncoder } from "../../src/library/experience-encoder"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityToolFailures } from "../../src/observability/tool-failures"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

function toolPart(
  callID: string,
  input: Record<string, unknown>,
  status: "pending" | "running" | "completed" | "error" = "completed",
): MessageV2.ToolPart {
  return {
    id: `prt_${callID}`,
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    tool: "edit",
    callID,
    state:
      status === "completed"
        ? {
            status,
            input,
            output: "",
            metadata: {},
            title: "",
            time: { start: 0, end: 0 },
          }
        : status === "error"
          ? {
              status,
              input,
              error: "boom",
              time: { start: 0, end: 0 },
            }
          : status === "running"
            ? {
                status,
                input,
                time: { start: 0 },
              }
            : {
                status,
                input,
                raw: "",
              },
  } as MessageV2.ToolPart
}

describe("SessionProcessor.shouldAskDoomLoop", () => {
  test("asks when the same edit input appears three times in a row", () => {
    const input = {
      filePath: "/tmp/example.ts",
      oldString: "const value = foo()",
      newString: "const value = bar()",
    }

    const parts: MessageV2.Part[] = [toolPart("1", input), toolPart("2", input), toolPart("3", input)]

    expect(SessionProcessor.shouldAskDoomLoop(parts, "edit", input)).toBe(true)
  })

  test("does not ask when repeated edit calls vary the input slightly", () => {
    const parts: MessageV2.Part[] = [
      toolPart("1", {
        filePath: "/tmp/example.ts",
        oldString: "const value = foo()",
        newString: "const value = bar()",
      }),
      toolPart("2", {
        filePath: "/tmp/example.ts",
        oldString: "  const value = foo()",
        newString: "const value = bar()",
      }),
      toolPart("3", {
        filePath: "/tmp/example.ts",
        oldString: "const value = foo()\nreturn value",
        newString: "const value = bar()\nreturn value",
      }),
    ]

    expect(
      SessionProcessor.shouldAskDoomLoop(parts, "edit", {
        filePath: "/tmp/example.ts",
        oldString: "const value = foo()\nreturn value",
        newString: "const value = bar()\nreturn value",
      }),
    ).toBe(false)
  })

  test("ignores pending tool parts when checking for repeated calls", () => {
    const input = {
      filePath: "/tmp/example.ts",
      oldString: "const value = foo()",
      newString: "const value = bar()",
    }

    const parts: MessageV2.Part[] = [toolPart("1", input), toolPart("2", input), toolPart("3", input, "pending")]

    expect(SessionProcessor.shouldAskDoomLoop(parts, "edit", input)).toBe(false)
  })
})

describe("SessionProcessor.streamToolErrorOutcome", () => {
  test("turns unavailable synthetic tool errors into unknown_tool diagnostics", () => {
    const part = toolPart("unknown", { x: 1 }, "running")
    const outcome = SessionProcessor.streamToolErrorOutcome(
      { ...part, tool: "hallucinated_tool" },
      new Error("Model tried to call unavailable tool 'hallucinated_tool'. Available tools: bash, read"),
    )

    expect(outcome.status).toBe("error")
    if (outcome.status === "error") {
      expect(outcome.error).toContain("unavailable tool")
      expect(outcome.error).not.toBe("Tool execution aborted")
      expect(outcome.metadata?.toolDiagnostic.code).toBe("unknown_tool")
      expect(outcome.metadata?.toolDiagnostic.toolName).toBe("hallucinated_tool")
    }
  })

  test("turns schema synthetic tool errors into invalid_arguments diagnostics", () => {
    const part = toolPart("bad_args", { command: 42 }, "running")
    const outcome = SessionProcessor.streamToolErrorOutcome(
      { ...part, tool: "bash" },
      new Error("Invalid tool input: expected command to be a string"),
    )

    expect(outcome.status).toBe("error")
    if (outcome.status === "error") {
      expect(outcome.metadata?.toolDiagnostic.code).toBe("invalid_arguments")
      expect(outcome.error).toContain("could not be accepted")
    }
  })
})

type SettlementScenario = {
  messageID: string
  stream(processor: SessionProcessor.Info): AsyncGenerator<Record<string, unknown>>
  config?: Record<string, unknown>
  updatePart?: (input: MessageV2.Part | { part: MessageV2.Part; delta?: string }) => Promise<MessageV2.Part>
}

async function runSettlementScenario(scenario: SettlementScenario) {
  const originalStream = LLM.stream
  const originalUpdatePart = Session.updatePart
  const originalParts = MessageV2.parts
  const originalUpdateMessage = Session.updateMessage
  const originalUpdateLastExchange = Session.updateLastExchange
  const originalConfigCurrent = Config.current
  const originalPluginTrigger = Plugin.trigger
  const originalExperienceComplete = ExperienceEncoder.onComplete
  const parts = new Map<string, MessageV2.Part>()
  let processor!: SessionProcessor.Info

  try {
    TimeoutConfig.invalidate()
    ;(Session.updatePart as any) = mock(async (input: MessageV2.Part | { part: MessageV2.Part; delta?: string }) => {
      const part = scenario.updatePart ? await scenario.updatePart(input) : "part" in input ? input.part : input
      parts.set(part.id, part)
      return part
    })
    ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
    ;(Session.updateMessage as any) = mock(async (message: MessageV2.Assistant) => message)
    ;(Session.updateLastExchange as any) = mock(async () => {})
    ;(Config.current as any) = mock(
      async () => scenario.config ?? { experimental: {}, timeout: { tool: { default_sec: 60 } } },
    )
    ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
    ;(ExperienceEncoder.onComplete as any) = mock(() => {})
    ;(LLM.stream as any) = mock(async () => ({
      fullStream: scenario.stream(processor),
    }))

    processor = SessionProcessor.create({
      assistantMessage: {
        id: scenario.messageID,
        sessionID: "ses_test",
        role: "assistant",
        parentID: "msg_user",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        agent: "synergy",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0 },
      },
      sessionID: "ses_test",
      model: { id: "test-model", modelID: "test-model", providerID: "test-provider" } as any,
      abort: new AbortController().signal,
    })

    await processor.process({} as any)
    return [...parts.values()]
  } finally {
    TimeoutConfig.invalidate()
    ;(LLM.stream as any) = originalStream
    ;(Session.updatePart as any) = originalUpdatePart
    ;(MessageV2.parts as any) = originalParts
    ;(Session.updateMessage as any) = originalUpdateMessage
    ;(Session.updateLastExchange as any) = originalUpdateLastExchange
    ;(Config.current as any) = originalConfigCurrent
    ;(Plugin.trigger as any) = originalPluginTrigger
    ;(ExperienceEncoder.onComplete as any) = originalExperienceComplete
  }
}

function firstTool(parts: MessageV2.Part[], callID?: string) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool" && (!callID || part.callID === callID))
}

function completedOutcome(tool: string, output: string, metadata: Record<string, any> = {}) {
  return {
    output,
    title: `${tool} result`,
    metadata,
  }
}

describe("SessionProcessor execution slot settlement", () => {
  test("settles a synthetic non-bash slot that resolves before the running part exists", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_slot_first",
      async *stream(processor) {
        yield { type: "start" }
        processor
          .beginExecution("call_slot_first")
          .complete({ value: 1 }, completedOutcome("synthetic", "slot completed first", { family: "synthetic" }))
        yield { type: "tool-call", toolCallId: "call_slot_first", toolName: "synthetic", input: { value: 1 } }
      },
    })

    const tool = firstTool(parts, "call_slot_first")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") {
      expect(tool.state.output).toBe("slot completed first")
      expect(tool.state.metadata.family).toBe("synthetic")
    }
  })

  test("settles a synthetic non-bash slot when the running part exists before resolution", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_part_first",
      async *stream(processor) {
        yield { type: "start" }
        yield { type: "tool-call", toolCallId: "call_part_first", toolName: "synthetic", input: { value: 2 } }
        processor
          .beginExecution("call_part_first")
          .complete({ value: 2 }, completedOutcome("synthetic", "part completed first"))
      },
    })

    const tool = firstTool(parts, "call_part_first")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") expect(tool.state.output).toBe("part completed first")
  })

  test("settles a synthetic non-bash slot without any tool-result stream event", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_no_tool_result",
      async *stream(processor) {
        yield { type: "start" }
        const slot = processor.beginExecution("call_no_tool_result")
        yield { type: "tool-call", toolCallId: "call_no_tool_result", toolName: "synthetic", input: { value: 3 } }
        slot.complete({ value: 3 }, completedOutcome("synthetic", "no tool-result needed"))
      },
    })

    const tool = firstTool(parts, "call_no_tool_result")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") expect(tool.state.output).toBe("no tool-result needed")
  })

  test("runs a completed tool post-persist effect after the tool part is durable", async () => {
    let persisted = false
    let committed = false
    await runSettlementScenario({
      messageID: "msg_assistant_post_persist",
      updatePart: async (input) => {
        const part = "part" in input ? input.part : input
        if (part.type === "tool" && part.state.status === "completed") {
          expect(committed).toBe(false)
          persisted = true
        }
        return part
      },
      async *stream(processor) {
        yield { type: "start" }
        const slot = processor.beginExecution("call_post_persist")
        yield { type: "tool-call", toolCallId: "call_post_persist", toolName: "synthetic", input: {} }
        slot.complete(
          {},
          {
            ...completedOutcome("synthetic", "persisted result"),
            afterPersist: async () => {
              expect(persisted).toBe(true)
              committed = true
            },
          },
        )
      },
    })

    expect(committed).toBe(true)
  })

  test("settles a resolved slot even when no tool-call stream part arrives", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_slot_only",
      async *stream(processor) {
        yield { type: "start" }
        processor
          .beginExecution("call_slot_only", "synthetic")
          .complete({ value: 7 }, completedOutcome("synthetic", "slot-only result"))
        yield { type: "finish" }
      },
    })

    const tools = parts.filter(
      (part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === "call_slot_only",
    )
    expect(tools).toHaveLength(1)
    const tool = tools[0]
    expect(tool.state.status).toBe("completed")
    if (tool.state.status === "completed") {
      expect(tool.tool).toBe("synthetic")
      expect(tool.state.input).toEqual({ value: 7 })
      expect(tool.state.output).toBe("slot-only result")
    }
  })

  test("settles a synthetic tool error outcome instead of unresolved", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_slot_error",
      async *stream(processor) {
        yield { type: "start" }
        const slot = processor.beginExecution("call_slot_error")
        yield { type: "tool-call", toolCallId: "call_slot_error", toolName: "synthetic", input: { value: 4 } }
        slot.fail({ value: 4 }, "synthetic failed", { reason: "expected_failure" })
      },
    })

    const tool = firstTool(parts, "call_slot_error")
    expect(tool?.state.status).toBe("error")
    if (tool?.state.status === "error") {
      expect(tool.state.error).toBe("synthetic failed")
      expect(tool.state.metadata?.reason).toBe("expected_failure")
    }
  })

  test("does not persist a duplicate tool part when a settled call is replayed before tool-error", async () => {
    const callID = "call_replayed_after_settlement"
    const input = { filePath: "/tmp/missing.txt" }
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_replayed_after_settlement",
      async *stream(processor) {
        yield { type: "start" }
        processor.beginExecution(callID).fail(input, "file not found", { source: "execution" })
        yield { type: "tool-call", toolCallId: callID, toolName: "view_file", input }
        yield { type: "tool-input-start", id: callID, toolName: "view_file" }
        yield { type: "tool-call", toolCallId: callID, toolName: "view_file", input }
        yield { type: "tool-error", toolCallId: callID, error: new Error("AI SDK tool error") }
      },
    })

    const toolParts = parts.filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === callID)
    expect(toolParts.map((part) => part.state.status)).toEqual(["error"])
    expect(toolParts[0]?.state.status === "error" ? toolParts[0].state.error : undefined).toBe("file not found")
  })

  test("does not persist a duplicate tool part after fallback tool-error settlement", async () => {
    const callID = "call_replayed_after_fallback"
    const input = { path: "missing.txt" }
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_replayed_after_fallback",
      async *stream() {
        yield { type: "start" }
        yield { type: "tool-call", toolCallId: callID, toolName: "view_file", input }
        yield { type: "tool-error", toolCallId: callID, error: new Error("AI SDK tool error") }
        yield { type: "tool-call", toolCallId: callID, toolName: "view_file", input }
      },
    })

    const toolParts = parts.filter((part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === callID)
    expect(toolParts).toHaveLength(1)
    expect(toolParts[0]?.state.status).toBe("error")
  })

  describe("broad tool failure observability", () => {
    beforeEach(() => resetObservabilityHome("synergy-processor-tool-failure-"))
    afterEach(() => cleanupObservabilityHomes())

    for (const scenario of [
      {
        callID: "call_unknown_tool",
        tool: "hallucinated_tool",
        error: new Error("Model tried to call unavailable tool 'hallucinated_tool'"),
        errorClass: "unknown_tool",
        startsToolInput: false,
      },
      {
        callID: "call_invalid_arguments",
        tool: "bash",
        error: new Error("Invalid tool input: expected command to be a string"),
        errorClass: "invalid_arguments",
        startsToolInput: true,
      },
    ]) {
      test(`records LLM ${scenario.errorClass} failures that never enter the executor`, async () => {
        await runSettlementScenario({
          messageID: `msg_${scenario.callID}`,
          async *stream() {
            yield { type: "start" }
            if (scenario.startsToolInput) {
              yield { type: "tool-input-start", id: scenario.callID, toolName: scenario.tool }
            }
            yield {
              type: "tool-error",
              toolCallId: scenario.callID,
              toolName: scenario.tool,
              input: {},
              error: scenario.error,
            }
          },
        })
        ObservabilityStore.flush()

        const metrics = ObservabilityStore.queryMetrics({
          since: 0,
          names: ["tool.execution.count", "tool.execution.error"],
        })
        expect(
          metrics.filter((row) => row.call_id === scenario.callID && row.name === "tool.execution.count"),
        ).toHaveLength(1)
        const errors = metrics.filter((row) => row.call_id === scenario.callID && row.name === "tool.execution.error")
        expect(errors).toHaveLength(1)
        expect(JSON.parse(errors[0]!.labels_json).errorName).toBe(scenario.errorClass)

        const issues = ObservabilityStore.queryIssues({ status: "open", module: "tool", tool: scenario.tool })
        expect(issues).toHaveLength(1)
        expect(JSON.parse(issues[0]!.evidence_json)).toMatchObject({
          tool: scenario.tool,
          phase: "llm.tool_call",
          errorClass: scenario.errorClass,
          owner: "llm",
          callID: scenario.callID,
        })
      })
    }

    test("does not double-count executor failures when the stream later emits tool-error", async () => {
      const callID = "call_executor_then_stream_error"
      const tool = "bash"
      const error = new Error("executor failed")
      await runSettlementScenario({
        messageID: "msg_executor_then_stream_error",
        async *stream(processor) {
          yield { type: "start" }
          const slot = processor.beginExecution(callID)
          ObservabilityToolFailures.record({
            tool,
            sessionID: "ses_test",
            messageID: "msg_executor_then_stream_error",
            callID,
            phase: "tool.execute",
            error,
            owner: "builtin",
          })
          slot.fail({ command: "exit 1" }, error.message)
          yield { type: "tool-call", toolCallId: callID, toolName: tool, input: { command: "exit 1" } }
          yield { type: "tool-error", toolCallId: callID, toolName: tool, input: { command: "exit 1" }, error }
        },
      })
      ObservabilityStore.flush()

      const metrics = ObservabilityStore.queryMetrics({
        since: 0,
        names: ["tool.execution.count", "tool.execution.error"],
        tool,
      })
      expect(metrics.filter((row) => row.call_id === callID && row.name === "tool.execution.count")).toHaveLength(1)
      expect(metrics.filter((row) => row.call_id === callID && row.name === "tool.execution.error")).toHaveLength(1)

      const issues = ObservabilityStore.queryIssues({ status: "open", module: "tool", tool })
      expect(issues).toHaveLength(1)
      expect(issues[0]!.occurrence_count).toBe(1)
      expect(JSON.parse(issues[0]!.evidence_json)).toMatchObject({ owner: "builtin", phase: "tool.execute" })
    })
  })

  test("settles a save_file create-file outcome without tool-result", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_save_file",
      async *stream(processor) {
        yield { type: "start" }
        const input = { filePath: "/tmp/new-file.txt", content: "hello" }
        const slot = processor.beginExecution("call_save_file")
        yield { type: "tool-call", toolCallId: "call_save_file", toolName: "save_file", input }
        slot.complete(input, {
          output: "[/tmp/new-file.txt#ABCD]\n1:hello",
          title: "Create File",
          metadata: { filepath: "/tmp/new-file.txt", exists: false, tag: "ABCD" },
        })
      },
    })

    const tool = firstTool(parts, "call_save_file")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") {
      expect(tool.tool).toBe("save_file")
      expect(tool.state.metadata.exists).toBe(false)
      expect(tool.state.output).toContain("#ABCD")
    }
  })

  test("settles a save_file error outcome as tool error", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_save_file_error",
      async *stream(processor) {
        yield { type: "start" }
        const input = { filePath: "/tmp/denied.txt", content: "hello" }
        const slot = processor.beginExecution("call_save_file_error")
        yield { type: "tool-call", toolCallId: "call_save_file_error", toolName: "save_file", input }
        slot.fail(input, "permission denied", { source: "permission" })
      },
    })

    const tool = firstTool(parts, "call_save_file_error")
    expect(tool?.state.status).toBe("error")
    if (tool?.state.status === "error") {
      expect(tool.state.error).toBe("permission denied")
      expect(tool.state.metadata?.source).toBe("permission")
    }
  })

  test("settles a write-like outcome without metadata fallback", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_write",
      async *stream(processor) {
        yield { type: "start" }
        const input = { filePath: "/tmp/write.txt", content: "updated" }
        const slot = processor.beginExecution("call_write")
        yield { type: "tool-call", toolCallId: "call_write", toolName: "write", input }
        slot.complete(input, completedOutcome("write", "Wrote /tmp/write.txt", { filepath: "/tmp/write.txt" }))
      },
    })

    const tool = firstTool(parts, "call_write")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") {
      expect(tool.tool).toBe("write")
      expect(tool.state.output).toBe("Wrote /tmp/write.txt")
    }
  })

  test("settles bash from the slot instead of running metadata", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_bash_slot",
      async *stream(processor) {
        yield { type: "start" }
        const input = { command: "git status --short" }
        const slot = processor.beginExecution("call_bash")
        yield { type: "tool-call", toolCallId: "call_bash", toolName: "bash", input }
        slot.complete(input, completedOutcome("bash", " M file.ts\n", { exit: 0 }))
      },
    })

    const tool = firstTool(parts, "call_bash")
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") {
      expect(tool.state.output).toBe(" M file.ts\n")
      expect(tool.state.metadata.exit).toBe(0)
    }
  })

  test("settles parallel tool calls independently", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_parallel",
      async *stream(processor) {
        yield { type: "start" }
        const first = processor.beginExecution("call_parallel_a")
        const second = processor.beginExecution("call_parallel_b")
        yield { type: "tool-call", toolCallId: "call_parallel_a", toolName: "write", input: { filePath: "a" } }
        yield { type: "tool-call", toolCallId: "call_parallel_b", toolName: "bash", input: { command: "git log -1" } }
        second.complete({ command: "git log -1" }, completedOutcome("bash", "commit b\n"))
        first.complete({ filePath: "a" }, completedOutcome("write", "wrote a"))
      },
    })

    const first = firstTool(parts, "call_parallel_a")
    const second = firstTool(parts, "call_parallel_b")
    expect(first?.state.status).toBe("completed")
    expect(second?.state.status).toBe("completed")
    if (first?.state.status === "completed") expect(first.state.output).toBe("wrote a")
    if (second?.state.status === "completed") expect(second.state.output).toBe("commit b\n")
  })

  test("keeps a resolved outcome available when the first settlement write fails and retries in finalization", async () => {
    let failedOnce = false
    const parts = new Map<string, MessageV2.Part>()
    const settledParts = await runSettlementScenario({
      messageID: "msg_assistant_retry_settlement",
      updatePart: async (input) => {
        const part = "part" in input ? input.part : input
        if (part.type === "tool" && part.state.status === "completed" && !failedOnce) {
          failedOnce = true
          throw new Error("transient update failure")
        }
        parts.set(part.id, part)
        return part
      },
      async *stream(processor) {
        yield { type: "start" }
        const slot = processor.beginExecution("call_retry_settlement")
        yield {
          type: "tool-call",
          toolCallId: "call_retry_settlement",
          toolName: "write",
          input: { filePath: "retry" },
        }
        slot.complete({ filePath: "retry" }, completedOutcome("write", "settled after retry"))
      },
    })

    const tool = firstTool(settledParts, "call_retry_settlement")
    expect(failedOnce).toBe(true)
    expect(tool?.state.status).toBe("completed")
    if (tool?.state.status === "completed") expect(tool.state.output).toBe("settled after retry")
  })

  test("does not mark a stale running part unresolved after successful settlement", async () => {
    let completedWrites = 0
    let errorWrites = 0
    const runningParts = new Map<string, MessageV2.ToolPart>()
    await runSettlementScenario({
      messageID: "msg_assistant_stale_running_after_settle",
      updatePart: async (input) => {
        const part = "part" in input ? input.part : input
        if (part.type !== "tool") return part
        if (part.state.status === "running") runningParts.set(part.callID, part)
        if (part.state.status === "completed") {
          completedWrites++
          return runningParts.get(part.callID) ?? part
        }
        if (part.state.status === "error") errorWrites++
        return part
      },
      async *stream(processor) {
        yield { type: "start" }
        const input = { command: "git branch --show-current" }
        const slot = processor.beginExecution("call_stale_settled")
        yield { type: "tool-call", toolCallId: "call_stale_settled", toolName: "bash", input }
        slot.complete(input, completedOutcome("bash", "dev\n", { exit: 0 }))
      },
    })

    expect(completedWrites).toBe(1)
    expect(errorWrites).toBe(0)
  })

  test("marks a running part without an execution slot as missing_execution_slot", async () => {
    const parts = await runSettlementScenario({
      messageID: "msg_assistant_missing_slot",
      config: { experimental: {}, timeout: { tool: { default_sec: 0.001 } } },
      async *stream() {
        yield { type: "start" }
        yield { type: "tool-call", toolCallId: "call_missing_slot", toolName: "bash", input: { command: "git status" } }
      },
    })

    const tool = firstTool(parts, "call_missing_slot")
    expect(tool?.state.status).toBe("error")
    if (tool?.state.status === "error") {
      expect(tool.state.error).toBe("Tool execution did not return a final result")
      expect(tool.state.metadata?.reason).toBe("missing_execution_slot")
      expect(tool.state.metadata?.tool).toBe("bash")
    }
  })
})

describe("SessionProcessor.unresolvedToolError", () => {
  test("reserves aborted wording for true fast aborts", () => {
    expect(SessionProcessor.unresolvedToolError(true)).toBe("Tool execution aborted")
    expect(SessionProcessor.unresolvedToolError(false)).toBe("Tool execution did not return a final result")
  })
})

describe("SessionProcessor.isFastAbort", () => {
  test("detects pre-aborted signals", () => {
    const controller = new AbortController()
    controller.abort()

    expect(SessionProcessor.isFastAbort(controller.signal)).toBe(true)
  })

  test("detects abort errors", () => {
    const controller = new AbortController()

    expect(
      SessionProcessor.isFastAbort(controller.signal, new DOMException("The operation was aborted.", "AbortError")),
    ).toBe(true)
  })

  test("ignores normal errors while the signal is active", () => {
    const controller = new AbortController()

    expect(SessionProcessor.isFastAbort(controller.signal, new Error("boom"))).toBe(false)
  })
})
