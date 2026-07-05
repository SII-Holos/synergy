import { describe, expect, mock, test } from "bun:test"
import { TimeoutConfig } from "../../src/util/timeout-config"
import { Config } from "../../src/config/config"
import { ExperienceEncoder } from "../../src/library/experience-encoder"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"

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

describe("SessionProcessor tracked execution settlement", () => {
  test("settles a completed tool outcome even when the stream omits tool-result", async () => {
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
      ;(Session.updatePart as any) = mock(async (input: MessageV2.Part | { part: MessageV2.Part; delta?: string }) => {
        const part = "part" in input ? input.part : input
        parts.set(part.id, part)
        return part
      })
      ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
      ;(Session.updateMessage as any) = mock(async (message: MessageV2.Assistant) => message)
      ;(Session.updateLastExchange as any) = mock(async () => {})
      ;(Config.current as any) = mock(async () => ({ experimental: {} }))
      ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
      ;(ExperienceEncoder.onComplete as any) = mock(() => {})
      ;(LLM.stream as any) = mock(async () => ({
        fullStream: (async function* () {
          yield { type: "start" }
          yield {
            type: "tool-call",
            toolCallId: "call_done",
            toolName: "bash",
            input: { command: "git log --oneline -10" },
          }
          processor.trackExecution(
            "call_done",
            Promise.resolve({
              status: "completed",
              input: { command: "git log --oneline -10" },
              result: {
                output: "abc123 first commit\n",
                title: "Recent commits",
                metadata: { exit: 0 },
              },
            }),
          )
        })(),
      }))

      processor = SessionProcessor.create({
        assistantMessage: {
          id: "msg_assistant",
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

      const tool = [...parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status === "completed") {
        expect(tool.state.output).toBe("abc123 first commit\n")
        expect(tool.state.metadata.exit).toBe(0)
      }
    } finally {
      ;(LLM.stream as any) = originalStream
      ;(Session.updatePart as any) = originalUpdatePart
      ;(MessageV2.parts as any) = originalParts
      ;(Session.updateMessage as any) = originalUpdateMessage
      ;(Session.updateLastExchange as any) = originalUpdateLastExchange
      ;(Config.current as any) = originalConfigCurrent
      ;(Plugin.trigger as any) = originalPluginTrigger
      ;(ExperienceEncoder.onComplete as any) = originalExperienceComplete
    }
  })

  test("waits for a tracked tool outcome past the fixed settle grace period", async () => {
    const originalStream = LLM.stream
    const originalUpdatePart = Session.updatePart
    const originalParts = MessageV2.parts
    const originalUpdateMessage = Session.updateMessage
    const originalUpdateLastExchange = Session.updateLastExchange
    const originalConfigCurrent = Config.current
    const originalPluginTrigger = Plugin.trigger
    const originalExperienceComplete = ExperienceEncoder.onComplete
    const originalSetTimeout = globalThis.setTimeout
    const parts = new Map<string, MessageV2.Part>()
    let processor!: SessionProcessor.Info

    try {
      TimeoutConfig.invalidate()
      ;(globalThis.setTimeout as any) = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
        return originalSetTimeout(handler, timeout === 5_000 ? 0 : timeout, ...args)
      }) as typeof setTimeout
      ;(Session.updatePart as any) = mock(async (input: MessageV2.Part | { part: MessageV2.Part; delta?: string }) => {
        const part = "part" in input ? input.part : input
        parts.set(part.id, part)
        return part
      })
      ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
      ;(Session.updateMessage as any) = mock(async (message: MessageV2.Assistant) => message)
      ;(Session.updateLastExchange as any) = mock(async () => {})
      ;(Config.current as any) = mock(async () => ({ experimental: {}, timeout: { tool: { default_sec: 60 } } }))
      ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
      ;(ExperienceEncoder.onComplete as any) = mock(() => {})
      ;(LLM.stream as any) = mock(async () => ({
        fullStream: (async function* () {
          yield { type: "start" }
          yield {
            type: "tool-call",
            toolCallId: "call_slow",
            toolName: "bash",
            input: { command: "git status" },
          }
          processor.trackExecution(
            "call_slow",
            new Promise<SessionProcessor.ToolOutcome>((resolve) => {
              originalSetTimeout(() => {
                resolve({
                  status: "completed",
                  input: { command: "git status" },
                  result: {
                    output: "working tree clean\n",
                    title: "Git status",
                    metadata: { exit: 0 },
                  },
                })
              }, 1)
            }),
          )
        })(),
      }))

      processor = SessionProcessor.create({
        assistantMessage: {
          id: "msg_assistant_slow",
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

      const tool = [...parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status === "completed") {
        expect(tool.state.output).toBe("working tree clean\n")
        expect(tool.state.metadata.exit).toBe(0)
      }
    } finally {
      ;(globalThis.setTimeout as any) = originalSetTimeout
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
  })

  test("waits briefly for tool execution registration after a tool-call", async () => {
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
        const part = "part" in input ? input.part : input
        parts.set(part.id, part)
        return part
      })
      ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
      ;(Session.updateMessage as any) = mock(async (message: MessageV2.Assistant) => message)
      ;(Session.updateLastExchange as any) = mock(async () => {})
      ;(Config.current as any) = mock(async () => ({ experimental: {}, timeout: { tool: { default_sec: 60 } } }))
      ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
      ;(ExperienceEncoder.onComplete as any) = mock(() => {})
      ;(LLM.stream as any) = mock(async () => ({
        fullStream: (async function* () {
          yield { type: "start" }
          yield {
            type: "tool-call",
            toolCallId: "call_late_registration",
            toolName: "bash",
            input: { command: "git status --porcelain=v1 --branch" },
          }
          queueMicrotask(() => {
            processor.trackExecution(
              "call_late_registration",
              Promise.resolve({
                status: "completed",
                input: { command: "git status --porcelain=v1 --branch" },
                result: {
                  output: "## dev...origin/dev\n",
                  title: "Git status",
                  metadata: { exit: 0 },
                },
              }),
            )
          })
        })(),
      }))

      processor = SessionProcessor.create({
        assistantMessage: {
          id: "msg_assistant_late_registration",
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

      const tool = [...parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status === "completed") {
        expect(tool.state.output).toBe("## dev...origin/dev\n")
      }
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
  })

  test("settles bash from running metadata when the tracked outcome is unavailable", async () => {
    const originalStream = LLM.stream
    const originalUpdatePart = Session.updatePart
    const originalParts = MessageV2.parts
    const originalUpdateMessage = Session.updateMessage
    const originalUpdateLastExchange = Session.updateLastExchange
    const originalConfigCurrent = Config.current
    const originalPluginTrigger = Plugin.trigger
    const originalExperienceComplete = ExperienceEncoder.onComplete
    const parts = new Map<string, MessageV2.Part>()

    try {
      TimeoutConfig.invalidate()
      ;(Session.updatePart as any) = mock(async (input: MessageV2.Part | { part: MessageV2.Part; delta?: string }) => {
        const part = "part" in input ? input.part : input
        parts.set(part.id, part)
        return part
      })
      ;(MessageV2.parts as any) = mock(async () => [...parts.values()])
      ;(Session.updateMessage as any) = mock(async (message: MessageV2.Assistant) => message)
      ;(Session.updateLastExchange as any) = mock(async () => {})
      ;(Config.current as any) = mock(async () => ({ experimental: {}, timeout: { tool: { default_sec: 0.001 } } }))
      ;(Plugin.trigger as any) = mock(async (_name: string, _context: unknown, value: unknown) => value)
      ;(ExperienceEncoder.onComplete as any) = mock(() => {})
      ;(LLM.stream as any) = mock(async () => ({
        fullStream: (async function* () {
          yield { type: "start" }
          yield {
            type: "tool-call",
            toolCallId: "call_metadata_only",
            toolName: "bash",
            input: { command: "git rev-parse --verify refs/heads/missing" },
          }
          const tool = [...parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
          if (tool?.state.status === "running") {
            await Session.updatePart({
              ...tool,
              state: {
                ...tool.state,
                metadata: {
                  output: "fatal: Needed a single revision\n",
                  exit: 128,
                  description: "Tests nonzero git exit handling",
                },
              },
            })
          }
        })(),
      }))

      const processor = SessionProcessor.create({
        assistantMessage: {
          id: "msg_assistant_metadata_only",
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

      const tool = [...parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status === "completed") {
        expect(tool.state.output).toBe("fatal: Needed a single revision\n")
        expect(tool.state.metadata.exit).toBe(128)
      }
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
