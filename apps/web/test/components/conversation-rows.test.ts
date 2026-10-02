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
