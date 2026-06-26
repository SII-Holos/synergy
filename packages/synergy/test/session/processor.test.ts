import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"
import type { MessageV2 } from "../../src/session/message-v2"

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
