import { describe, expect, test } from "bun:test"
import type { Part, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import {
  handoffOptimisticMessage,
  isOptimisticMessagePending,
  messageAllowsCanonicalActions,
  withOptimisticMessagePending,
} from "../../src/context/session-optimistic-message"
import { reconcileMessage } from "../../src/context/session-message-window"
import type { MessageWindowState } from "../../src/context/session-message-window"

const message = (id: string, created: number): UserMessage => ({
  id,
  sessionID: "session",
  role: "user",
  time: { created },
  agent: "synergy-max",
  model: { providerID: "openai", modelID: "gpt-5" },
  origin: { type: "user" },
  isRoot: true,
  rootID: id,
  visible: true,
  metadata: withOptimisticMessagePending({ promptDraft: { text: id } }),
})

const part = (id: string, messageID: string): Part => ({
  id,
  sessionID: "session",
  messageID,
  type: "text",
  text: id,
})

const window = (messages: UserMessage[]): MessageWindowState<UserMessage> => ({
  messages,
  mode: "latest",
  pendingLatest: false,
  pendingLatestIds: [],
})

describe("optimistic message handoff", () => {
  test("atomically rekeys the pending root and parts to the canonical ID", () => {
    const result = handoffOptimisticMessage({
      current: window([message("temporary", 2)]),
      optimisticParts: [part("part-1", "temporary")],
      optimisticID: "temporary",
      canonicalID: "canonical",
      total: 2,
    })

    expect(result.window.messages.map((item) => item.id)).toEqual(["canonical"])
    expect(result.window.messages[0].rootID).toBe("canonical")
    expect(isOptimisticMessagePending(result.window.messages[0])).toBe(true)
    expect(result.canonicalParts?.[0]).toMatchObject({ messageID: "canonical", sessionID: "session" })
    expect(result.total).toBe(2)
  })

  test("keeps canonical parts when the accepted ID already matches", () => {
    const optimisticParts = [part("part-optimistic", "canonical")]
    const canonicalParts = [part("part-canonical", "canonical")]
    const current = window([message("canonical", 2)])
    const result = handoffOptimisticMessage({
      current,
      optimisticParts,
      canonicalParts,
      optimisticID: "canonical",
      canonicalID: "canonical",
      total: 1,
    })

    expect(result.window).toBe(current)
    expect(result.canonicalParts).toBe(canonicalParts)
    expect(result.total).toBe(1)
  })

  test("keeps an event-arrived canonical message and removes only the temporary duplicate", () => {
    const canonical = {
      ...message("canonical", 3),
      metadata: { promptDraft: { text: "canonical" } },
    }
    const result = handoffOptimisticMessage({
      current: window([message("temporary", 2), canonical]),
      optimisticParts: [part("part-temporary", "temporary")],
      canonicalParts: [part("part-canonical", "canonical")],
      optimisticID: "temporary",
      canonicalID: "canonical",
      total: 3,
    })

    expect(result.window.messages).toEqual([canonical])
    expect(result.canonicalParts?.[0].id).toBe("part-canonical")
    expect(result.total).toBe(2)
    expect(isOptimisticMessagePending(result.window.messages[0])).toBe(false)
  })

  test("rekeys an unseen history arrival without inserting it into the loaded window", () => {
    const result = handoffOptimisticMessage({
      current: {
        messages: [],
        mode: "history",
        pendingLatest: true,
        pendingLatestIds: ["temporary"],
      },
      optimisticID: "temporary",
      canonicalID: "canonical",
      total: 4,
    })

    expect(result.window.messages).toEqual([])
    expect(result.window.pendingLatest).toBe(true)
    expect(result.window.pendingLatestIds).toEqual(["canonical"])
    expect(result.total).toBe(4)
  })

  test("canonical message reconciliation clears the client-only pending marker", () => {
    const pending = message("canonical", 1)
    const canonical = { ...pending, metadata: { promptDraft: { text: "saved" } } }
    const result = reconcileMessage(window([pending]), canonical)

    expect(result.window.messages).toEqual([canonical])
    expect(isOptimisticMessagePending(result.window.messages[0])).toBe(false)
  })

  test("pending optimistic roots do not expose canonical actions", () => {
    const pending = message("pending", 1)
    const canonical = { ...pending, metadata: { promptDraft: { text: "canonical" } } }

    expect(messageAllowsCanonicalActions(pending)).toBe(false)
    expect(messageAllowsCanonicalActions(canonical)).toBe(true)
  })
})
