import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Message as MessageType, UserMessage } from "@ericsanchezok/synergy-sdk/client"

const Empty = () => null

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
mock.module("@lingui/solid", () => ({
  useLingui: () => ({ _: (descriptor: { message?: string; id: string }) => descriptor.message ?? descriptor.id }),
}))
mock.module("../../src/context", () => ({ useData: () => ({ store: {}, serverUrl: "" }) }))
mock.module("../../src/context/diff", () => ({ useDiffComponent: () => Empty }))
mock.module("../../src/hooks", () => ({
  createAutoScroll: () => ({
    contentRef: undefined,
    forceScrollToBottom: () => {},
    handleInteraction: () => {},
    handleScroll: () => {},
    scrollRef: undefined,
  }),
}))
mock.module("../../src/components/accordion", () => {
  const Accordion = Object.assign(Empty, { Content: Empty, Item: Empty, Trigger: Empty })
  return { Accordion }
})
mock.module("../../src/components/attachment-card", () => ({ AttachmentGallery: Empty }))
mock.module("../../src/components/button", () => ({ Button: Empty }))
mock.module("../../src/components/clipboard", () => ({
  createCopyController: () => ({
    copied: () => false,
    copy: () => {},
    disabled: () => false,
    icon: () => "copy",
    state: () => "idle",
    tooltip: () => "Copy Markdown",
  }),
}))
mock.module("../../src/components/activity-trace", () => ({
  ActivityReasoningSummary: Empty,
  ActivityReceipt: Empty,
  ActivityTrace: Empty,
  MinimalActivitySummary: Empty,
}))
mock.module("../../src/components/diff-changes", () => ({ DiffChanges: Empty }))
mock.module("../../src/components/compaction-card", () => ({ CompactionCard: Empty }))
mock.module("../../src/components/error-card", () => ({ ErrorCard: Empty }))
mock.module("../../src/components/file-icon", () => ({ FileIcon: Empty }))
mock.module("../../src/components/icon", () => ({ Icon: Empty }))
mock.module("../../src/components/media-generation-card", () => ({ MediaGenerationCard: Empty }))
mock.module("../../src/components/message-part", () => ({
  Message: Empty,
  Part: Empty,
  getToolInfo: (tool: string) => ({ icon: "activity", title: tool }),
}))
mock.module("../../src/components/session-turn.css", () => ({}))
mock.module("../../src/components/turn-change-summary-panel", () => ({ TurnChangeSummaryPanel: Empty }))
mock.module("../../src/components/special-user-message", () => ({ getSpecialUserMessageRenderer: () => undefined }))
mock.module("../../src/components/tool-renders", () => ({}))

const { collectCompactionParentIDs, collectMessagesForTurnLifecycle } = await import(
  "../../src/components/session-turn"
)
const { buildSessionTurnProjection } = await import("../../src/components/session-turn-projection")

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

function assistantFor(id: string, parentID: string, opts?: { visible?: boolean }): AssistantMessage {
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
    visible: opts?.visible ?? true,
  } as AssistantMessage
}

const byId = (messages: readonly MessageType[]) => new Map(messages.map((m) => [m.id, m]))

