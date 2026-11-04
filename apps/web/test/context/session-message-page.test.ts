import { describe, expect, test } from "bun:test"
import { planMessagePageApply } from "../../src/context/session-message-page"
import {
  applyLatestPage,
  prependOlderPage,
  reconcileMessage,
  type MessageWindowState,
} from "../../src/context/session-message-window"
import { withOptimisticMessagePending } from "../../src/context/session-optimistic-message"

type TestMessage = {
  id: string
  time: { created: number; completed?: number }
  role: "user" | "assistant"
  includeInContext?: boolean
  contextUsage?: unknown
  mode?: string
  tokens?: { input: number; output: number; reasoning: number }
  label?: string
  rootID?: string
  isRoot?: boolean
  visible?: boolean
  metadata?: Record<string, unknown>
}
type TestPart = { id: string }

const message = (id: string, created: number, parts: string[] = []): { info: TestMessage; parts: TestPart[] } => ({
  info: {
    id,
    time: { created },
    role: "user",
    label: id,
  },
  parts: parts.map((partID) => ({ id: partID })),
})

const page = (
  overrides?: Partial<{
    items: ReturnType<typeof message>[]
    referencedRoots: ReturnType<typeof message>[]
    nextCursor: string | null
    hasMore: boolean
    total: number
  }>,
) => ({
  items: [],
  referencedRoots: [],
  nextCursor: null,
  hasMore: false,
  total: 0,
  ...overrides,
})

const window = (messages: TestMessage[], mode: "latest" | "history" = "latest"): MessageWindowState<TestMessage> => ({
  messages,
  mode,
  pendingLatest: false,
  pendingLatestIds: [],
  tailMissingLatest: false,
})

