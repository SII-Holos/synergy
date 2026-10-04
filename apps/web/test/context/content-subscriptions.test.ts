import { expect, test } from "bun:test"
import { createContentSubscriptions, projectContentSummary } from "../../src/context/content-subscriptions"

test("content subscriptions refcount, reject stale checkpoints and recover a delta version gap", () => {
  const requests: unknown[] = []
  const subscriptions = createContentSubscriptions((value) => requests.push(value))
  const part = {
    sessionID: "session",
    messageID: "message",
    id: "part",
    type: "text",
    preview: "",
    content: { version: "v1", bytes: 1 },
  }
  const first = subscriptions.retain("scope", part)
  const second = subscriptions.retain("scope", part)
  const generation = subscriptions.current().parts[0].generation
  first()
  expect(subscriptions.current().parts).toHaveLength(1)
  const checkpoint = {
    summary: part,
    subscription: generation,
    content: { kind: "checkpoint" as const, part: { ...part, text: "a" } },
  }
  expect(subscriptions.accept("scope", checkpoint)).toBe(true)
  expect(subscriptions.accept("scope", { ...checkpoint, subscription: generation - 1 })).toBe(false)
  expect(
    subscriptions.accept("scope", {
      summary: { ...part, content: { version: "v2", bytes: 2 } },
      subscription: generation,
      content: { kind: "delta" as const, baseVersion: "missing", delta: "b" },
    }),
  ).toBe(false)
  expect(subscriptions.current().parts[0].generation).toBeGreaterThan(generation)
  second()
  expect(subscriptions.current().parts).toEqual([])
})

test("hidden and reconnect states resume from fresh checkpoints", () => {
  const subscriptions = createContentSubscriptions(() => {})
  subscriptions.active("scope", "session")
  const part = {
    sessionID: "session",
    messageID: "message",
    id: "part",
    type: "text",
    preview: "",
    content: { version: "v1", bytes: 1 },
  }
  subscriptions.retain("scope", part)
  const first = subscriptions.current().parts[0].generation
  subscriptions.hidden(true)
  expect(subscriptions.current().parts).toEqual([])
  subscriptions.hidden(false)
  expect(subscriptions.current().parts[0].generation).toBeGreaterThan(first)
  const resumed = subscriptions.current().parts[0].generation
  subscriptions.reconnect()
  expect(subscriptions.current().parts[0].generation).toBeGreaterThan(resumed)
})

test("first Part discovery survives visibility renewal while stale content is rejected", () => {
  const subscriptions = createContentSubscriptions(() => {})
  subscriptions.active("scope", "session")
  const generation = subscriptions.current().active!.generation
  const part = { id: "first", sessionID: "session", messageID: "assistant", type: "text" as const, text: "Reply" }
  const { text, ...identity } = part
  const summary = { ...identity, preview: text, render: true, content: { version: "v1", bytes: 5 } }
  const checkpoint = { summary, subscription: generation, content: { kind: "checkpoint" as const, part } }
  subscriptions.hidden(true)
  expect(projectContentSummary(subscriptions, "scope", checkpoint)).toEqual({ summary, discovery: true })
  subscriptions.hidden(false)
  expect(subscriptions.current().active!.generation).toBeGreaterThan(generation)
  expect(projectContentSummary(subscriptions, "scope", checkpoint)).toEqual({ summary, discovery: true })
  subscriptions.retain("scope", summary)
  const current = { ...checkpoint, subscription: subscriptions.current().parts[0].generation }
  expect(projectContentSummary(subscriptions, "scope", current)).toEqual(current)
  expect(projectContentSummary(subscriptions, "scope", checkpoint)).toEqual({ summary, discovery: true })
  expect(projectContentSummary(subscriptions, "scope", checkpoint, 4)).toEqual({ summary })
  subscriptions.reconnect()
  expect(projectContentSummary(subscriptions, "scope", current)).toEqual({ summary, discovery: true })
})
