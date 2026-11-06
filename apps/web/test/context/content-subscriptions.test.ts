import { expect, test } from "bun:test"
import { createContentSubscriptions, projectContentSummary } from "../../src/context/content-subscriptions"

test("execution demands merge dependencies and downgrade after the final detail reader leaves", () => {
  const subscriptions = createContentSubscriptions(() => {})
  const root = subscriptions.view({ kind: "execution", scopeID: "scope", sessionID: "session", demands: ["root"] })
  const detail = subscriptions.view({
    kind: "execution",
    scopeID: "scope",
    sessionID: "session",
    demands: ["trajectory"],
  })
  expect(subscriptions.current().details[0].demands).toEqual(["root", "summary", "trajectory"])
  const generation = subscriptions.current().details[0].generation
  detail()
  expect(subscriptions.current().details[0].demands).toEqual(["root"])
  expect(subscriptions.current().details[0].generation).toBeGreaterThan(generation)
  root()
})

test("retained content waits for the current checkpoint to reach consumers without publishing another interest", () => {
  const requests: unknown[] = []
  const subscriptions = createContentSubscriptions((value) => requests.push(value))
  const summary = {
    sessionID: "session",
    messageID: "message",
    id: "part",
    type: "text",
    preview: "Cached",
    content: { version: "v1", bytes: 6 },
  }
  const first = subscriptions.retain("scope", summary, true)
  const prior = subscriptions.current().parts[0].generation
  expect(subscriptions.pending("scope", "session")).toBe(true)
  subscriptions.settle("scope", { summary, subscription: prior })
  expect(subscriptions.pending("scope", "session")).toBe(false)
  first()
  const release = subscriptions.retain("scope", summary, true)
  const generation = subscriptions.current().parts[0].generation
  const checkpoint = {
    summary,
    subscription: generation,
    content: {
      kind: "checkpoint" as const,
      part: { ...summary, type: "text" as const, text: "Cached plus background" },
    },
  }
  expect(projectContentSummary(subscriptions, "scope", checkpoint)).toEqual(checkpoint)
  expect(subscriptions.pending("scope", "session")).toBe(true)
  subscriptions.settle("scope", { summary, subscription: prior })
  subscriptions.settle("other", checkpoint)
  subscriptions.settle("scope", { ...checkpoint, summary: { ...summary, sessionID: "other-session" } })
  expect(subscriptions.pending("scope", "session")).toBe(true)
  const count = requests.length
  subscriptions.settle("scope", checkpoint)
  expect(subscriptions.pending("scope", "session")).toBe(false)
  expect(requests).toHaveLength(count)
  subscriptions.reconnect()
  expect(subscriptions.pending("scope", "session")).toBe(true)
  subscriptions.settle("scope", checkpoint)
  expect(subscriptions.pending("scope", "session")).toBe(true)
  release()
  expect(subscriptions.pending("scope", "session")).toBe(false)
})

test("append streams fence offsets, revisions and owners independently of canonical content hashes", () => {
  const subscriptions = createContentSubscriptions(() => {})
  const summary = {
    sessionID: "session",
    messageID: "message",
    id: "part",
    type: "text",
    preview: "a",
    content: { version: "anchor", bytes: 1 },
  }
  const release = subscriptions.retain("scope", summary)
  const generation = subscriptions.current().parts[0].generation
  expect(
    subscriptions.accept("scope", {
      summary,
      subscription: generation,
      content: { kind: "checkpoint" },
      stream: { id: "stream", offset: 1, revision: 0 },
    }),
  ).toBe(true)
  const append = {
    summary,
    subscription: generation,
    content: { kind: "append", streamID: "stream", offset: 1, revision: 1, delta: "b" },
  }
  expect(subscriptions.accept("scope", append)).toBe(true)
  expect(subscriptions.accept("scope", { ...append, content: { ...append.content, offset: 7, revision: 2 } })).toBe(
    false,
  )
  expect(subscriptions.current().parts[0].generation).toBeGreaterThan(generation)
  expect(subscriptions.accept("scope", append)).toBe(false)
  release()
})