describe("planMessagePageApply", () => {
  test("maps the latest page, referenced roots, and cursor metadata into one window", () => {
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({
        items: [message("child", 2, ["part-2", "part-1"])],
        referencedRoots: [message("root", 1), message("child", 2)],
        nextCursor: "cursor-1",
        hasMore: true,
        total: 12,
      }),
    })

    expect(plan.window.messages.map((item) => item.id)).toEqual(["root", "child"])
    expect(plan.parts.child.map((part) => part.id)).toEqual(["part-1", "part-2"])
    expect(plan.metadata).toEqual({
      nextCursor: "cursor-1",
      hasMore: true,
      total: 12,
      mode: "latest",
      pendingLatest: false,
      pendingLatestIds: [],
      tailMissingLatest: false,
    })
  })

  test("prepends older history and keeps the newer tail when capped", () => {
    const current = window(
      [
        { id: "new-1", time: { created: 3 }, role: "user" },
        { id: "new-2", time: { created: 4 }, role: "user" },
      ],
      "history",
    )
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({
        items: [message("old-1", 1), message("old-2", 2)],
        nextCursor: "cursor-older",
        hasMore: true,
        total: 4,
      }),
      current,
      mode: "history",
      cap: 2,
    })

    expect(plan.window.messages.map((item) => item.id)).toEqual(["new-1", "new-2"])
    expect(plan.droppedIds).toEqual(["old-1", "old-2"])
    expect(plan.window.tailMissingLatest).toBe(false)
    expect(plan.metadata.mode).toBe("history")
    expect(plan.metadata.nextCursor).toBe("cursor-older")
  })

  test("keeps unseen pending messages out of the history-window total", () => {
    const current: MessageWindowState<TestMessage> = {
      messages: [{ id: "visible", time: { created: 3 }, role: "user" }],
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["pending"],
      tailMissingLatest: false,
    }
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [message("older", 1)], total: 3 }),
      current,
      mode: "history",
    })

    expect(plan.metadata.total).toBe(2)
    expect(plan.metadata.pendingLatest).toBe(true)
    expect(plan.metadata.pendingLatestIds).toEqual(["pending"])
  })

  test("does not subtract a pending ID after the loaded page makes it visible", () => {
    const current: MessageWindowState<TestMessage> = {
      messages: [{ id: "visible", time: { created: 3 }, role: "user" }],
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["older"],
      tailMissingLatest: false,
    }
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [message("older", 1)], total: 2 }),
      current,
      mode: "history",
    })

    expect(plan.metadata.total).toBe(2)
    expect(plan.metadata.pendingLatest).toBe(false)
    expect(plan.metadata.pendingLatestIds).toEqual([])
  })

  test("subtracts only ids newer than the history window from the page total", () => {
    const capped = applyLatestPage(
      [message("m1", 1), message("m2", 2), message("m3", 3), message("m4", 4)].map((item) => item.info),
      [],
      2,
    )
    const history = prependOlderPage(capped.window, [message("m2", 2).info], 2)
    const older = reconcileMessage(history.window, message("m1", 1).info, 2)
    const newer = reconcileMessage(older.window, message("m5", 5).info, 2)
    const pageInput = page({ items: [message("m0", 0)], total: 6 })

    expect(history.window.messages.map((item) => item.id)).toEqual(["m3", "m4"])
    expect(older.window.pendingLatestIds).toEqual([])

    const olderPlan = planMessagePageApply<TestMessage, TestPart>({
      page: pageInput,
      current: older.window,
      mode: "history",
      cap: 2,
    })
    expect(olderPlan.metadata.pendingLatestIds).toEqual([])
    expect(olderPlan.metadata.pendingLatest).toBe(false)
    expect(olderPlan.metadata.total).toBe(6)

    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: pageInput,
      current: newer.window,
      mode: "history",
      cap: 2,
    })
    expect(plan.window.messages.map((item) => item.id)).toEqual(["m3", "m4"])
    expect(plan.metadata.pendingLatestIds).toEqual(["m5"])
    expect(plan.metadata.pendingLatest).toBe(true)
    expect(plan.metadata.total).toBe(5)
  })

  test("prepends referenced roots from an older history page", () => {
    const current = window([{ id: "new", time: { created: 4 }, role: "user" }], "history")
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({
        items: [message("child", 2, ["child-part"])],
        referencedRoots: [message("root", 1, ["root-part"])],
        total: 3,
      }),
      current,
      mode: "history",
    })

    expect(plan.window.messages.map((item) => item.id)).toEqual(["root", "child", "new"])
    expect(plan.parts.root.map((part) => part.id)).toEqual(["root-part"])
    expect(plan.parts.child.map((part) => part.id)).toEqual(["child-part"])
  })

  test("propagates the history tail gap through plan metadata", () => {
    const current: MessageWindowState<TestMessage> = {
      messages: [{ id: "new", time: { created: 4 }, role: "user" }],
      mode: "history",
      pendingLatest: false,
      pendingLatestIds: [],
      tailMissingLatest: true,
    }
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [message("older", 1)] }),
      current,
      mode: "history",
    })
    expect(plan.window.tailMissingLatest).toBe(true)
    expect(plan.metadata.tailMissingLatest).toBe(true)
  })

  test("does not open a tail gap when the history cap drops an older message", () => {
    const current: MessageWindowState<TestMessage> = {
      messages: [{ id: "new", time: { created: 4 }, role: "user" }],
      mode: "history",
      pendingLatest: false,
      pendingLatestIds: [],
      tailMissingLatest: false,
    }
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [message("older", 1)], total: 2 }),
      current,
      mode: "history",
      cap: 1,
    })
    expect(plan.window.messages.map((item) => item.id)).toEqual(["new"])
    expect(plan.droppedIds).toEqual(["older"])
    expect(plan.window.tailMissingLatest).toBe(false)
    expect(plan.metadata.tailMissingLatest).toBe(false)
  })

  test("latest page plan metadata clears the tail gap", () => {
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [message("a", 1)], total: 1 }),
    })
    expect(plan.metadata.mode).toBe("latest")
    expect(plan.metadata.tailMissingLatest).toBe(false)
  })

  test("projects the latest eligible assistant only from an authoritative latest page", () => {
    const older = message("older", 2)
    older.info = {
      ...older.info,
      role: "assistant",
      contextUsage: { total: 10 },
    }
    const newer = message("newer", 3)
    newer.info = {
      ...newer.info,
      role: "assistant",
      tokens: { input: 8, output: 0, reasoning: 0 },
    }
    const ineligible = message("ineligible", 4)
    ineligible.info = { ...ineligible.info, role: "assistant", tokens: { input: 0, output: 0, reasoning: 0 } }

    const latest = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [older, ineligible, newer] }),
    })
    const history = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [older] }),
      current: latest.window,
      mode: "history",
    })

    expect(latest.latestContextMessage?.id).toBe("newer")
    expect(history.latestContextMessage).toBeUndefined()
  })

  test("projects a completed compaction message as an ordered invalidation barrier", () => {
    const usage = message("usage", 2)
    usage.info = { ...usage.info, role: "assistant", contextUsage: { total: 10 } }
    const barrier = message("barrier", 3)
    barrier.info = {
      ...barrier.info,
      role: "assistant",
      mode: "compaction",
      time: { created: 3, completed: 4 },
      tokens: { input: 0, output: 0, reasoning: 0 },
    }

    const plan = planMessagePageApply<TestMessage, TestPart>({ page: page({ items: [usage, barrier] }) })

    expect(plan.latestContextMessage?.id).toBe("barrier")
  })

  test("projects null when an authoritative latest page has no eligible assistant", () => {
    const plan = planMessagePageApply<TestMessage, TestPart>({ page: page({ items: [message("user", 1)] }) })

    expect(plan.latestContextMessage).toBeNull()
  })

  test("preserves an accepted optimistic root until the latest page contains it", () => {
    const pending: TestMessage = {
      id: "pending",
      time: { created: 2 },
      role: "user",
      isRoot: true,
      rootID: "pending",
      visible: true,
      metadata: withOptimisticMessagePending(undefined),
    }
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [message("canonical", 1)], total: 1 }),
      current: window([message("canonical", 1).info, pending]),
    })

    expect(plan.window.messages.map((item) => item.id)).toEqual(["canonical", "pending"])
    expect(plan.droppedIds).not.toContain("pending")
    expect(plan.metadata.total).toBe(2)
  })

  test("keeps an accepted optimistic root when the authoritative latest page fills the cap", () => {
    const canonical = Array.from({ length: 500 }, (_, index) =>
      message(`canonical-${index.toString().padStart(3, "0")}`, index),
    )
    const pending: TestMessage = {
      id: "pending",
      time: { created: 500 },
      role: "user",
      isRoot: true,
      rootID: "pending",
      visible: true,
      metadata: withOptimisticMessagePending(undefined),
    }
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: canonical, total: 500 }),
      current: window([...canonical.map((item) => item.info), pending]),
      cap: 500,
    })

    expect(plan.window.messages).toHaveLength(500)
    expect(plan.window.messages.some((item) => item.id === "pending")).toBe(true)
    expect(plan.droppedIds).toContain("canonical-000")
    expect(plan.droppedIds).not.toContain("pending")
    expect(plan.metadata.total).toBe(501)
  })

  test("counts only optimistic roots retained after full-window reconciliation", () => {
    const firstPending: TestMessage = {
      id: "pending-first",
      time: { created: 15 },
      role: "user",
      metadata: withOptimisticMessagePending(undefined),
    }
    const secondPending: TestMessage = {
      id: "pending-second",
      time: { created: 30 },
      role: "user",
      metadata: withOptimisticMessagePending(undefined),
    }
    const canonical = [message("canonical-old", 10), message("canonical-new", 20)]
    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: canonical, total: 2 }),
      current: window([...canonical.map((item) => item.info), firstPending, secondPending]),
      cap: 2,
    })

    expect(plan.window.messages.map((item) => item.id)).toEqual(["canonical-new", "pending-second"])
    expect(plan.metadata.total).toBe(3)
  })

  test("replaces an accepted optimistic root when the latest page contains the canonical message", () => {
    const pending: TestMessage = {
      id: "canonical",
      time: { created: 2 },
      role: "user",
      isRoot: true,
      rootID: "canonical",
      visible: true,
      label: "pending",
      metadata: withOptimisticMessagePending(undefined),
    }
    const canonical = message("canonical", 2)
    canonical.info.label = "canonical"
    canonical.info.metadata = { promptDraft: { text: "saved" } }

    const plan = planMessagePageApply<TestMessage, TestPart>({
      page: page({ items: [canonical], total: 1 }),
      current: window([pending]),
    })

    expect(plan.window.messages).toEqual([canonical.info])
    expect(plan.metadata.total).toBe(1)
  })

  test("drops every previous message and part bucket on an empty latest page", () => {
    const current = window([
      { id: "old-1", time: { created: 1 }, role: "user" },
      { id: "old-2", time: { created: 2 }, role: "user" },
    ])
    const plan = planMessagePageApply<TestMessage, TestPart>({ page: page(), current })

    expect(plan.window.messages).toEqual([])
    expect(plan.droppedIds).toEqual(["old-1", "old-2"])
    expect(plan.parts).toEqual({})
  })
})
