import { describe, expect, test } from "bun:test"
import { TurnDigest } from "@/engram/turn-digest"
import type { MessageV2 } from "@/session/message-v2"
import type { Turn } from "@/session/turn"

// ---------------------------------------------------------------------------
// Test data builders — minimal objects that satisfy the type constraints
// ---------------------------------------------------------------------------

const partBase = { id: "p1", sessionID: "ses_1", messageID: "msg_1" }

function userMsg(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 1 },
      agent: "synergy",
      model: { providerID: "p", modelID: "m" },
    },
    parts,
  }
}

function assistantMsg(parentID: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: `ast_${parentID}`,
      sessionID: "ses_1",
      role: "assistant" as const,
      time: { created: 2 },
      parentID,
      modelID: "m",
      providerID: "p",
      mode: "",
      agent: "synergy",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

function textPart(text: string, opts?: { synthetic?: boolean }): MessageV2.TextPart {
  return { ...partBase, type: "text", text, synthetic: opts?.synthetic }
}

function completedTool(tool: string, title: string): MessageV2.ToolPart {
  return {
    ...partBase,
    type: "tool",
    callID: "c1",
    tool,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function errorTool(tool: string): MessageV2.ToolPart {
  return {
    ...partBase,
    type: "tool",
    callID: "c2",
    tool,
    state: {
      status: "error",
      input: {},
      error: "fail",
      time: { start: 1, end: 2 },
    },
  }
}

function pendingTool(tool: string): MessageV2.ToolPart {
  return {
    ...partBase,
    type: "tool",
    callID: "c3",
    tool,
    state: { status: "pending", input: {}, raw: "" },
  }
}

function reasoningPart(text: string): MessageV2.ReasoningPart {
  return { ...partBase, type: "reasoning", text, time: { start: 1 } }
}

function patchPart(files: string[]): MessageV2.PatchPart {
  return { ...partBase, type: "patch", hash: "abc", files }
}

function turn(user: MessageV2.WithParts, assistants: MessageV2.WithParts[]): Turn.Raw {
  return { user, assistants }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TurnDigest.summarizeTurn", () => {
  test("extracts user text and assistant text from a simple turn", () => {
    const u = userMsg("u1", [textPart("What is 1+1?")])
    const a = assistantMsg("u1", [textPart("The answer is 2.")])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.user).toBe("What is 1+1?")
    expect(result.assistant).toBe("The answer is 2.")
  })

  test("includes completed tool labels", () => {
    const u = userMsg("u1", [textPart("Run tests")])
    const a = assistantMsg("u1", [completedTool("bash", "Run unit tests"), textPart("All passed.")])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.assistant).toBe("[Tool: bash] Run unit tests\nAll passed.")
  })

  test("includes error tool labels", () => {
    const u = userMsg("u1", [textPart("Deploy")])
    const a = assistantMsg("u1", [errorTool("bash"), textPart("Deployment failed.")])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.assistant).toBe("[Tool: bash] (error)\nDeployment failed.")
  })

  test("ignores pending tools", () => {
    const u = userMsg("u1", [textPart("Do something")])
    const a = assistantMsg("u1", [pendingTool("bash"), textPart("Working on it.")])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.assistant).toBe("Working on it.")
  })

  test("filters out synthetic text parts", () => {
    const u = userMsg("u1", [textPart("Real question"), textPart("[injected context]", { synthetic: true })])
    const a = assistantMsg("u1", [textPart("Real answer"), textPart("[system note]", { synthetic: true })])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.user).toBe("Real question")
    expect(result.assistant).toBe("Real answer")
  })

  test("ignores reasoning, patch, and other non-text/tool parts", () => {
    const u = userMsg("u1", [textPart("Question")])
    const a = assistantMsg("u1", [
      reasoningPart("Let me think..."),
      textPart("Here's the answer."),
      patchPart(["src/foo.ts"]),
    ])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.assistant).toBe("Here's the answer.")
    expect(result.assistant).not.toContain("think")
    expect(result.assistant).not.toContain("foo.ts")
  })

  test("handles turn with no assistant text", () => {
    const u = userMsg("u1", [textPart("Check status")])
    const a = assistantMsg("u1", [completedTool("bash", "Show git status")])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.user).toBe("Check status")
    expect(result.assistant).toBe("[Tool: bash] Show git status")
  })

  test("handles turn with no assistant messages", () => {
    const u = userMsg("u1", [textPart("Hello")])
    const msgs = [u]

    const result = TurnDigest.summarizeTurn(turn(u, []), msgs)

    expect(result.user).toBe("Hello")
    expect(result.assistant).toBe("")
  })

  test("skips empty/whitespace-only text parts", () => {
    const u = userMsg("u1", [textPart("Q")])
    const a = assistantMsg("u1", [textPart("  \n  "), textPart("Real content")])
    const msgs = [u, a]

    const result = TurnDigest.summarizeTurn(turn(u, [a]), msgs)

    expect(result.assistant).toBe("Real content")
  })

  test("aggregates text across multiple assistant messages in a turn", () => {
    const u = userMsg("u1", [textPart("Complex task")])
    const a1 = assistantMsg("u1", [textPart("Step 1 done."), completedTool("edit", "Update config")])
    const a2 = assistantMsg("u1", [completedTool("bash", "Run tests"), textPart("All tests pass.")])
    const msgs = [u, a1, a2]

    const result = TurnDigest.summarizeTurn(turn(u, [a1, a2]), msgs)

    expect(result.assistant).toBe("Step 1 done.\n[Tool: edit] Update config\n[Tool: bash] Run tests\nAll tests pass.")
  })

  test("resolves user text across consecutive user messages (compaction boundary)", () => {
    const u1 = userMsg("u1", [textPart("First part")])
    const u2 = userMsg("u2", [textPart("Second part")])
    const a = assistantMsg("u2", [textPart("Answer")])
    const msgs = [u1, u2, a]

    const result = TurnDigest.summarizeTurn(turn(u2, [a]), msgs)

    // resolveUserText backtracks and merges consecutive user messages
    expect(result.user).toContain("Second part")
  })
})