test("detail leases are reference counted and released on hidden pages and reconnect generations", () => {
  const subscriptions = createContentSubscriptions(() => {})
  const a = subscriptions.view({ kind: "execution", scopeID: "scope", sessionID: "session" })
  const b = subscriptions.view({ kind: "execution", scopeID: "scope", sessionID: "session" })
  const generation = subscriptions.current().details[0].generation
  a()
  expect(subscriptions.current().details).toHaveLength(1)
  subscriptions.hidden(true)
  expect(subscriptions.current().details).toEqual([])
  subscriptions.hidden(false)
  expect(subscriptions.current().details[0].generation).toBeGreaterThan(generation)
  b()
  expect(subscriptions.current().details).toEqual([])
})

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

test("multiple detail windows share one revision owner and union their visible context interests", () => {
  const subscriptions = createContentSubscriptions(() => {})
  const first = subscriptions.view({
    kind: "execution",
    scopeID: "scope",
    sessionID: "session",
    runID: "run-a",
    nodeIDs: ["a"],
  })
  const generation = subscriptions.current().details[0].generation
  const second = subscriptions.view({
    kind: "execution",
    scopeID: "scope",
    sessionID: "session",
    runID: "run-b",
    nodeIDs: ["b"],
  })
  expect(subscriptions.current().details).toHaveLength(1)
  expect(subscriptions.current().details[0]).toMatchObject({ nodeIDs: ["a", "b"] })
  expect(subscriptions.current().details[0].runID).toBeUndefined()
  expect(subscriptions.current().details[0].generation).toBeGreaterThan(generation)
  second()
  expect(subscriptions.current().details[0]).toMatchObject({ runID: "run-a", nodeIDs: ["a"] })
  first()
  expect(subscriptions.current().details).toHaveLength(0)
})

test("cached content accepts an anchor without body and fences appends after release", () => {
  const subscriptions = createContentSubscriptions(() => {})
  const summary = {
    id: "part",
    messageID: "message",
    sessionID: "session",
    type: "text",
    preview: "cached",
    content: { version: "stable", bytes: 6 },
  }
  const release = subscriptions.retain("scope", summary, true)
  const generation = subscriptions.current().parts[0].generation
  const anchor = { summary, subscription: generation, stream: { id: "stream", offset: 6, revision: 0 } }
  expect(subscriptions.current().parts[0].version).toBe("stable")
  expect(subscriptions.accept("scope", anchor)).toBe(true)
  expect(
    subscriptions.accept("scope", {
      summary,
      subscription: generation,
      content: { kind: "append", streamID: "stream", offset: 6, revision: 1, delta: " next" },
    }),
  ).toBe(true)
  release()
  expect(subscriptions.accept("scope", anchor)).toBe(false)
  subscriptions.retain("scope", summary, false)
  expect(subscriptions.accept("scope", { ...anchor, subscription: subscriptions.current().parts[0].generation })).toBe(
    false,
  )
})

test("checkpoint anchors preserve contiguous streams and gaps renew only their content lease", () => {
  const subscriptions = createContentSubscriptions(() => {})
  const summary = {
    id: "part",
    messageID: "message",
    sessionID: "session",
    type: "text",
    preview: "body",
    content: { version: "v1", bytes: 4 },
  }
  subscriptions.retain("scope", summary, true)
  const subscription = subscriptions.current().parts[0].generation
  expect(
    subscriptions.accept("scope", { summary, subscription, stream: { id: "stream", offset: 4, revision: 0 } }),
  ).toBe(true)
  const checkpoint = {
    summary: { ...summary, content: { version: "canonical", bytes: 4 } },
    subscription,
    content: { kind: "anchor", streamID: "stream", offset: 4, revision: 1 },
  }
  expect(subscriptions.accept("scope", checkpoint)).toBe(true)
  expect(
    subscriptions.accept("scope", {
      summary,
      subscription,
      content: { kind: "append", streamID: "stream", offset: 4, revision: 2, delta: "next" },
    }),
  ).toBe(true)
  expect(subscriptions.accept("scope", { ...checkpoint, content: { ...checkpoint.content, revision: 4 } })).toBe(false)
  expect(subscriptions.current().parts[0].generation).toBeGreaterThan(subscription)
})
