import { afterEach, describe, expect, mock, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ContextUsage } from "../../src/session/context-usage"
import { ContextUsageEstimator } from "../../src/session/context-usage-estimator"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"

const originalCountModel = Token.countModel
const originalEstimate = ContextUsageEstimator.estimate

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

function boundedUtf8Tokens(text: string) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4)
}

afterEach(() => {
  ;(Token.countModel as any) = originalCountModel
  ;(ContextUsageEstimator.estimate as any) = originalEstimate
})

describe("ContextUsage provenance and measurement", () => {
  test("classifies mutually exclusive prompt contributions with bounded UTF-8 estimation", async () => {
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
      estimatedTokens:
        boundedUtf8Tokens("pasted code") + boundedUtf8Tokens("assistant reply") + boundedUtf8Tokens("reasoning"),
      items: 3,
    })
    expect(draft.categories.instructions).toEqual({
      estimatedTokens:
        boundedUtf8Tokens("base instructions") +
        boundedUtf8Tokens("runtime guidance") +
        boundedUtf8Tokens("max-step guard"),
      items: 3,
    })
    expect(draft.categories.filesReferences).toEqual({
      estimatedTokens: boundedUtf8Tokens("file contents"),
      items: 1,
    })
    expect(draft.categories.toolActivity.items).toBe(3)
    expect(draft.categories.toolActivity.estimatedTokens).toBeGreaterThan(boundedUtf8Tokens("file read result"))
    expect(draft.estimator).toEqual({
      kind: "bounded-utf8",
      sampledCharacters: expect.any(Number),
      truncated: false,
    })
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
      estimatedTokens: boundedUtf8Tokens("[Attachment: summary text]"),
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

  test("does not depend on model tokenizer availability", async () => {
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

    expect(draft?.estimator.kind).toBe("bounded-utf8")
    expect(draft?.categories.conversation.estimatedTokens).toBeGreaterThan(0)
    expect(draft?.categories.instructions.estimatedTokens).toBeGreaterThan(0)
  })

  test("keeps pathological multilingual estimation off the main event loop", async () => {
    let tokenizerCalled = false
    ;(Token.countModel as any) = mock(async () => {
      tokenizerCalled = true
      const deadline = Date.now() + 100
      while (Date.now() < deadline) {}
      return 11_000
    })
    let mainLoopAdvanced = false
    const pulse = setTimeout(() => {
      mainLoopAdvanced = true
    }, 0)

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: [],
      provenance: ContextUsage.buildProvenance({
        history: {
          categories: {
            conversation: [],
            toolActivity: [{ text: "答".repeat(11_000) }],
            filesReferences: [],
            instructions: [],
          },
          items: { conversation: 0, toolActivity: 1, filesReferences: 0, instructions: 0 },
        },
        toolDefinitions: [],
      }),
    })
    clearTimeout(pulse)

    expect(mainLoopAdvanced).toBe(true)
    expect(tokenizerCalled).toBe(false)
    expect(draft?.categories.toolActivity.estimatedTokens).toBeGreaterThan(0)
    expect(draft?.estimator).toEqual({
      kind: "bounded-utf8",
      sampledCharacters: 256,
      truncated: true,
    })
  })

  test("spreads the category sample budget across selected multilingual contributions", async () => {
    const contributions = Array.from({ length: 64 }, (_, index) => ({
      text: (index < 32 ? "a" : "答").repeat(4_000),
    }))

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: [],
      provenance: {
        categories: {
          conversation: contributions,
          toolActivity: [],
          filesReferences: [],
          instructions: [],
        },
        items: { conversation: contributions.length, toolActivity: 0, filesReferences: 0, instructions: 0 },
      },
    })

    expect(draft?.categories.conversation.estimatedTokens).toBe(
      contributions.reduce((sum, contribution) => sum + boundedUtf8Tokens(contribution.text), 0),
    )
    expect(draft?.estimator).toEqual({
      kind: "bounded-utf8",
      sampledCharacters: ContextUsageEstimator.LIMITS.sampleCharactersPerCategory,
      truncated: true,
    })
  })

  test("extrapolates sampled contributions over the complete category population", async () => {
    const contributions = Array.from({ length: 128 }, () => ({ text: "a".repeat(4_000) }))

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: [],
      provenance: {
        categories: {
          conversation: contributions,
          toolActivity: [],
          filesReferences: [],
          instructions: [],
        },
        items: { conversation: contributions.length, toolActivity: 0, filesReferences: 0, instructions: 0 },
      },
    })

    expect(draft?.categories.conversation.estimatedTokens).toBe(
      contributions.reduce((sum, contribution) => sum + boundedUtf8Tokens(contribution.text), 0),
    )
    expect(draft?.categories.conversation.items).toBe(contributions.length)
  })

  test("samples mixed UTF-8 content across unsampled contributions", async () => {
    const contributions = Array.from({ length: 128 }, (_, index) => ({
      text: (index % 2 === 0 ? "a" : "答").repeat(4_000),
    }))

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: [],
      provenance: {
        categories: {
          conversation: contributions,
          toolActivity: [],
          filesReferences: [],
          instructions: [],
        },
        items: { conversation: contributions.length, toolActivity: 0, filesReferences: 0, instructions: 0 },
      },
    })

    expect(draft?.categories.conversation.estimatedTokens).toBe(
      contributions.reduce((sum, contribution) => sum + boundedUtf8Tokens(contribution.text), 0),
    )
  })

  test("fails open when the isolated estimator is unavailable", async () => {
    ;(ContextUsageEstimator.estimate as any) = mock(async () => undefined)

    const draft = await ContextUsage.measureDraft({
      modelID: "test-model",
      providerID: "test",
      instructions: ["instructions"],
      provenance: ContextUsage.buildProvenance({
        history: MessageV2.projectModelMessages([userMessage([part({ type: "text", text: "conversation" })])])
          .provenance,
        toolDefinitions: [],
      }),
    })

    expect(draft).toBeUndefined()
  })
})

describe("ContextUsageEstimator isolation", () => {
  test("rejects input outside the hard sample bound before dispatch", async () => {
    const oversized = "x".repeat(ContextUsageEstimator.LIMITS.sampleCharactersPerContribution + 1)
    const request: ContextUsageEstimator.Request = {
      categories: {
        conversation: [{ sample: oversized, sourceCharacters: oversized.length }],
        toolActivity: [],
        filesReferences: [],
        instructions: [],
      },
      sampledCharacters: oversized.length,
      truncated: false,
    }

    expect(await ContextUsageEstimator.estimate(request)).toBeUndefined()
  })

  test("drops excess work instead of queueing behind the bounded worker limit", async () => {
    const request: ContextUsageEstimator.Request = {
      categories: {
        conversation: [{ sample: "conversation", sourceCharacters: 12 }],
        toolActivity: [],
        filesReferences: [],
        instructions: [],
      },
      sampledCharacters: 12,
      truncated: false,
    }

    const first = ContextUsageEstimator.estimate(request)
    const second = ContextUsageEstimator.estimate(request)
    const excess = ContextUsageEstimator.estimate(request)

    expect(await excess).toBeUndefined()
    expect(await Promise.all([first, second])).toEqual([expect.any(Object), expect.any(Object)])
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
