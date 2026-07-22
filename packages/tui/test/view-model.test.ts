import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { buildMessageView, renderPart } from "../src/view-model"

const base = { id: "p1", sessionID: "s1", messageID: "m1" }

function assistant(): AssistantMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "u1",
    modelID: "model",
    providerID: "provider",
    mode: "assistant",
    agent: "synergy",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0.0123,
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 1 } },
  }
}

function user(): UserMessage {
  return {
    id: "u1",
    sessionID: "s1",
    role: "user",
    time: { created: 1 },
    agent: "synergy",
    model: { providerID: "provider", modelID: "model" },
    summary: {
      diffs: [{ file: "src/a.ts", additions: 2, deletions: 1, preview: "@@ -1 +1 @@\n-old\n+new" }],
    },
  }
}

describe("TUI message view model", () => {
  test("sanitizes text and renders markdown while preserving Unicode", () => {
    const block = renderPart({ ...base, type: "text", text: "# 你好 👋🏽\n\u001b[31munsafe" })
    expect(block).toMatchObject({ kind: "markdown", tone: "normal" })
    expect(block.content).toBe("# 你好 👋🏽\nunsafe")
  })

  test("collapses reasoning unless explicitly expanded", () => {
    const part = { ...base, type: "reasoning", text: "hidden chain", time: { start: 1 } } satisfies Part
    expect(renderPart(part)).toMatchObject({ kind: "text", content: "▸ Reasoning · 12 characters", collapsible: true })
    expect(renderPart(part, { expandedReasoning: new Set(["p1"]) })).toMatchObject({
      kind: "markdown",
      content: "hidden chain",
      tone: "muted",
      collapsible: true,
    })
  })

  test("renders every tool lifecycle and bounds large output", () => {
    const states = [
      { status: "pending", input: {}, raw: "" },
      { status: "generating", input: {}, raw: "{", charsReceived: 1 },
      { status: "running", input: {}, title: "Reading", time: { start: 1 } },
      {
        status: "completed",
        input: {},
        output: "x".repeat(6000),
        title: "Read file",
        metadata: {},
        time: { start: 1, end: 2 },
        outputTruncated: true,
      },
      { status: "error", input: {}, error: "boom\u001b[2J", time: { start: 1, end: 2 } },
    ] satisfies Array<Extract<Part, { type: "tool" }>["state"]>

    const rendered = states.map((state, index) =>
      renderPart({ ...base, id: `tool-${index}`, type: "tool", callID: `call-${index}`, tool: "read", state }),
    )
    expect(rendered.map((block) => block.tone)).toEqual(["warning", "accent", "accent", "success", "danger"])
    expect(rendered[3]?.content.length).toBeLessThan(5000)
    expect(rendered[3]?.content).toContain("output truncated")
    expect(rendered[3]?.content.split("\n").slice(1).join("\n").length).toBeLessThanOrEqual(4096)
    expect(rendered[4]?.content).not.toContain("\u001b")
  })

  test("renders steps, attachment, patch, retry, compaction, and recovery", () => {
    const parts: Part[] = [
      { ...base, id: "step", type: "step-start", snapshot: "abc" },
      {
        ...base,
        id: "finish",
        type: "step-finish",
        reason: "stop",
        cost: 0.1,
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      },
      {
        ...base,
        id: "attach",
        type: "attachment",
        mime: "image/png",
        filename: "a.png",
        url: "file:///a",
        localPath: "/a",
      },
      { ...base, id: "snapshot", type: "snapshot", snapshot: "hash" },
      { ...base, id: "patch", type: "patch", hash: "hash", files: ["a.ts", "b.ts"] },
      {
        ...base,
        id: "retry",
        type: "retry",
        attempt: 2,
        error: { name: "APIError", data: { message: "rate limit", isRetryable: true } },
        time: { created: 1 },
      },
      { ...base, id: "compact", type: "compaction", auto: true },
      {
        ...base,
        id: "recovery",
        type: "compaction_recovery",
        summary: "Recovered",
        mechanical: true,
        validated: true,
        recoverySessionIDs: ["child"],
      },
    ]
    const content = parts.map((part) => renderPart(part).content).join("\n")
    expect(content).toContain("Step started")
    expect(content).toContain("tokens 1 in · 2 out · 3 reasoning")
    expect(content).toContain("a.png · image/png · /a")
    expect(content).toContain("Snapshot hash")
    expect(content).toContain("a.ts, b.ts")
    expect(content).toContain("Retry 2 · rate limit")
    expect(content).toContain("Context compacted · automatic")
    expect(content).toContain("Recovered · mechanical · validated · sessions child")
  })

  test("adds message metadata, errors, and diff previews", () => {
    const userView = buildMessageView(user(), [{ ...base, messageID: "u1", type: "text", text: "change it" }])
    expect(userView.label).toBe("YOU")
    expect(userView.blocks.some((block) => block.kind === "diff" && block.content.includes("+new"))).toBe(true)

    const failed = assistant()
    failed.error = { name: "UnknownError", data: { message: "failed\u001b[31m" } }
    const assistantView = buildMessageView(failed, [])
    expect(assistantView.label).toContain("SYNERGY")
    expect(assistantView.meta).toContain("20 out")
    expect(assistantView.blocks.at(-1)).toMatchObject({ tone: "danger", content: "failed" })
  })

  test("keeps sanitized-empty agent and tool labels visible", () => {
    const hiddenAgent = assistant()
    hiddenAgent.agent = "\u001b[31m\u001b[0m"
    const message = buildMessageView(hiddenAgent, [])
    const tool = renderPart({
      ...base,
      type: "tool",
      callID: "call-hidden",
      tool: "\u001b[31m\u001b[0m",
      state: { status: "pending", input: {}, raw: "" },
    })

    expect(message.label).toBe("SYNERGY · unknown agent")
    expect(message.meta).toContain("unknown agent")
    expect(tool.content).toBe("○ Unknown tool · waiting")
  })

  test("degrades malformed runtime errors to a safe fallback", () => {
    const retry = renderPart({
      ...base,
      type: "retry",
      attempt: 1,
      error: { name: "UnknownError" },
      time: { created: 1 },
    } as unknown as Part)

    expect(retry.content).toBe("↻ Retry 1 · Unknown error")
  })
})
