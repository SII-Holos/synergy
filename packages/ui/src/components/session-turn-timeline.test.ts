import { describe, expect, mock, test } from "bun:test"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  SessionStatus,
  UserMessage,
} from "@ericsanchezok/synergy-sdk/client"

const Empty = () => null

mock.module("@ericsanchezok/synergy-util/binary", () => ({
  Binary: {
    search: <T>(items: T[], value: string, getValue: (item: T) => string) => {
      const index = items.findIndex((item) => getValue(item) === value)
      return index >= 0 ? { found: true, index } : { found: false, index: -1 }
    },
  },
}))
mock.module("@ericsanchezok/synergy-util/model-limit", () => ({
  ModelLimit: {
    actualInput: (tokens: { input: number; cache: { read: number; write: number } }) =>
      tokens.input + tokens.cache.read + tokens.cache.write,
  },
}))
mock.module("@ericsanchezok/synergy-util/path", () => ({
  getDirectory: (path: string) => path.slice(0, path.lastIndexOf("/")),
  getFilename: (path: string) => path.slice(path.lastIndexOf("/") + 1),
}))
mock.module("solid-js", () => ({
  createEffect: () => {},
  createMemo: (fn: () => unknown) => fn,
  createSignal: (initial: unknown) => {
    let value = initial
    return [() => value, (next: unknown) => (value = typeof next === "function" ? next(value) : next)]
  },
  ErrorBoundary: Empty,
  For: Empty,
  Match: Empty,
  on: (_source: unknown, fn: unknown) => fn,
  onCleanup: () => {},
  Show: Empty,
  Switch: Empty,
}))
mock.module("solid-js/store", () => ({
  createStore: (initial: unknown) => [initial, () => {}],
}))
mock.module("solid-js/web", () => ({ Dynamic: Empty }))
mock.module("../context", () => ({ useData: () => ({ store: {}, serverUrl: "" }) }))
mock.module("../context/diff", () => ({ useDiffComponent: () => Empty }))
mock.module("../hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    forceScrollToBottom: () => {},
    handleInteraction: () => {},
    handleScroll: () => {},
    scrollRef: undefined,
  }),
}))
mock.module("./accordion", () => {
  const Accordion = Object.assign(Empty, { Content: Empty, Item: Empty, Trigger: Empty })
  return { Accordion }
})
mock.module("./attachment-card", () => ({ AttachmentGallery: Empty }))
mock.module("./button", () => ({ Button: Empty }))
mock.module("./clipboard", () => ({
  createCopyController: () => ({
    copied: () => false,
    copy: () => {},
    disabled: () => false,
    icon: () => "copy",
    state: () => "idle",
    tooltip: () => "Copy Markdown",
  }),
}))
mock.module("./diff-changes", () => ({ DiffChanges: Empty }))
mock.module("./compaction-card", () => ({ CompactionCard: Empty }))
mock.module("./error-card", () => ({ ErrorCard: Empty }))
mock.module("./file-icon", () => ({ FileIcon: Empty }))
mock.module("./icon", () => ({ Icon: Empty }))
mock.module("./media-generation-card", () => ({ MediaGenerationCard: Empty }))
mock.module("./message-part", () => ({ Message: Empty, Part: Empty }))
mock.module("./session-turn.css", () => ({}))
mock.module("./turn-change-summary-panel", () => ({ TurnChangeSummaryPanel: Empty }))
mock.module("./special-user-message", () => ({ getSpecialUserMessageRenderer: () => undefined }))
mock.module("./tool-renders", () => ({}))
mock.module("./typewriter", () => ({ Typewriter: Empty }))

const {
  collectAssistantMessagesForTurn,
  collectCompactionParentIDs,
  collectMessagesForTurnDisplay,
  collectSessionTurnTimelineItems,
  collectUserCompactionTimelineItems,
  isGuidedContextUserMessage,
  shouldShowTurnDiffs,
  shouldShowTurnUserChrome,
  formatTurnCost,
  formatTurnTokenCount,
  providerPreludeElapsedLabel,
  providerPreludeText,
  shouldShowProviderPrelude,
  turnCompletionStats,
  timelineItemStableKey,
  timelineVisualKind,
} = await import("./session-turn")

