import { describe, expect, test } from "bun:test"
import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import {
  pendingTimelineItemView,
  selectPendingTimelineItems,
  editPendingMessage,
  takePendingMessage,
} from "../../../src/components/session/conversation-pending"

describe("pending message editing", () => {
  const item: SessionInboxItem = {
    id: "inb_edit",
    sessionID: "ses_edit",
    messageID: "msg_edit",
    mode: "task",
    summary: { title: "Queued input" },
    source: { type: "user" },
    time: { created: 1 },
    orderKey: "1",
    message: {
      parts: [
        { type: "text", text: "First", origin: "user" },
        { type: "text", text: "Second", origin: "user" },
        { type: "text", text: "Internal", origin: "system" },
        { type: "attachment", id: "image", mime: "image/png", filename: "image.png", url: "asset://image.png" },
      ],
    },
  }
  const fixture = () => {
    let revision = 0
    let dirty = false
    const snapshots: unknown[] = []
    const operations: string[] = []
    return {
      snapshots,
      operations,
      change() {
        revision++
        dirty = true
      },
      input: {
        item,
        eligible: () => true,
        draft: {
          ready: () => true,
          dirty: () => dirty,
          revision: () => revision,
          context: { items: () => [] },
          restoreIfUnchanged(expected: number, snapshot: unknown) {
            if (revision !== expected) return false
            snapshots.push(snapshot)
            return true
          },
        },
        take: async () => {
          operations.push("take")
          return item
        },
        requeue: async () => {
          operations.push("requeue")
        },
      },
    }
  }
  test("editing confirms removal before restoring every authored part and media", async () => {
    const f = fixture()
    expect(await editPendingMessage(f.input)).toBe("edited")
    expect(f.operations).toEqual(["take"])
    expect(f.snapshots).toEqual([
      {
        version: 1,
        prompt: [
          { type: "text", content: "First\n\nSecond", start: 0, end: 13 },
          { type: "attachment", id: "image", filename: "image.png", mime: "image/png", url: "asset://image.png" },
        ],
        context: { items: [] },
      },
    ])
  })
  test("an existing or newly typed draft is never overwritten", async () => {
    const f = fixture()
    f.change()
    expect(await editPendingMessage(f.input)).toBe("draft-not-empty")
    expect(f.operations).toEqual([])
    const concurrent = fixture()
    concurrent.input.take = async () => {
      concurrent.change()
      concurrent.operations.push("take")
      return item
    }
    expect(await editPendingMessage(concurrent.input)).toBe("draft-changed")
    expect(concurrent.operations).toEqual(["take", "requeue"])
    expect(concurrent.snapshots).toEqual([])
  })
  test("locks and failed removal cannot start editing or replace a draft", async () => {
    const locked = fixture()
    locked.input.eligible = () => false
    expect(await editPendingMessage(locked.input)).toBe("unavailable")
    expect(locked.operations).toEqual([])
    const failed = fixture()
    failed.input.take = async () => {
      throw new Error("Removal not confirmed")
    }
    await expect(editPendingMessage(failed.input)).rejects.toThrow("Removal not confirmed")
    expect(failed.snapshots).toEqual([])
  })
  test("a session switch or rollback during removal restores the original queue instead of another draft", async () => {
    const f = fixture()
    f.input.take = async () => {
      f.operations.push("take")
      f.input.eligible = () => false
      return item
    }
    expect(await editPendingMessage(f.input)).toBe("unavailable")
    expect(f.operations).toEqual(["take", "requeue"])
    expect(f.snapshots).toEqual([])
  })
  test("lost removal replies are verified and a post-removal read failure restores saved input", async () => {
    let reads = 0
    let removes = 0
    let restores = 0
    const input = {
      removed: async (): Promise<SessionInboxItem | undefined> => (++reads === 1 ? undefined : item),
      eligible: () => true,
      unavailable: () => new Error("Unavailable"),
      remove: async (): Promise<void> => {
        removes++
        throw new Error("Reply lost")
      },
      restore: async () => {
        restores++
      },
    }
    expect(await takePendingMessage(input)).toBe(item)
    expect(removes).toBe(1)
    expect(restores).toBe(0)
    reads = 0
    input.remove = async () => {
      removes++
    }
    input.removed = async () => {
      if (++reads === 1) return undefined
      throw new Error("State unavailable")
    }
    await expect(takePendingMessage(input)).rejects.toThrow("State unavailable")
    expect(restores).toBe(1)
  })
  test("an item consumed before removal is not copied into an editable draft", async () => {
    const f = fixture()
    f.input.take = () =>
      takePendingMessage({
        removed: async () => undefined,
        remove: async () => {},
        restore: async () => {},
        eligible: () => true,
        unavailable: () => new Error("Already delivered"),
      })
    await expect(editPendingMessage(f.input)).rejects.toThrow("Already delivered")
    expect(f.snapshots).toEqual([])
  })
  test("the confirmed stored draft retains notes, sessions and workspace context", async () => {
    const f = fixture()
    const snapshot = {
      version: 1,
      prompt: [
        { type: "text", content: "Edit this", start: 0, end: 9 },
        { type: "note", id: "note", noteId: "nte_one", title: "Plan", content: "Retain note body" },
        { type: "session", id: "session", sessionId: "ses_previous", scopeID: "scope", title: "Previous task" },
      ],
      context: { items: [{ type: "file", path: "src/file.ts" }] },
    }
    f.input.take = async () => ({ ...item, message: { ...item.message!, metadata: { promptDraft: snapshot } } })
    expect(await editPendingMessage(f.input)).toBe("edited")
    expect(f.snapshots[0]).toMatchObject(snapshot)
  })
})

