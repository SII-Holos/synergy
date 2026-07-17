import { describe, expect, test } from "bun:test"
import { planMessagePageApply } from "./session-message-page"
import type { MessageWindowState } from "./session-message-window"

type TestMessage = {
  id: string
  time: { created: number }
  role: "user" | "assistant"
  includeInContext?: boolean
  contextUsage?: unknown
  tokens?: { input: number; output: number; reasoning: number }
  label?: string
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
    })
  })

  test("prepends older history and evicts newest messages when capped", () => {
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

    expect(plan.window.messages.map((item) => item.id)).toEqual(["old-1", "old-2"])
    expect(plan.droppedIds).toEqual(["new-1", "new-2"])
    expect(plan.metadata.mode).toBe("history")
    expect(plan.metadata.nextCursor).toBe("cursor-older")
  })

  test("keeps unseen pending messages out of the history-window total", () => {
    const current: MessageWindowState<TestMessage> = {
      messages: [{ id: "visible", time: { created: 3 }, role: "user" }],
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["pending"],
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

  test("projects null when an authoritative latest page has no eligible assistant", () => {
    const plan = planMessagePageApply<TestMessage, TestPart>({ page: page({ items: [message("user", 1)] }) })

    expect(plan.latestContextMessage).toBeNull()
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
