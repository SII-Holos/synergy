import { afterEach, describe, expect, mock, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ContextUsage } from "../../src/session/context-usage"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"

const originalCountModel = Token.countModel

function userMessage(parts: MessageV2.Part[], includeInContext = true): MessageV2.WithParts {
  return {
    info: {
      id: "msg_user",
      sessionID: "ses_test",
      role: "user",
      time: { created: 0 },
      agent: "synergy",
      model: { providerID: "test", modelID: "test-model" },
      mode: "build",
      includeInContext,
    } as MessageV2.User,
    parts,
  }
}

function assistantMessage(parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: "msg_assistant",
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 0 },
      parentID: "msg_user",
      modelID: "test-model",
      providerID: "test",
      mode: "build",
      agent: "synergy",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant,
    parts,
  }
}

function part<T extends Omit<MessageV2.Part, "id" | "sessionID" | "messageID">>(input: T): MessageV2.Part {
  return {
    id: crypto.randomUUID(),
    sessionID: "ses_test",
    messageID: "msg_user",
    ...input,
  } as MessageV2.Part
}

afterEach(() => {
  ;(Token.countModel as any) = originalCountModel
})

describe("ContextUsage provenance and measurement", () => {
  test("classifies mutually exclusive prompt contributions with model-aware tokenization", async () => {
    const measured: string[] = []
    ;(Token.countModel as any) = mock(async (_modelID: string, text: string) => {
      measured.push(text)
      return text.length
    })

    const history = MessageV2.projectModelMessages([
      userMessage([
        part({ type: "text", text: "pasted code", origin: "user" }),
        part({ type: "text", text: "runtime guidance", origin: "system" }),
        part({
          type: "attachment",
          mime: "text/plain",
          filename: "notes.txt",
          url: "asset://notes",
          model: { mode: "content", text: "file contents" },
        }),
      ]),
      assistantMessage([
        part({ type: "text", text: "assistant reply" }),
        part({ type: "reasoning", text: "reasoning", time: { start: 0 } }),
        part({
          type: "tool",
          tool: "read",
          callID: "call_1",
          state: {
            status: "completed",
            input: { filePath: "source.ts" },
            output: "file read result",
            title: "Read",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        }),
      ]),
    ]).provenance
    const provenance = ContextUsage.buildProvenance({
      history,
      toolDefinitions: [
        {
          id: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
        },
      ],
      instructions: ["max-step guard"],
    })

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: ["base instructions"],
      provenance,
    })
    if (!draft) throw new Error("Expected context usage draft")

    expect(draft.categories.conversation).toEqual({
      estimatedTokens: "pasted code".length + "assistant reply".length + "reasoning".length,
      items: 3,
    })
    expect(draft.categories.instructions).toEqual({
      estimatedTokens: "base instructions".length + "runtime guidance".length + "max-step guard".length,
      items: 3,
    })
    expect(draft.categories.filesReferences).toEqual({ estimatedTokens: "file contents".length, items: 1 })
    expect(draft.categories.toolActivity.items).toBe(3)
    expect(draft.categories.toolActivity.estimatedTokens).toBeGreaterThan("file read result".length)
    expect(measured).toContain("pasted code")
    expect(measured).toContain("base instructions")
    expect(measured).toContain("max-step guard")
    expect(JSON.stringify(draft)).not.toContain("pasted code")
    expect(JSON.stringify(draft)).not.toContain("file read result")
  })

  test("remaps categories over final planned messages and drops removed contributions", () => {
    const source = ContextUsage.buildProvenance({
      history: {
        categories: {
          conversation: [{ text: "kept conversation" }, { text: "removed conversation" }],
          toolActivity: [],
          filesReferences: [],
          instructions: [{ text: "kept instruction" }],
        },
        items: { conversation: 2, toolActivity: 0, filesReferences: 0, instructions: 1 },
      },
      toolDefinitions: [],
    })
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "kept conversation" },
          { type: "text", text: "kept instruction" },
          { type: "text", text: "inserted conversation" },
        ],
      },
      { role: "system", content: "inserted instruction" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: { type: "text", value: "inserted tool output" },
          },
        ],
      },
    ] satisfies ModelMessage[]

    const remapped = ContextUsage.remapProvenance(messages, source)

    expect(remapped.categories.conversation.map((contribution) => contribution.text)).toEqual([
      "kept conversation",
      "inserted conversation",
    ])
    expect(remapped.categories.instructions.map((contribution) => contribution.text)).toEqual([
      "kept instruction",
      "inserted instruction",
    ])
    expect(remapped.categories.toolActivity.map((contribution) => contribution.text)).toEqual(["inserted tool output"])
    expect(JSON.stringify(remapped)).not.toContain("removed conversation")
  })

  test("honors context and attachment model policy", async () => {
    ;(Token.countModel as any) = mock(async (_modelID: string, text: string) => text.length)

    const history = MessageV2.projectModelMessages([
      userMessage([part({ type: "text", text: "excluded" })], false),
      userMessage([
        part({
          type: "attachment",
          mime: "text/plain",
          url: "asset://none",
          model: { mode: "none" },
        }),
        part({
          type: "attachment",
          mime: "text/plain",
          url: "asset://summary",
          model: { mode: "summary", summary: "summary text" },
        }),
        part({
          type: "attachment",
          mime: "application/pdf",
          url: "https://provider.test/file",
          model: { mode: "provider-file", summary: "opaque file" },
        }),
      ]),
    ]).provenance
    const provenance = ContextUsage.buildProvenance({ history, toolDefinitions: [] })

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: [],
      provenance,
    })
    if (!draft) throw new Error("Expected context usage draft")

    expect(draft.categories.conversation).toEqual({ estimatedTokens: 0, items: 0 })
    expect(draft.categories.filesReferences).toEqual({
      estimatedTokens: "[Attachment: summary text]".length,
      items: 2,
    })
    expect(JSON.stringify(draft)).not.toContain("excluded")
    expect(JSON.stringify(draft)).not.toContain("opaque file")
  })

  test("returns zero categories for an empty prompt", async () => {
    ;(Token.countModel as any) = mock(async () => 0)
    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: [],
      provenance: ContextUsage.buildProvenance({
        history: MessageV2.projectModelMessages([]).provenance,
        toolDefinitions: [],
      }),
    })
    if (!draft) throw new Error("Expected context usage draft")

    expect(draft.categories).toEqual({
      conversation: { estimatedTokens: 0, items: 0 },
      toolActivity: { estimatedTokens: 0, items: 0 },
      filesReferences: { estimatedTokens: 0, items: 0 },
      instructions: { estimatedTokens: 0, items: 0 },
    })
  })

  test("does not fall back to character heuristics when tokenizer measurement is unavailable", async () => {
    ;(Token.countModel as any) = mock(async () => undefined)

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: ["system instructions"],
      provenance: ContextUsage.buildProvenance({
        history: MessageV2.projectModelMessages([userMessage([part({ type: "text", text: "conversation" })])])
          .provenance,
        toolDefinitions: [],
      }),
    })

    expect(draft).toBeUndefined()
  })
})

