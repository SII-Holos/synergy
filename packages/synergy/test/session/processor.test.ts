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