function user(
  id: string,
  opts?: { isRoot?: boolean; rootID?: string; visible?: boolean; metadata?: UserMessage["metadata"] },
): UserMessage {
  const isRoot = opts?.isRoot ?? true
  return {
    id,
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: "synergy",
    model: { providerID: "provider", modelID: "model" },
    isRoot,
    rootID: opts?.rootID ?? id,
    visible: opts?.visible ?? true,
    metadata: opts?.metadata,
  } as UserMessage
}

function assistant(id: string): AssistantMessage {
  return assistantFor(id, "user")
}

function assistantFor(id: string, parentID: string): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    parentID,
    rootID: parentID,
    mode: "test",
    agent: "synergy",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "model",
    providerID: "provider",
    time: { created: 1 },
  } as AssistantMessage
}

function completedAssistant(id: string): AssistantMessage {
  return {
    ...assistant(id),
    time: { created: 1, completed: 2 },
  } as AssistantMessage
}

function compactionAssistant(id: string, parentID = "user"): AssistantMessage {
  return {
    ...assistantFor(id, parentID),
    mode: "compaction",
    agent: "compaction",
    summary: true,
  } as AssistantMessage
}

function compactionRecoveryPart(id: string, messageID: string): PartType {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "compaction_recovery",
    summary: "## Current work\n- Keep the UI stable",
    mechanical: false,
    validated: true,
  } as PartType
}

function compactionPart(id: string, messageID: string): PartType {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "compaction",
    auto: false,
  } as PartType
}

function textPart(id: string, messageID: string, text = "Hello"): PartType {
  return {
    id,
    sessionID: "session",
    messageID,
    type: "text",
    text,
  } as PartType
}

const image = {
  id: "file-image",
  sessionID: "session",
  messageID: "assistant-a",
  type: "attachment" as const,
  mime: "image/svg+xml",
  filename: "meme.svg",
  url: "asset://meme",
}

function mediaTool(input: {
  id: string
  messageID: string
  status: "pending" | "generating" | "running" | "completed"
  attachments?: (typeof image)[]
}): PartType {
  return {
    id: input.id,
    sessionID: "session",
    messageID: input.messageID,
    type: "tool",
    callID: `call-${input.id}`,
    tool: "plugin__synergy-meme-plugin__generate_meme",
    state:
      input.status === "completed"
        ? {
            status: "completed",
            input: { prompt: "random meme" },
            output: "",
            title: "Meme",
            metadata: {
              display: {
                kind: "media-generation",
                toolCard: "hidden",
              },
            },
            attachments: input.attachments ?? [image],
            time: { start: 1, end: 2 },
          }
        : input.status === "running"
          ? {
              status: "running",
              input: { prompt: "random meme" },
              metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
              time: { start: 1 },
            }
          : {
              status: input.status,
              input: {},
              raw: '{"prompt":"random meme"',
              charsReceived: input.status === "generating" ? 23 : undefined,
              metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
            },
  } as PartType
}

