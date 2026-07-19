import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Session, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import {
  buildContextPanelModel as buildContextPanelModelInternal,
  formatContextNumber,
  formatContextPercent,
  type ContextPanelPresentation,
} from "./context-model"

type ContextUsage = NonNullable<AssistantMessage["contextUsage"]>

type TestAssistantMessage = AssistantMessage

const presentation: ContextPanelPresentation = {
  categoryLabels: {
    conversation: "Conversation",
    toolActivity: "Tool activity",
    filesReferences: "Files and references",
    instructions: "Instructions",
  },
  categoryDescriptions: {
    conversation: "Conversation description",
    toolActivity: "Tool description",
    filesReferences: "Files description",
    instructions: "Instructions description",
  },
  overheadLabel: "Overhead",
  overheadDescription: "Overhead description",
  statusPartiallyKnown: "Context size is partially known",
  statusCompacting: "Compacting conversation…",
  statusCompacted: "Conversation compacted; usage available after the next response",
  statusCritical: "Very little context space remains",
  statusWarning: "This context is getting full",
  statusReady: "Enough room to continue",
  untitledSession: "Untitled session",
  formatCurrency: (value, currency) => `${currency} ${value.toFixed(2)}`,
}

function buildContextPanelModel(input: Omit<Parameters<typeof buildContextPanelModelInternal>[0], "presentation">) {
  return buildContextPanelModelInternal({ ...input, presentation })
}

function contextUsage(input: Partial<ContextUsage> = {}): ContextUsage {
  return {
    version: 1 as const,
    modelID: "model_a",
    providerID: "provider_a",
    totalInput: 600,
    contextLimit: 1_000,
    usableInputLimit: 800,
    categories: {
      conversation: { estimatedTokens: 360, attributedTokens: 300, items: 4 },
      toolActivity: { estimatedTokens: 180, attributedTokens: 140, items: 2 },
      filesReferences: { estimatedTokens: 90, attributedTokens: 80, items: 1 },
      instructions: { estimatedTokens: 70, attributedTokens: 60, items: 3 },
    },
    overhead: { attributedTokens: 20 },
    estimator: { kind: "model-tokenizer" as const, encoding: "o200k_base" },
    reconciliation: { mode: "scaled-down" as const, factor: 0.8 },
    capturedAt: 25,
    ...input,
  }
}

function assistant(input: Partial<TestAssistantMessage> = {}): TestAssistantMessage {
  return {
    id: input.id ?? "msg_002",
    sessionID: input.sessionID ?? "ses_context",
    role: "assistant",
    time: input.time ?? { created: 20, completed: 30 },
    parentID: input.parentID ?? "msg_001",
    modelID: input.modelID ?? "model_a",
    providerID: input.providerID ?? "provider_a",
    mode: input.mode ?? "agent",
    agent: input.agent ?? "synergy",
    path: input.path ?? { cwd: "/repo", root: "/repo" },
    cost: input.cost ?? 0.12,
    tokens: input.tokens ?? { input: 400, output: 40, reasoning: 60, cache: { read: 80, write: 20 } },
    ...input,
  }
}

function user(id = "msg_001", input: Partial<UserMessage> = {}): UserMessage {
  return {
    id,
    sessionID: "ses_context",
    role: "user",
    isRoot: true,
    time: { created: 10 },
    agent: "synergy",
    model: { providerID: "provider_a", modelID: "model_a" },
    ...input,
  }
}

function session(input: Partial<Session> = {}): Session {
  return {
    id: input.id ?? "ses_context",
    scope: input.scope ?? { id: "scope_context", type: "project", directory: "/repo", worktree: "/repo" },
    title: input.title ?? "Context work",
    version: input.version ?? "v1",
    time: input.time ?? { created: 1_000, updated: 2_000 },
    ...input,
  }
}

const providers = {
  provider_a: {
    name: "Provider A",
    models: {
      model_a: {
        name: "Model A",
        limit: { context: 2_000, output: 200 },
      },
    },
  },
}

