import { expect, test } from "bun:test"
import { buildConversationRows } from "../../src/components/session/conversation-rows"
import type { Message, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

const root = { id: "root", role: "user" } as Message
const reply = { id: "reply", role: "assistant" } as Message
const parts = Array.from(
  { length: 1001 },
  (_, index) =>
    ({ id: `p${index.toString().padStart(4, "0")}`, messageID: "reply", type: "tool" }) as SessionPartSummary,
)

test("a manual compaction request yields to its canonical attempt without a stale running row", () => {
  const boundary = { ...root, metadata: { compactionBoundary: true } } as Message
  const request = { ...parts[0], id: "request", messageID: root.id, type: "compaction" } as SessionPartSummary
  const attempt = {
    ...reply,
    mode: "compaction",
    agent: "compaction",
    metadata: { compactionAttempt: { state: "committed" } },
  } as Message
  const input = {
    timeline: [boundary],
    summaries: (id: string) => (id === root.id ? [request] : []),
    page: () => ({ hasMore: false }),
    process: () => ({ open: true, working: true }),
  }
  const pending = buildConversationRows({ ...input, messagesFor: () => [] })
  const unhydrated = buildConversationRows({ ...input, messagesFor: () => [], summaries: () => [] })
  expect(unhydrated.filter((row) => row.kind === "body").map((row) => [row.message.id, row.event])).toEqual([
    [root.id, "compaction"],
  ])
  expect(unhydrated.find((row) => row.kind === "activity")?.key).toBe(
    pending.find((row) => row.kind === "activity")?.key,
  )
  expect(pending.filter((row) => row.kind === "body").map((row) => [row.message.id, row.event])).toEqual([
    [root.id, "compaction"],
  ])
  for (const state of ["running", "committed", "failed", "empty"]) {
    const message = { ...attempt, metadata: { compactionAttempt: { state } } } as Message
    const completed = buildConversationRows({ ...input, previous: pending, messagesFor: () => [message] })
    const bodies = completed.filter((row) => row.kind === "body")
    expect(bodies.map((row) => row.message.id)).toEqual(state === "empty" ? [] : [reply.id])
    expect(bodies.every((row) => row.event === "compaction")).toBe(true)
  }
})

test("unhydrated system events form stable groups without requiring a first Part", () => {
  const delivery = {
    ...root,
    id: "delivery",
    isRoot: false,
    origin: { type: "cortex", sessionID: "child" },
  } as Message
  const compaction = {
    ...reply,
    id: "compaction",
    metadata: { compactionAttempt: { state: "running" } },
  } as Message
  for (const event of [delivery, compaction]) {
    const input = {
      timeline: [root],
      messagesFor: () => [reply, event],
      summaries: () => [] as SessionPartSummary[],
      page: () => undefined,
      process: () => ({ open: true, working: true }),
    }
    const initial = buildConversationRows(input)
    const group = initial.find((row) => row.kind === "activity")!
    expect(group.activity?.tools).toBe(0)
    expect(group.activity?.entries.map((row) => row.message.id)).toEqual([event.id])
    const hydrated = buildConversationRows({
      ...input,
      previous: initial,
      summaries: (id) =>
        id === event.id ? [{ ...parts[0], id: "loaded-event-part", messageID: id, type: "text" }] : [],
    })
    expect(hydrated.find((row) => row.kind === "activity")?.key).toBe(group.key)
  }
})

test("root user content is a display row when the turn projection contains only its replies", () => {
  const rootPart = { ...parts[0], id: "root-part", messageID: root.id, type: "text" as const }
  const rows = buildConversationRows({
    timeline: [root],
    messagesFor: () => [reply],
    summaries: (id) => (id === root.id ? [rootPart] : [parts[0]!]),
    page: () => ({ hasMore: false }),
  })
  expect(rows.filter((row) => row.kind === "body").map((row) => row.message.id)).toEqual([root.id, reply.id])
  expect(rows.some((row) => row.kind === "body" && row.parts.some((part) => part.id === rootPart.id))).toBe(true)
})

test("one huge turn becomes bounded stable rows with one pair of message slot boundaries", () => {
  const rows = buildConversationRows({
    timeline: [root],
    messagesFor: () => [root, reply],
    summaries: (id) => (id === "reply" ? parts : []),
    page: () => ({ hasMore: false }),
  })
  const bodies = rows.filter((row) => row.kind === "body")
  expect(bodies.length).toBe(1001)
  expect(Math.max(...bodies.map((row) => row.parts.length))).toBe(1)
  expect(bodies.flatMap((row) => row.parts.map((part) => part.id))).toEqual(parts.map((part) => part.id))
  expect(bodies.filter((row) => row.before).length).toBe(1)
  expect(bodies.filter((row) => row.after).length).toBe(1)
  const grown = buildConversationRows({
    timeline: [root],
    messagesFor: () => [root, reply],
    summaries: (id) => (id === "reply" ? [...parts, { ...parts[0], id: "p1001" }] : []),
    page: () => ({ hasMore: false }),
  })
  expect(
    grown
      .filter((row) => row.kind === "body")
      .slice(0, -1)
      .map((row) => row.key),
  ).toEqual(bodies.map((row) => row.key))
  const prepended = buildConversationRows({
    timeline: [root],
    messagesFor: () => [root, reply],
    summaries: (id) => (id === "reply" ? [{ ...parts[0], id: "before" }, ...parts] : []),
    page: () => ({ hasMore: false }),
  })
  expect(
    prepended
      .filter((row) => row.kind === "body")
      .slice(1)
      .map((row) => row.key),
  ).toEqual(bodies.map((row) => row.key))
})

test("an unprepared message and the next Part page have separate demand rows", () => {
  const rows = buildConversationRows({
    timeline: [root],
    messagesFor: () => [root, reply],
    summaries: () => [],
    page: (id) => (id === "root" ? { hasMore: true } : undefined),
  })
  expect(rows.filter((row) => row.kind === "load").map((row) => [row.message.id, row.more])).toEqual([
    ["root", true],
    ["reply", false],
  ])
})

test("structural Parts create no empty rows and tool and reasoning slots remain with their own content", () => {
  const values = Array.from({ length: 15 }, (_, index) => ({
    ...parts[index],
    type: index < 7 ? "text" : index < 13 ? "reasoning" : "tool",
    render: index !== 2,
  }))
  const rows = buildConversationRows({
    timeline: [root],
    messagesFor: () => [reply],
    summaries: (id) => (id === reply.id ? values : []),
    page: () => ({ hasMore: false }),
  })
  const bodies = rows.filter((row) => row.kind === "body")
  expect(bodies.flatMap((row) => row.parts.map((part) => part.id))).not.toContain(values[2].id)
  expect(bodies.filter((row) => row.beforeTool)).toHaveLength(1)
  expect(bodies.filter((row) => row.beforeReasoning)).toHaveLength(1)
  expect(bodies.find((row) => row.beforeTool)?.before).toBe(false)
})

test("virtualized processes have one entrance and bounded batches without hiding the final answer", () => {
  const answer = { ...parts[0], id: "answer", type: "text" } as SessionPartSummary
  const input = {
    timeline: [root],
    messagesFor: () => [reply],
    summaries: (id: string) => (id === reply.id ? [...parts, answer] : []),
    page: () => ({ hasMore: false }),
    process: () => ({ open: true, working: false }),
  }
  const open = buildConversationRows(input)
  expect(open.filter((row) => row.kind === "process")).toHaveLength(1)
  const groups = open.filter((row) => row.kind === "body")
  expect(Math.max(...groups.map((row) => row.parts.length))).toBeLessThanOrEqual(6)
  expect(groups.some((row) => row.parts.length > 1)).toBe(true)
  expect(groups.flatMap((row) => row.parts.map((part) => part.id))).toEqual([...parts, answer].map((part) => part.id))
  const collapsed = buildConversationRows({ ...input, process: () => ({ open: false, working: false }) })
  expect(collapsed.filter((row) => row.kind === "process")).toHaveLength(1)
  expect(collapsed.filter((row) => row.kind === "body").flatMap((row) => row.parts.map((part) => part.id))).toEqual([
    "answer",
  ])
  expect(collapsed.at(-1)?.kind).toBe("footer")
})

test("prepending a process page retains existing batch identities and Part membership", () => {
  const input = {
    timeline: [root],
    messagesFor: () => [reply],
    summaries: (id: string) => (id === reply.id ? parts.slice(6, 24) : []),
    page: () => ({ hasMore: false }),
    process: () => ({ open: true, working: false }),
  }
  const initial = buildConversationRows(input)
  const grown = buildConversationRows({
    ...input,
    previous: initial,
    summaries: (id: string) => (id === reply.id ? parts.slice(1, 24) : []),
  })
  const original = initial.filter((row) => row.kind === "body")
  const kept = grown.filter((row) => row.kind === "body").filter((row) => original.some((old) => old.key === row.key))
  expect(kept.map((row) => [row.key, row.parts.map((part) => part.id)])).toEqual(
    original.map((row) => [row.key, row.parts.map((part) => part.id)]),
  )
})

test("closing and reopening a prepended activity preserves its identity, content and bounded rows", () => {
  const input = {
    timeline: [root],
    messagesFor: () => [reply],
    summaries: (id: string) => (id === reply.id ? parts.slice(6, 24) : []),
    page: () => ({ hasMore: false }),
    process: () => ({ open: true, working: false }),
  }
  const initial = buildConversationRows(input)
  const loaded = { ...input, summaries: (id: string) => (id === reply.id ? parts.slice(1, 24) : []) }
  const prepended = buildConversationRows({ ...loaded, previous: initial })
  const closed = buildConversationRows({ ...loaded, previous: prepended, activity: () => false })
  expect(closed.some((row) => row.kind === "body")).toBe(false)
  const reopened = buildConversationRows({ ...loaded, previous: closed, activity: () => true })
  expect(reopened.filter((row) => row.kind === "activity").map((row) => row.key)).toEqual(
    prepended.filter((row) => row.kind === "activity").map((row) => row.key),
  )
  const rows = reopened.filter((row) => row.kind === "body")
  expect(rows.flatMap((row) => row.parts.map((part) => part.id))).toEqual(parts.slice(1, 24).map((part) => part.id))
  expect(Math.max(...rows.map((row) => row.parts.length))).toBeLessThanOrEqual(6)
})

function processFixture() {
  const work = { ...reply, id: "work", finish: "tool-calls" } as Message
  const more = { ...reply, id: "more", finish: "tool-calls" } as Message
  const final = { ...reply, id: "final", finish: "stop" } as Message
  const part = (messageID: string, id: string, type: string) =>
    ({
      ...parts[0],
      messageID,
      id,
      type,
      status: "completed",
      content: { bytes: 1 },
    }) as SessionPartSummary
  const table: Record<string, SessionPartSummary[]> = {
    work: [part("work", "think-first", "reasoning"), part("work", "progress", "text"), part("work", "run-1", "tool")],
    more: [part("more", "think-again", "reasoning"), part("more", "run-2", "tool")],
    final: [part("final", "answer", "text")],
  }
  return {
    timeline: [root],
    messagesFor: () => [work, more, final],
    summaries: (id: string) => table[id] ?? [],
    page: () => ({ hasMore: false }),
    process: () => ({ open: true, working: false }),
  }
}

test("reasoning and tools share one logical disclosure across messages, bounded by prose", () => {
  const rows = buildConversationRows({ ...processFixture(), activity: () => false })
  const visible = rows.filter((row) => row.kind === "activity" || row.kind === "body")
  expect(visible.map((row) => (row.kind === "body" ? row.parts[0].id : row.activity?.tools))).toEqual([
    0,
    "progress",
    2,
    "answer",
  ])
  expect(rows.filter((row) => row.kind === "activity").map((row) => row.activity?.reasoning)).toEqual([1, 1])
})

test("the current execution block stays open until new process prose or confirmed turn completion", () => {
  const fixture = processFixture()
  const rows = buildConversationRows({
    ...fixture,
    process: () => ({ open: true, working: true }),
    activity: (block) => block.active,
  })
  expect(rows.filter((row) => row.kind === "body").flatMap((row) => row.parts.map((part) => part.id))).toEqual([
    "progress",
    "run-1",
    "think-again",
    "run-2",
    "answer",
  ])
  const collapsed = buildConversationRows({
    ...fixture,
    process: () => ({ open: false, working: false }),
    activity: () => true,
  })
  expect(collapsed.filter((row) => row.kind === "activity")).toHaveLength(0)
  expect(collapsed.filter((row) => row.kind === "body").map((row) => row.parts[0].id)).toEqual(["answer"])
})

test("unloaded spans cannot claim a continuous execution group", () => {
  const fixture = processFixture()
  const rows = buildConversationRows({ ...fixture, page: (id) => ({ hasMore: id === "work" }), activity: () => false })
  expect(rows.filter((row) => row.kind === "activity")).toHaveLength(3)
})