function ordinaryTool(input: {
  id: string
  messageID: string
  status: "pending" | "generating" | "running" | "completed"
}): PartType {
  return {
    id: input.id,
    sessionID: "session",
    messageID: input.messageID,
    type: "tool",
    callID: `call-${input.id}`,
    tool: "read",
    state:
      input.status === "completed"
        ? {
            status: "completed",
            input: { filePath: "report.md" },
            output: "done",
            title: "report.md",
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : input.status === "running"
          ? {
              status: "running",
              input: { filePath: "report.md" },
              metadata: {},
              time: { start: 1 },
            }
          : {
              status: input.status,
              input: {},
              raw: '{"filePath":"report.md"}',
              charsReceived: input.status === "generating" ? 24 : undefined,
              metadata: {},
            },
  } as PartType
}

describe("session turn assistant collection", () => {
  test("keeps guided inbox context inside the active turn", () => {
    const firstUser = user("msg_001_user")
    const toolStep = assistantFor("msg_002_assistant_tool", firstUser.id)
    const guided = user("msg_003_user_guided", { isRoot: false, rootID: firstUser.id })
    const final = assistantFor("msg_004_assistant_final", firstUser.id)

    expect(isGuidedContextUserMessage(guided)).toBe(true)
    expect(collectMessagesForTurnDisplay([firstUser, toolStep, guided, final] as MessageType[], firstUser.id)).toEqual([
      toolStep,
      guided,
      final,
    ])
    expect(
      collectAssistantMessagesForTurn([firstUser, toolStep, guided, final] as MessageType[], firstUser.id).map(
        (message) => message.id,
      ),
    ).toEqual([toolStep.id, final.id])
  })

  test("omits invisible non-root context from turn display", () => {
    const firstUser = user("msg_001_user")
    const hidden = user("msg_002_hidden", { isRoot: false, rootID: firstUser.id, visible: false })
    const final = assistantFor("msg_003_assistant_final", firstUser.id)

    expect(collectMessagesForTurnDisplay([firstUser, hidden, final] as MessageType[], firstUser.id)).toEqual([final])
  })

  test("collects only assistants belonging to this task's root", () => {
    const firstUser = user("msg_001_user")
    const firstAssistant = assistantFor("msg_002_assistant", firstUser.id)
    const nextUser = user("msg_003_user")
    // Belongs to the next task's root, so it is not part of the first turn.
    const nextAssistant = assistantFor("msg_004_assistant", nextUser.id)

    expect(
      collectAssistantMessagesForTurn(
        [firstUser, firstAssistant, nextUser, nextAssistant] as MessageType[],
        firstUser.id,
      ).map((message) => message.id),
    ).toEqual([firstAssistant.id])
  })

  test("collects interleaved replies from a task whose queued root pre-dates them", () => {
    // A queued task root pre-allocates its id, so a still-running earlier task
    // can emit an assistant after this root but before this task's own replies.
    const earlierRoot = user("msg_001_user")
    const queuedRoot = user("msg_002_queued_root")
    const earlierLateReply = assistantFor("msg_003_earlier_reply", earlierRoot.id)
    const queuedReply = assistantFor("msg_004_queued_reply", queuedRoot.id)

    expect(
      collectAssistantMessagesForTurn(
        [earlierRoot, queuedRoot, earlierLateReply, queuedReply] as MessageType[],
        queuedRoot.id,
      ).map((message) => message.id),
    ).toEqual([queuedReply.id])
  })

  test("stops the previous turn at a synthetic compaction boundary", async () => {
    await import("./special-user-message")
    const firstUser = user("msg_001_user")
    const firstAssistant = assistantFor("msg_002_assistant", firstUser.id)
    const boundary = user("msg_003_boundary", {
      isRoot: false,
      visible: false,
      metadata: { synthetic: true, compactionBoundary: true },
    })
    const compaction = compactionAssistant("msg_004_compaction", boundary.id)

    expect(
      collectAssistantMessagesForTurn(
        [firstUser, firstAssistant, boundary, compaction] as MessageType[],
        firstUser.id,
      ).map((message) => message.id),
    ).toEqual([firstAssistant.id])
    expect(
      collectAssistantMessagesForTurn(
        [firstUser, firstAssistant, boundary, compaction] as MessageType[],
        boundary.id,
      ).map((message) => message.id),
    ).toEqual([compaction.id])
  })

  test("hides synthetic compaction chrome while keeping the recovery card", () => {
    const compactionUser = user("msg_compaction", { visible: false, metadata: { synthetic: true } })
    const recovery = compactionRecoveryPart("recovery", compactionUser.id)
    const parts = [
      { ...textPart("synthetic-continue", compactionUser.id, "Continue if you have next steps"), synthetic: true },
      recovery,
    ] as PartType[]

    const cardItems = collectUserCompactionTimelineItems(compactionUser, parts)

    expect(cardItems).toHaveLength(1)
    expect(cardItems[0]).toMatchObject({ kind: "compaction", part: recovery })
    expect(shouldShowTurnUserChrome(compactionUser, parts, true)).toBe(false)
    expect(
      shouldShowTurnDiffs(
        { metadata: compactionUser.metadata, summary: { diffs: [{ file: "file.ts", additions: 1, deletions: 0 }] } },
        { hasCompactionEvent: true },
      ),
    ).toBe("hidden")
  })

  test("manual compaction root: suppresses chrome and renders the card during the wait (#326)", () => {
    // The /compact button creates a root user message marked as a compaction
    // boundary; its "What did we do so far?" prompt must not render as user
    // chrome, and the compaction card must appear even before the recovery part
    // exists (the "Compressing context..." state).
    const root = user("msg_manual_compact", { isRoot: true, metadata: { compactionBoundary: true } })
    const parts = [
      compactionPart("compaction-request", root.id),
      textPart("prompt", root.id, "What did we do so far?"),
    ] as PartType[]
    const compaction = compactionAssistant("msg_compaction_assistant", root.id)

    const rootItems = collectUserCompactionTimelineItems(root, parts)
    expect(rootItems).toHaveLength(1)
    expect(rootItems[0]).toMatchObject({ kind: "compaction", message: root, part: parts[0] })

    // No compaction_recovery yet (LLM still running), part is undefined on the
    // assistant card until the structured recovery part is written.
    const items = collectSessionTurnTimelineItems([compaction], {}, true)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "compaction", message: compaction })
    expect((items[0] as { part?: unknown }).part).toBeUndefined()

    // Chrome is suppressed because the root is a compaction boundary.
    expect(shouldShowTurnUserChrome(root, parts, true)).toBe(false)
  })

  test("hides diffs for the turn compacted by a boundary", () => {
    const parent = {
      ...user("msg_parent"),
      summary: { diffs: [{ file: "file.ts", additions: 1, deletions: 0 }] },
    } as UserMessage
    const boundary = user("msg_boundary", {
      isRoot: false,
      visible: false,
      metadata: { synthetic: true, compactionBoundary: true, compactionParentID: parent.id },
    })
    const compactedParents = collectCompactionParentIDs([parent, boundary] as MessageType[])

    expect(compactedParents.has(parent.id)).toBe(true)
    expect(shouldShowTurnDiffs(parent, { isCompactedParent: compactedParents.has(parent.id) })).toBe("hidden")
  })

  test("projects persisted diff settlement state without guessing from diff presence", () => {
    const diff = { file: "file.ts", additions: 1, deletions: 0 }

    expect(shouldShowTurnDiffs({ summary: { diffs: [diff] } })).toBe("ready")
    expect(
      shouldShowTurnDiffs(
        { summary: { diffs: [], diffState: { status: "pending", deadlineAt: 2_000 } } },
        { now: 1_000 },
      ),
    ).toBe("pending")
    expect(
      shouldShowTurnDiffs(
        { summary: { diffs: [], diffState: { status: "pending", deadlineAt: 999 } } },
        { now: 1_000 },
      ),
    ).toBe("error")
    expect(shouldShowTurnDiffs({ summary: { diffs: [], diffState: { status: "error", code: "unknown" } } })).toBe(
      "error",
    )
    expect(shouldShowTurnDiffs({ summary: { diffs: [diff], diffState: { status: "ready" } } })).toBe("ready")
    expect(shouldShowTurnDiffs({ summary: { diffs: [], diffState: { status: "ready" } } })).toBe("hidden")
    expect(shouldShowTurnDiffs({ summary: { diffs: [] } })).toBe("hidden")
  })
})