describe("buildContextPanelModel", () => {
  test("maps provider-exact totals and reconciled estimated categories", () => {
    const model = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ contextUsage: contextUsage() })],
      providers,
    })

    expect(model.providerLabel).toBe("Provider A")
    expect(model.modelLabel).toBe("Model A")
    expect(model.usage).toMatchObject({
      exactInputTokens: 600,
      usableInputLimit: 800,
      contextWindow: 1_000,
      remainingInputTokens: 200,
      contextPercentage: 75,
      latestCallTotalTokens: 700,
    })
    expect(model.breakdownRows.map((row) => [row.key, row.estimatedTokens, row.attributedTokens, row.percent])).toEqual(
      [
        ["conversation", 360, 300, 50],
        ["toolActivity", 180, 140, 23.3],
        ["filesReferences", 90, 80, 13.3],
        ["instructions", 70, 60, 10],
        ["overhead", null, 20, 3.3],
      ],
    )
    expect(model.breakdownRows.slice(0, 4).every((row) => row.estimated)).toBe(true)
    expect(model.breakdownRows.at(-1)?.estimated).toBe(false)
    expect(model.developerDetails).toMatchObject({
      estimatorKind: "model-tokenizer",
      estimatorEncoding: "o200k_base",
      reconciliationMode: "scaled-down",
      reconciliationFactor: 0.8,
      rawEstimatedTotal: 700,
      attributedTotal: 600,
    })
  })

  test("uses the authoritative latest projection instead of a stale history window", () => {
    const stale = assistant({ id: "msg_stale", modelID: "model_a", contextUsage: contextUsage({ totalInput: 320 }) })
    const latest = assistant({
      id: "msg_latest",
      modelID: "model_latest",
      providerID: "provider_latest",
      cost: 0.42,
      tokens: { input: 700, output: 70, reasoning: 30, cache: { read: 90, write: 10 } },
      contextUsage: contextUsage({ totalInput: 700, usableInputLimit: 800 }),
    })
    const model = buildContextPanelModel({
      session: session(),
      messages: [user(), stale],
      latestMessage: latest,
      providers: {
        ...providers,
        provider_latest: {
          name: "Latest Provider",
          models: { model_latest: { name: "Latest Model", limit: { context: 1_200, output: 200 } } },
        },
      },
    })

    expect(model.latest?.id).toBe("msg_latest")
    expect(model.providerLabel).toBe("Latest Provider")
    expect(model.modelLabel).toBe("Latest Model")
    expect(model.usage).toMatchObject({
      exactInputTokens: 700,
      outputTokens: 70,
      reasoningTokens: 30,
      latestCallTotalTokens: 800,
      cacheReadTokens: 90,
      cacheWriteTokens: 10,
      latestCallCost: "USD 0.42",
    })
  })

  test("does not fall back to stale history after an authoritative empty latest page", () => {
    const model = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ contextUsage: contextUsage() })],
      latestMessage: null,
      providers,
    })

    expect(model.latest).toBeUndefined()
    expect(model.usage.exactInputTokens).toBeNull()
    expect(model.providerLabel).toBe("—")
    expect(model.breakdownAvailable).toBe(false)
  })

  test("uses a completed compaction projection as a barrier instead of stale usage", () => {
    const barrier = assistant({
      id: "msg_compaction",
      mode: "compaction",
      modelID: "compaction_model",
      providerID: "compaction_provider",
      time: { created: 40, completed: 50 },
      tokens: { input: 900, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const model = buildContextPanelModel({
      session: session({ modelOverride: { providerID: "provider_a", modelID: "model_a" } }),
      messages: [user(), assistant({ contextUsage: contextUsage({ totalInput: 760 }) })],
      latestMessage: barrier,
      providers,
    })

    expect(model.latest).toBeUndefined()
    expect(model.providerLabel).toBe("Provider A")
    expect(model.modelLabel).toBe("Model A")
    expect(model.usage.exactInputTokens).toBeNull()
    expect(model.usage.contextPercentage).toBeNull()
    expect(model.usage.latestCallCost).toBe("—")
    expect(model.statusSummary).toBe("Conversation compacted; usage available after the next response")
    expect(model.compact.visible).toBe(false)
  })

  test("uses locked status summaries and compact eligibility thresholds", () => {
    const at80 = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ contextUsage: contextUsage({ totalInput: 640 }) })],
      providers,
      status: { type: "idle" },
    })
    expect(at80.statusSummary).toBe("This context is getting full")
    expect(at80.statusTone).toBe("warning")
    expect(at80.compact).toMatchObject({ visible: true, eligible: true, inProgress: false })

    const at95 = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ contextUsage: contextUsage({ totalInput: 760 }) })],
      providers,
      status: { type: "idle" },
    })
    expect(at95.statusSummary).toBe("Very little context space remains")
    expect(at95.statusTone).toBe("critical")

    const below80 = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ contextUsage: contextUsage({ totalInput: 600 }) })],
      providers,
    })
    expect(below80.statusSummary).toBe("Enough room to continue")
    expect(below80.compact.visible).toBe(false)
  })

  test("disables compact while session work or inbox items are pending", () => {
    const messages: Message[] = [user(), assistant({ contextUsage: contextUsage({ totalInput: 680 }) })]
    const busy = buildContextPanelModel({
      session: session(),
      messages,
      providers,
      status: { type: "busy" },
    })
    expect(busy.compact).toMatchObject({ visible: true, eligible: false, inProgress: false })

    const queued = buildContextPanelModel({ session: session(), messages, providers, pendingItems: 1 })
    expect(queued.compact.eligible).toBe(false)
  })

  test("reports compaction progress from local requests and incomplete compaction messages", () => {
    const snapshot = contextUsage({ totalInput: 680 })
    const localPending = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ contextUsage: snapshot })],
      providers,
      compactRequestPending: true,
    })
    expect(localPending.statusSummary).toBe("Compacting conversation…")
    expect(localPending.statusTone).toBe("progress")
    expect(localPending.compact).toMatchObject({ visible: true, eligible: false, pending: true, inProgress: true })

    const streaming = buildContextPanelModel({
      session: session(),
      messages: [
        user(),
        assistant({ contextUsage: snapshot }),
        assistant({ id: "msg_compact", mode: "compaction", time: { created: 40 } }),
      ],
      providers,
    })
    expect(streaming.statusSummary).toBe("Compacting conversation…")
    expect(streaming.compact.inProgress).toBe(true)
  })

  test("keeps totals available when the model limit or category snapshot is unknown", () => {
    const model = buildContextPanelModel({ session: session(), messages: [user(), assistant()], providers: {} })

    expect(model.breakdownAvailable).toBe(false)
    expect(model.breakdownRows).toEqual([])
    expect(model.usage.exactInputTokens).toBe(500)
    expect(model.usage.usableInputLimit).toBeNull()
    expect(model.usage.contextPercentage).toBeNull()
    expect(model.statusSummary).toBe("Context size is partially known")
    expect(model.compact.visible).toBe(false)
  })

  test("treats output-only legacy provider usage as unknown input", () => {
    const model = buildContextPanelModel({
      session: session(),
      messages: [user(), assistant({ tokens: { input: 0, output: 80, reasoning: 20, cache: { read: 0, write: 0 } } })],
      providers,
    })

    expect(model.usage.exactInputTokens).toBeNull()
    expect(model.usage.contextPercentage).toBeNull()
    expect(model.usage.outputTokens).toBe(80)
    expect(model.statusSummary).toBe("Context size is partially known")
  })

  test("returns safe defaults for a session with no messages", () => {
    const model = buildContextPanelModel({ session: undefined, messages: [], providers: {} })

    expect(model.usage.exactInputTokens).toBeNull()
    expect(model.usage.contextPercentage).toBeNull()
    expect(model.breakdownAvailable).toBe(false)
    expect(model.providerLabel).toBe("—")
    expect(model.modelLabel).toBe("—")
    expect(model.developerDetails.title).toBe("Untitled session")
  })

  test("omits zero overhead and preserves the four fixed categories", () => {
    const model = buildContextPanelModel({
      session: session(),
      messages: [
        assistant({
          contextUsage: contextUsage({
            totalInput: 580,
            overhead: { attributedTokens: 0 },
            reconciliation: { mode: "residual", factor: 1 },
          }),
        }),
      ],
      providers,
    })

    expect(model.breakdownRows.map((row) => row.key)).toEqual([
      "conversation",
      "toolActivity",
      "filesReferences",
      "instructions",
    ])
    expect(model.developerDetails.attributedTotal).toBe(580)
  })

  test("derives instructions and effective counts from canonical message fields", () => {
    const model = buildContextPanelModel({
      session: session({ title: "Detailed", time: { created: 1_000, updated: 3_000 } }),
      messages: [
        user("msg_001", { system: "  First instructions  " }),
        user("msg_hidden", { visible: false, system: "Hidden instructions" }),
        user("msg_excluded", { includeInContext: false, system: "Excluded instructions" }),
        user("msg_latest", { time: { created: 15 }, system: "  Effective instructions\n" }),
        assistant(),
      ],
      providers,
    })

    expect(model.latestUserSystemOverride).toBe("Effective instructions")
    expect(model.usage.loadedMessagesCost).toBe("USD 0.12")
    expect(model.developerDetails).toMatchObject({
      title: "Detailed",
      sessionID: "ses_context",
      effectiveMessages: 4,
      effectiveUserMessages: 3,
      effectiveAssistantMessages: 1,
      createdAt: 1_000,
      updatedAt: 3_000,
    })
  })
})

describe("context formatting", () => {
  test("keeps unknown values distinct from zero", () => {
    const formatNumber = (value: number) => `n:${value}`
    const formatPercent = (value: number) => `p:${value}`
    expect(formatContextNumber(null, formatNumber)).toBe("—")
    expect(formatContextNumber(undefined, formatNumber)).toBe("—")
    expect(formatContextNumber(0, formatNumber)).toBe("n:0")
    expect(formatContextNumber(1_000_000, formatNumber)).toBe("n:1000000")
    expect(formatContextPercent(null, formatPercent)).toBe("—")
    expect(formatContextPercent(0, formatPercent)).toBe("p:0")
    expect(formatContextPercent(75, formatPercent)).toBe("p:0.75")
  })
})