describe("buildSessionTurnProjection", () => {
  test("roots match rootMessages().filter(visible !== false) order", () => {
    const messages = [
      user("r1", { isRoot: true }),
      assistantFor("a1", "r1"),
      user("r2", { isRoot: true }),
      user("hidden", { isRoot: true, visible: false }),
      user("r3", { isRoot: true }),
    ]
    const projection = buildSessionTurnProjection(messages)
    expect(projection.roots.map((m) => m.id)).toEqual(["r1", "r2", "r3"])
  })

  test("byRoot members match collectMessagesForTurnLifecycle for each root", () => {
    const messages = [
      user("r1", { isRoot: true }),
      assistantFor("a1", "r1"),
      user("steer", { isRoot: false, rootID: "r1" }),
      user("r2", { isRoot: true }),
      assistantFor("a2", "r2"),
      assistantFor("a3", "r1"), // interleaved task reply (queued task pre-allocation)
    ]
    const projection = buildSessionTurnProjection(messages)
    for (const root of projection.roots) {
      const legacy = collectMessagesForTurnLifecycle(messages, root.id)
      const projected = projection.turnMessagesFor(root)
      expect(projected.map((m) => m.id)).toEqual(legacy.map((m) => m.id))
    }
  })

  test("non-root anchor (steer) turn members match legacy collector from that message", () => {
    const messages = [
      user("r1", { isRoot: true }),
      assistantFor("a1", "r1"),
      user("steer", { isRoot: false, rootID: "r1" }),
      assistantFor("a2", "r1"),
    ]
    const projection = buildSessionTurnProjection(messages)
    const steer = byId(messages).get("steer") as UserMessage
    const legacy = collectMessagesForTurnLifecycle(messages, steer.id)
    expect(projection.turnMessagesFor(steer).map((m) => m.id)).toEqual(legacy.map((m) => m.id))
    expect(projection.turnMessagesFor(steer).map((m) => m.id)).toEqual(["a2"])
  })

  test("compactionParentIDs match collectCompactionParentIDs", () => {
    const messages = [
      user("r1", { isRoot: true, metadata: { compactionBoundary: true, compactionParentID: "parent-1" } }),
      user("r2", { isRoot: true, metadata: { compactionBoundary: true } }), // no parentID
      user("r3", { isRoot: true, metadata: { compactionParentID: "parent-2" } }), // no boundary
      user("r4", { isRoot: true, metadata: { compactionBoundary: true, compactionParentID: "parent-3" } }),
    ]
    const projection = buildSessionTurnProjection(messages)
    const legacy = collectCompactionParentIDs(messages)
    expect(projection.compactionParentIDs).toEqual(legacy)
    expect([...projection.compactionParentIDs].sort()).toEqual(["parent-1", "parent-3"])
  })

  test("rollback-filtered input aligns turn members with the trimmed timeline", () => {
    // session.tsx builds the projection from messages() which applies
    // messagesHiddenByRollback; during rollback the post-cut messages are
    // removed, so earlier turns no longer surface them. The projection must
    // faithfully reflect the filtered input (consistency improvement over the
    // legacy raw-store scan).
    const filtered = [user("r1", { isRoot: true }), assistantFor("a1", "r1")]
    const projection = buildSessionTurnProjection(filtered)
    expect(projection.roots.map((m) => m.id)).toEqual(["r1"])
    expect(projection.turnMessagesFor(projection.roots[0]).map((m) => m.id)).toEqual(["a1"])
  })

  test("single pass O(N): hidden non-root user without root entry is skipped", () => {
    // A non-root message whose root is not in the window (anomalous) must be
    // skipped — mirroring legacy collector's root-relative scan.
    const messages = [user("orphan", { isRoot: false, rootID: "missing" })]
    const projection = buildSessionTurnProjection(messages)
    expect(projection.roots).toEqual([])
    expect(projection.turnMessagesFor(messages[0] as UserMessage)).toEqual([])
  })

  test("hidden assistant messages stay in raw turn members (component filters)", () => {
    const hiddenAssistant = assistantFor("a2", "r1", { visible: false })
    const projection = buildSessionTurnProjection([
      user("r1", { isRoot: true }),
      assistantFor("a1", "r1"),
      hiddenAssistant,
    ])
    // Visibility filtering lives in the component (filterMessagesForTurnDisplay);
    // the projection carries raw members so the component keeps its semantics.
    expect(projection.turnMessagesFor(projection.roots[0]).map((m) => m.id)).toEqual(["a1", "a2"])
  })

  test("turnMessagesFor(undefined) returns an empty array without throwing", () => {
    // conversation.tsx passes the row-level getter result as the anchor; a
    // session-switch window replacement can transiently yield undefined, which
    // must degrade to an empty turn instead of crashing on anchor.rootID.
    const projection = buildSessionTurnProjection([user("r1", { isRoot: true }), assistantFor("a1", "r1")])
    expect(projection.turnMessagesFor(undefined)).toEqual([])
  })
})