describe("session turn timeline", () => {
  test("shows provider prelude while the first assistant response has no visible part", () => {
    expect(
      shouldShowProviderPrelude({
        working: true,
        hasError: false,
        latestAssistant: undefined,
        latestAssistantTimelineItems: [],
      }),
    ).toBe(true)
  })

  test("shows provider prelude after prior visible work when the latest assistant response is empty", () => {
    const previous = completedAssistant("assistant-a")
    const latest = assistant("assistant-b")
    const previousItems = collectSessionTurnTimelineItems(
      [previous],
      { [previous.id]: [ordinaryTool({ id: "tool-a", messageID: previous.id, status: "completed" })] },
      true,
    )
    const latestItems = collectSessionTurnTimelineItems([latest], {}, true)

    expect(previousItems).toHaveLength(1)
    expect(latestItems).toHaveLength(0)
    expect(
      shouldShowProviderPrelude({
        working: true,
        hasError: false,
        latestAssistant: latest,
        latestAssistantTimelineItems: latestItems,
      }),
    ).toBe(true)
  })

  test("hides provider prelude once the latest assistant response has a visible part", () => {
    const latest = assistant("assistant-a")
    const latestItems = collectSessionTurnTimelineItems(
      [latest],
      { [latest.id]: [textPart("text-a", latest.id)] },
      true,
    )

    expect(latestItems).toHaveLength(1)
    expect(
      shouldShowProviderPrelude({
        working: true,
        hasError: false,
        latestAssistant: latest,
        latestAssistantTimelineItems: latestItems,
      }),
    ).toBe(false)
  })

  test("hides provider prelude when the turn is not actively waiting", () => {
    const latest = assistant("assistant-a")

    expect(
      shouldShowProviderPrelude({
        working: false,
        hasError: false,
        latestAssistant: latest,
        latestAssistantTimelineItems: [],
      }),
    ).toBe(false)
    expect(
      shouldShowProviderPrelude({
        working: true,
        hasError: true,
        latestAssistant: latest,
        latestAssistantTimelineItems: [],
      }),
    ).toBe(false)
    expect(
      shouldShowProviderPrelude({
        working: true,
        hasError: false,
        latestAssistant: completedAssistant("assistant-b"),
        latestAssistantTimelineItems: [],
      }),
    ).toBe(false)
  })

  test("keeps backend provider prelude status text verbatim", () => {
    const status = {
      type: "busy",
      description: "Awaiting response…",
    } satisfies SessionStatus

    expect(providerPreludeText(status)).toBe("Awaiting response…")
    expect(providerPreludeText({ type: "busy" })).toBe("Awaiting response…")
  })

  test("formats provider prelude elapsed time as a quiet timer label", () => {
    expect(providerPreludeElapsedLabel(1_000, 1_000)).toBe("00:00")
    expect(providerPreludeElapsedLabel(1_000, 2_000)).toBe("00:01")
    expect(providerPreludeElapsedLabel(1_000, 61_000)).toBe("01:00")
    expect(providerPreludeElapsedLabel(1_000, 3_601_000)).toBe("1:00:00")
    expect(providerPreludeElapsedLabel(undefined, 1_000)).toBeUndefined()
  })

  test("formats completed turn token and cost labels compactly", () => {
    expect(formatTurnTokenCount(999)).toBe("999")
    expect(formatTurnTokenCount(12_345)).toBe("12.3k")
    expect(formatTurnTokenCount(1_250_000)).toBe("1.3M")
    expect(formatTurnCost(0)).toBeUndefined()
    expect(formatTurnCost(0.0042)).toBe("$0.0042")
    expect(formatTurnCost(0.04)).toBe("$0.04")
  })

  test("builds completed turn stats from assistant timing, tokens, reasoning, and cost", () => {
    const message = {
      ...completedAssistant("assistant-stats"),
      time: { created: 1_000, completed: 62_000 },
      tokens: {
        input: 12_345,
        output: 678,
        reasoning: 42,
        cache: { read: 100, write: 0 },
      },
      cost: 0.0042,
    } as AssistantMessage

    expect(turnCompletionStats([message])).toEqual({
      duration: "01:01",
      segments: ["12.3k input", "100 cache read", "678 output", "42 reasoning", "$0.0042"],
    })
  })

  test("builds completed turn stats for textless or zero-cost turns", () => {
    const message = {
      ...completedAssistant("assistant-stats"),
      time: { created: 1_000, completed: 3_601_000 },
      tokens: {
        input: 0,
        output: 2048,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
    } as AssistantMessage

    expect(turnCompletionStats([message])).toEqual({
      duration: "1:00:00",
      segments: ["2,048 output"],
    })
  })

  test("aggregates completed turn stats across all assistant messages in the turn", () => {
    const first = {
      ...completedAssistant("assistant-first"),
      time: { created: 1_000, completed: 10_000 },
      tokens: {
        input: 1_000,
        output: 200,
        reasoning: 20,
        cache: { read: 100, write: 50 },
      },
      cost: 0.01,
    } as AssistantMessage
    const second = {
      ...completedAssistant("assistant-second"),
      time: { created: 20_000, completed: 62_000 },
      tokens: {
        input: 2_000,
        output: 300,
        reasoning: 30,
        cache: { read: 0, write: 0 },
      },
      cost: 0.02,
    } as AssistantMessage

    expect(turnCompletionStats([first, second])).toEqual({
      duration: "01:01",
      segments: ["3,000 input", "100 cache read", "50 cache write", "500 output", "50 reasoning", "$0.03"],
    })
  })

  test("does not build completed turn stats before all assistant messages complete", () => {
    expect(turnCompletionStats([])).toBeUndefined()
    expect(turnCompletionStats([assistant("assistant-running")])).toBeUndefined()
    expect(turnCompletionStats([completedAssistant("assistant-done"), assistant("assistant-running")])).toBeUndefined()
  })

  test("keeps reasoning before a running media placeholder and later text", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "Thinking about a meme.",
      } as PartType,
      mediaTool({ id: "tool-a", messageID: message.id, status: "running" }),
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "来啦",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, true)

    expect(items.map((item) => item.kind)).toEqual(["reasoning", "media-pending", "part"])
    expect(items[0]).toMatchObject({ kind: "reasoning", part: { type: "reasoning" } })
    expect(items[2]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("shows a media placeholder from pending and generating tool input states", () => {
    const message = assistant("assistant-a")

    for (const status of ["pending", "generating"] as const) {
      const items = collectSessionTurnTimelineItems(
        [message],
        { [message.id]: [mediaTool({ id: `tool-${status}`, messageID: message.id, status })] },
        true,
      )

      expect(items.map((item) => item.kind)).toEqual(["media-pending"])
    }
  })

  test("hides completed-turn reasoning without moving later parts", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "Hidden after completion.",
      } as PartType,
      mediaTool({ id: "tool-a", messageID: message.id, status: "completed" }),
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "done",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, false)

    expect(items.map((item) => item.kind)).toEqual(["tool-attachments", "part"])
    expect(items[0]).toMatchObject({ kind: "tool-attachments", files: [image] })
    expect(items[1]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("promotes reasoning to text when completed turn has no text parts", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "The user asked for a simple greeting.",
      } as PartType,
      {
        id: "reasoning-b",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "I should respond with 'Hello'.",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, false)

    expect(items.map((item) => item.kind)).toEqual(["part", "part"])
    expect(items[0]).toMatchObject({
      kind: "part",
      part: { type: "reasoning", text: "The user asked for a simple greeting." },
    })
    expect(items[1]).toMatchObject({
      kind: "part",
      part: { type: "reasoning", text: "I should respond with 'Hello'." },
    })
  })

  test("keeps reasoning as reasoning while turn is still working", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "Still thinking...",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, true)

    expect(items.map((item) => item.kind)).toEqual(["reasoning"])
  })

  test("does not promote reasoning when there is a regular text part present", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      {
        id: "reasoning-a",
        sessionID: "session",
        messageID: message.id,
        type: "reasoning",
        text: "I will greet the user.",
      } as PartType,
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "Hello!",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, false)

    // reasoning stays hidden (not promoted), only text shows as part
    expect(items.map((item) => item.kind)).toEqual(["part"])
    expect(items[0]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("renders compaction assistants as one event card while hiding streaming text", () => {
    const message = compactionAssistant("assistant-compaction")
    const streamingItems = collectSessionTurnTimelineItems(
      [message],
      { [message.id]: [textPart("text-stream", message.id, "Raw compaction tokens")] },
      true,
    )

    expect(streamingItems).toHaveLength(1)
    expect(streamingItems[0]).toMatchObject({ kind: "compaction", part: undefined })
    expect(timelineVisualKind(streamingItems[0])).toBe("compaction")
    expect(timelineItemStableKey(streamingItems[0])).toBe("compaction:assistant-compaction")

    const recovery = compactionRecoveryPart("recovery", message.id)
    const completedItems = collectSessionTurnTimelineItems(
      [message],
      { [message.id]: [textPart("text-stream", message.id, "Raw compaction tokens"), recovery] },
      false,
    )

    expect(completedItems).toHaveLength(1)
    expect(completedItems[0]).toMatchObject({ kind: "compaction", part: recovery })
    expect(timelineItemStableKey(completedItems[0])).toBe("compaction:assistant-compaction")
  })

  test("keeps tool-call prelude text as text display", () => {
    const message = {
      ...assistant("assistant-a"),
      finish: "tool-calls",
    }
    const part = {
      id: "text-a",
      sessionID: "session",
      messageID: message.id,
      type: "text",
      text: "Let me inspect the relevant files first.",
    } as PartType

    const items = collectSessionTurnTimelineItems([message], { [message.id]: [part] }, false)

    expect(items).toHaveLength(1)
    expect(timelineVisualKind(items[0])).toBe("text")
  })

  test("keeps final assistant text as text display", () => {
    const message = {
      ...assistant("assistant-a"),
      finish: "stop",
    }
    const part = {
      id: "text-a",
      sessionID: "session",
      messageID: message.id,
      type: "text",
      text: "Here is the final answer.",
    } as PartType

    const items = collectSessionTurnTimelineItems([message], { [message.id]: [part] }, false)

    expect(items).toHaveLength(1)
    expect(timelineVisualKind(items[0])).toBe("text")
  })

  test("keeps completed media before later text and render tool across messages", () => {
    const first = assistant("assistant-a")
    const second = assistant("assistant-b")
    const third = assistant("assistant-c")
    const renderTool = {
      id: "render-c",
      sessionID: "session",
      messageID: third.id,
      type: "tool",
      callID: "call-render",
      tool: "render",
      state: {
        status: "completed",
        input: { html: "<div>Hello</div>" },
        output: "Rendered HTML",
        title: "HTML preview",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as PartType
    const partsByMessage: Record<string, PartType[]> = {
      [first.id]: [mediaTool({ id: "tool-a", messageID: first.id, status: "completed" })],
      [second.id]: [
        {
          id: "text-b",
          sessionID: "session",
          messageID: second.id,
          type: "text",
          text: "好了，我直接用 SVG 画一个给你",
        } as PartType,
      ],
      [third.id]: [renderTool],
    }

    const items = collectSessionTurnTimelineItems([first, second, third], partsByMessage, false)

    expect(items.map((item) => item.kind)).toEqual(["tool-attachments", "part", "part"])
    expect(items[0]).toMatchObject({ kind: "tool-attachments", files: [image] })
    expect(items[1]).toMatchObject({ kind: "part", part: { type: "text" } })
    expect(items[2]).toMatchObject({ kind: "part", part: { type: "tool", tool: "render" } })
  })

  test("keeps ordinary tool attachments inside the ordinary tool item", () => {
    const message = assistant("assistant-a")
    const readTool = {
      id: "read-a",
      sessionID: "session",
      messageID: message.id,
      type: "tool",
      callID: "call-read",
      tool: "read",
      state: {
        status: "completed",
        input: { file_path: "report.pdf" },
        output: "Read report.pdf",
        title: "report.pdf",
        metadata: {},
        attachments: [image],
        time: { start: 1, end: 2 },
      },
    } as PartType

    const items = collectSessionTurnTimelineItems([message], { [message.id]: [readTool] }, false)

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "part", part: { type: "tool", tool: "read" } })
  })

  test("hides completed media tools without attachments when their tool card is hidden", () => {
    const message = assistant("assistant-a")
    const parts: PartType[] = [
      mediaTool({ id: "tool-a", messageID: message.id, status: "completed", attachments: [] }),
      {
        id: "text-a",
        sessionID: "session",
        messageID: message.id,
        type: "text",
        text: "继续",
      } as PartType,
    ]

    const items = collectSessionTurnTimelineItems([message], { [message.id]: parts }, false)

    expect(items.map((item) => item.kind)).toEqual(["part"])
    expect(items[0]).toMatchObject({ kind: "part", part: { type: "text" } })
  })

  test("keeps ordinary tool timeline key stable across state updates", () => {
    const message = assistant("assistant-a")
    const keys = (["pending", "generating", "running", "completed"] as const).map((status) => {
      const items = collectSessionTurnTimelineItems(
        [message],
        { [message.id]: [ordinaryTool({ id: "tool-a", messageID: message.id, status })] },
        status !== "completed",
      )

      expect(items).toHaveLength(1)
      return timelineItemStableKey(items[0])
    })

    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe("tool:assistant-a:tool-a")
  })

  test("changes timeline key when a media tool changes render shape", () => {
    const message = assistant("assistant-a")
    const pending = collectSessionTurnTimelineItems(
      [message],
      { [message.id]: [mediaTool({ id: "tool-a", messageID: message.id, status: "pending" })] },
      true,
    )
    const completed = collectSessionTurnTimelineItems(
      [message],
      { [message.id]: [mediaTool({ id: "tool-a", messageID: message.id, status: "completed" })] },
      false,
    )

    expect(timelineItemStableKey(pending[0])).toBe("media-pending:assistant-a:tool-a")
    expect(timelineItemStableKey(completed[0])).toBe("tool-attachments:assistant-a:tool-a")
  })
})