describe("ContextUsage reconciliation", () => {
  const draft: ContextUsage.Draft = {
    modelID: "test-model",
    providerID: "test",
    contextLimit: 1000,
    usableInputLimit: 900,
    categories: {
      conversation: { estimatedTokens: 4, items: 1 },
      toolActivity: { estimatedTokens: 3, items: 1 },
      filesReferences: { estimatedTokens: 2, items: 1 },
      instructions: { estimatedTokens: 1, items: 1 },
    },
    estimator: { kind: "model-tokenizer", encoding: "o200k_base" },
  }

  test("assigns residual provider input to overhead", () => {
    const snapshot = ContextUsage.reconcile(draft, 15, 123)

    expect(snapshot.totalInput).toBe(15)
    expect(snapshot.overhead.attributedTokens).toBe(5)
    expect(snapshot.reconciliation).toEqual({ mode: "residual", factor: 1 })
    expect(ContextUsage.attributedTotal(snapshot)).toBe(15)
    expect(snapshot.capturedAt).toBe(123)
  })

  test("uses deterministic largest-remainder allocation when estimates exceed provider input", () => {
    const snapshot = ContextUsage.reconcile(draft, 7, 123)

    expect(snapshot.categories.conversation.attributedTokens).toBe(3)
    expect(snapshot.categories.toolActivity.attributedTokens).toBe(2)
    expect(snapshot.categories.filesReferences.attributedTokens).toBe(1)
    expect(snapshot.categories.instructions.attributedTokens).toBe(1)
    expect(snapshot.overhead.attributedTokens).toBe(0)
    expect(snapshot.reconciliation).toEqual({ mode: "scaled-down", factor: 0.7 })
    expect(ContextUsage.attributedTotal(snapshot)).toBe(7)
  })

  test("normalizes all persisted token values to non-negative integers", () => {
    const malformed = structuredClone(draft)
    malformed.categories.conversation.estimatedTokens = Number.NaN
    malformed.categories.toolActivity.estimatedTokens = -10
    malformed.categories.filesReferences.estimatedTokens = 1.9

    const snapshot = ContextUsage.reconcile(malformed, 4.8, 123.9)
    expect(ContextUsage.Schema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot.totalInput).toBe(4)
    expect(snapshot.capturedAt).toBe(123)
    expect(ContextUsage.attributedTotal(snapshot)).toBe(4)
  })
})