describe("pending timeline item presentation", () => {
  test("locks the first pending root until a canonical root exists", () => {
    expect(pendingTimelineItemView("task", false, { hasCanonicalRoot: false })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
    expect(pendingTimelineItemView("task", false, { hasCanonicalRoot: true })).toEqual({
      frozen: false,
      primaryAction: "guide",
      canWithdraw: true,
    })
    expect(pendingTimelineItemView("steer", false, { hasCanonicalRoot: true })).toEqual({
      frozen: false,
      primaryAction: "queue",
      canWithdraw: true,
    })
  })

  test("freezes all pending actions during rollback", () => {
    expect(pendingTimelineItemView("task", true, { hasCanonicalRoot: true })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
    expect(pendingTimelineItemView("steer", true, { hasCanonicalRoot: true })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
  })

  test("failed initialization can be withdrawn without enabling guide actions", () => {
    expect(pendingTimelineItemView("task", false, { hasCanonicalRoot: false, status: "failed" })).toEqual({
      frozen: false,
      primaryAction: undefined,
      canWithdraw: true,
    })
    expect(pendingTimelineItemView("task", true, { hasCanonicalRoot: false, status: "failed" })).toEqual({
      frozen: true,
      primaryAction: undefined,
      canWithdraw: false,
    })
  })

  test("hides a pending item after its canonical message is present", () => {
    const pending = {
      id: "inb_first",
      sessionID: "ses_first",
      mode: "task",
      messageID: "msg_first",
      message: {
        role: "user",
        parts: [],
        origin: { type: "user" },
        visible: true,
      },
      summary: { title: "First message" },
      source: { type: "user" },
      time: { created: 1 },
      orderKey: "001",
    } satisfies SessionInboxItem

    expect(selectPendingTimelineItems([pending], [])).toEqual([pending])
    expect(selectPendingTimelineItems([pending], [{ id: "msg_first" }])).toEqual([])
    const renderedOptimisticMessage: { id: string; metadata?: unknown } = {
      id: "msg_first",
      metadata: { synergyClientOptimistic: { pending: true } },
    }
    expect(selectPendingTimelineItems([pending], [renderedOptimisticMessage])).toEqual([])
    const steer = { ...pending, id: "inb_steer", messageID: "msg_steer", mode: "steer" as const }
    const context = { ...pending, id: "inb_context", mode: "context" as const }
    const hidden = { ...pending, id: "inb_hidden", message: { ...pending.message, visible: false } }
    const agent = {
      ...pending,
      id: "inb_agent",
      message: { ...pending.message, origin: { type: "agent" as const } },
    }
    const sourceOnly = { ...pending, id: "inb_source", messageID: "msg_source", message: undefined }
    expect(
      selectPendingTimelineItems([context, hidden, agent, steer, sourceOnly, pending], []).map((item) => item.id),
    ).toEqual([steer.id, sourceOnly.id, pending.id])
  })
})
