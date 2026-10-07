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

test("ordinary tool deliverables keep their original position outside collapsed process history", () => {
  const content: SessionPartSummary[] = [
    { ...parts[0], id: "inspect", tool: "read", display: "activity", attachments: { evidence: 1, deliverable: 0 } },
    { ...parts[0], id: "create", tool: "bash", display: "activity", attachments: { evidence: 1, deliverable: 1 } },
    { ...parts[0], id: "verify", tool: "read", display: "activity" },
    { ...parts[0], id: "answer", type: "text" },
  ]
  const input = {
    timeline: [root],
    messagesFor: () => [reply],
    page: () => ({ hasMore: false }),
    summaries: (id: string) => (id === reply.id ? content : []),
  }
  const closed = buildConversationRows({ ...input, process: () => ({ open: false, working: false }) })
  expect(closed.filter((row) => row.kind === "body").map((row) => [row.key, row.toolAttachments])).toEqual([
    ["reply:create:attachments", "only"],
    ["reply:answer", undefined],
  ])
  const opened = buildConversationRows({ ...input, previous: closed, process: () => ({ open: true, working: false }) })
  const bodies = opened.filter((row) => row.kind === "body")
  expect(bodies.map((row) => row.parts.map((part) => part.id))).toEqual([
    ["inspect"],
    ["create"],
    ["create"],
    ["verify"],
    ["answer"],
  ])
  expect(bodies.find((row) => row.key === "reply:create")?.toolAttachments).toBe("omit")
  expect(bodies.find((row) => row.toolAttachments === "only")?.processBody).toBe(false)
  expect(opened.filter((row) => row.kind === "activity").flatMap((row) => row.activity.parts)).toEqual([
    "inspect",
    "create",
    "verify",
  ])
})

test("summary-only rendering honors producer display policy and evidence attachment purpose", () => {
  const content: SessionPartSummary[] = [
    { ...parts[0], id: "inspect", type: "attachment", attachments: { evidence: 1, deliverable: 0 } },
    { ...parts[0], id: "plugin", tool: "plugin_image", display: "content", status: "running" },
  ]
  const rows = buildConversationRows({
    timeline: [root],
    messagesFor: () => [reply],
    page: () => ({ hasMore: false }),
    summaries: (id) => (id === reply.id ? content : []),
    process: () => ({ open: false, working: true }),
  })
  expect(rows.filter((row) => row.kind === "body").map((row) => row.parts[0].id)).toEqual(["plugin"])
  expect(rows.find((row) => row.kind === "process")?.process?.hasContent).toBe(true)
})

test("user groups preserve their boundaries and keys through canonical message aliases", () => {
  const canonical = { ...root, id: "accepted-root" }
  const content = ["attachment", "text", "text"].map(
    (type, index) =>
      ({
        ...parts[0],
        id: `user-${index}`,
        messageID: root.id,
        type,
        content: { bytes: type === "text" ? 80 * 1024 : 100, version: "captured" },
      }) as SessionPartSummary,
  )
  const input = { messagesFor: () => [], page: () => ({ hasMore: false }), summaries: () => content }
  const before = buildConversationRows({ ...input, timeline: [root] }).filter((row) => row.kind === "body")
  const after = buildConversationRows({
    ...input,
    timeline: [canonical],
    previous: before,
    messageKey: (id) => (id === canonical.id ? root.id : id),
    summaries: () => content.map((part) => ({ ...part, messageID: canonical.id })),
  }).filter((row) => row.kind === "body")
  expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key))
  expect(after.map((row) => row.parts.map((part) => part.id))).toEqual(
    before.map((row) => row.parts.map((part) => part.id)),
  )
  expect(after.filter((row) => row.after)).toHaveLength(1)
})

test("binary attachment hydration cannot split a short user message or its gallery", () => {
  const captured = ["text", "attachment", "attachment", "attachment"].map((type, index) => ({
    ...parts[0],
    id: `user-${index}`,
    messageID: root.id,
    type,
    content: { bytes: 100, version: "captured" },
  })) as SessionPartSummary[]
  const input = { timeline: [root], messagesFor: () => [], page: () => ({ hasMore: false }) }
  const before = buildConversationRows({ ...input, summaries: () => captured }).filter((row) => row.kind === "body")
  const hydrated = captured.map((part) => ({
    ...part,
    content: { version: "canonical", bytes: part.type === "attachment" ? 512 * 1024 : 100 },
  }))
  const after = buildConversationRows({ ...input, previous: before, summaries: () => hydrated }).filter(
    (row) => row.kind === "body",
  )
  expect(after).toHaveLength(1)
  expect(after[0].key).toBe(before[0].key)
  expect(after[0].parts.map((part) => part.id)).toEqual(captured.map((part) => part.id))
  expect(after[0].after).toBe(true)
})

test("one reasoning item keeps its disclosure anchor across bounded body chunks and stream growth", () => {
  const fragments = Array.from({ length: 8 }, (_, index) => ({
    ...parts[0],
    id: `summary-${index}`,
    type: "reasoning",
    reasoningKey: "provider:rs-shared",
    content: { version: `v${index}`, bytes: 1024 },
  }))
  const input = {
    timeline: [root],
    messagesFor: () => [reply],
    page: () => ({ hasMore: false }),
    process: () => ({ open: true, working: true }),
  }
  const before = buildConversationRows({ ...input, summaries: (id) => (id === reply.id ? fragments.slice(0, 2) : []) })
  const grown = buildConversationRows({
    ...input,
    previous: before,
    summaries: (id) => (id === reply.id ? fragments : []),
  })
  const bodies = grown
    .flatMap((row) => (row.kind === "activity" ? row.activity.entries : []))
    .filter((row) => row.kind === "body")
  expect(bodies.map((row) => row.parts.length)).toEqual([6, 2])
  expect(bodies.flatMap((row) => Object.values(row.reasoningAnchors ?? {}))).toEqual(Array(8).fill("summary-0"))
  expect(grown.find((row) => row.kind === "activity")?.activity?.reasoning).toBe(1)

  const separated = buildConversationRows({
    ...input,
    summaries: (id) => (id === reply.id ? [fragments[0], { ...parts[0], id: "boundary" }, fragments[1]] : []),
  })
  const entries = separated.find((row) => row.kind === "activity")?.activity?.entries ?? []
  expect(entries.flatMap((row) => (row.kind === "body" ? Object.values(row.reasoningAnchors ?? {}) : []))).toEqual([
    "summary-0",
    "summary-1",
  ])

  const byteLimited = buildConversationRows({
    ...input,
    summaries: (id) =>
      id === reply.id
        ? fragments.slice(0, 2).map((part) => ({ ...part, content: { ...part.content, bytes: 80 * 1024 } }))
        : [],
  })
  expect(
    byteLimited
      .find((row) => row.kind === "activity")
      ?.activity?.entries.filter((row) => row.kind === "body")
      .map((row) => row.parts.length),
  ).toEqual([1, 1])
  expect(byteLimited.find((row) => row.kind === "activity")?.activity?.reasoning).toBe(1)

  const other = { ...reply, id: "other" }
  const messages = buildConversationRows({
    ...input,
    messagesFor: () => [reply, other],
    summaries: (id) =>
      id === reply.id ? [fragments[0]] : id === other.id ? [{ ...fragments[1], messageID: other.id }] : [],
  })
  expect(messages.find((row) => row.kind === "activity")?.activity?.reasoning).toBe(2)
})

test("ordinary user attachments and body form one stable message with one metadata boundary", () => {
  for (const types of [
    ["attachment", "text"],
    ["attachment", "attachment", "text"],
    ["text", "attachment", "attachment"],
  ]) {
    const content = types.map(
      (type, index) => ({ ...parts[0], id: `user-${index}`, messageID: root.id, type }) as SessionPartSummary,
    )
    const input = {
      timeline: [root],
      messagesFor: () => [],
      summaries: () => content,
      page: () => ({ hasMore: false }),
    }
    const rows = buildConversationRows(input)
    const bodies = rows.filter((row) => row.kind === "body")
    expect(bodies).toHaveLength(1)
    expect(bodies[0].parts).toEqual(content)
    expect(bodies[0]).toMatchObject({ before: true, after: true })
    const reconciled = buildConversationRows({ ...input, previous: rows, summaries: () => [...content].reverse() })
    expect(reconciled.find((row) => row.kind === "body")?.key).toBe(bodies[0].key)
  }
})

test("large user text stays bounded and pagination owns only the final metadata boundary", () => {
  const content = Array.from(
    { length: 12 },
    (_, index) =>
      ({
        ...parts[0],
        id: `user-${index}`,
        messageID: root.id,
        type: "text",
        content: { bytes: 80 * 1024 },
      }) as SessionPartSummary,
  )
  const input = {
    timeline: [root],
    messagesFor: () => [],
    summaries: () => content,
    page: () => ({ hasMore: true, hasEarlier: true }),
  }
  const initial = buildConversationRows(input)
  const bodies = initial.filter((row) => row.kind === "body")
  expect(bodies.flatMap((row) => row.parts)).toEqual(content)
  expect(
    bodies.every((row) => row.parts.reduce((bytes, part) => bytes + (part.content?.bytes ?? 0), 0) <= 128 * 1024),
  ).toBe(true)
  expect(bodies.some((row) => row.before || row.after)).toBe(false)
  const complete = buildConversationRows({
    ...input,
    previous: initial,
    page: () => ({ hasMore: false, hasEarlier: false }),
  })
  expect(complete.filter((row) => row.kind === "body" && row.after)).toHaveLength(1)
  expect(complete.filter((row) => row.kind === "body").map((row) => row.key)).toEqual(bodies.map((row) => row.key))
})

test("many short user text Parts retain a finite row budget and expanded bodies keep unique identities", () => {
  const content = Array.from({ length: 1001 }, (_, index) => ({
    ...parts[0],
    id: `user-${index}`,
    messageID: root.id,
    type: "text",
    content: { bytes: 10 },
  })) as SessionPartSummary[]
  const input = { timeline: [root], messagesFor: () => [], summaries: () => content, page: () => ({ hasMore: false }) }
  const rows = buildConversationRows(input).filter((row) => row.kind === "body")
  expect(rows.every((row) => row.parts.length <= 6)).toBe(true)
  expect(rows.flatMap((row) => row.parts)).toEqual(content)
  expect(rows.filter((row) => row.after)).toHaveLength(1)
  const initial = buildConversationRows({ ...input, summaries: () => content.slice(0, 2) })
  const grown = buildConversationRows({
    ...input,
    previous: initial,
    summaries: () =>
      content.slice(0, 2).map((part) => ({ ...part, content: { bytes: 80 * 1024, version: "expanded" } })),
  }).filter((row) => row.kind === "body")
  expect(new Set(grown.map((row) => row.key)).size).toBe(grown.length)
  expect(grown[0].key).toBe(initial[0].key)
})

test("the supported twenty attachments remain one complete gallery with their authored text", () => {
  const content = Array.from({ length: 21 }, (_, index) => ({
    ...parts[0],
    id: `user-${index}`,
    messageID: root.id,
    type: index === 20 ? "text" : "attachment",
    content: { bytes: 100 },
  })) as SessionPartSummary[]
  const rows = buildConversationRows({
    timeline: [root],
    messagesFor: () => [],
    summaries: () => content,
    page: () => ({ hasMore: false }),
  }).filter((row) => row.kind === "body")
  expect(rows).toHaveLength(1)
  expect(rows[0].parts).toEqual(content)
})

test("prepending user content preserves existing group starts and one final metadata owner", () => {
  const content = ["image", "body"].map(
    (id) =>
      ({ ...parts[0], id, messageID: root.id, type: id === "image" ? "attachment" : "text" }) as SessionPartSummary,
  )
  const input = { timeline: [root], messagesFor: () => [], summaries: () => content, page: () => ({ hasMore: false }) }
  const initial = buildConversationRows(input)
  const next = buildConversationRows({
    ...input,
    previous: initial,
    summaries: () => [{ ...content[1], id: "earlier" }, ...content],
  })
  const bodies = next.filter((row) => row.kind === "body")
  expect(bodies).toHaveLength(2)
  expect(bodies[1].key).toBe(initial.find((row) => row.kind === "body")!.key)
  expect(bodies[1].parts).toEqual(content)
  expect(bodies.filter((row) => row.after)).toHaveLength(1)
})

test("repeated compaction control markers do not create body rows or duplicate attempt events", () => {
  const text = { ...parts[0], id: "request-text", messageID: root.id, type: "text" } as SessionPartSummary
  const markers = Array.from({ length: 8 }, (_, index) => ({
    ...text,
    id: `marker-${index}`,
    type: "compaction",
    render: true,
  })) as SessionPartSummary[]
  const attempts = markers.map((_, index) => ({
    ...reply,
    id: `attempt-${index}`,
    metadata: { compactionAttempt: { state: "committed" } },
  })) as Message[]
  for (const open of [false, true]) {
    const rows = buildConversationRows({
      timeline: [root],
      messagesFor: () => attempts,
      summaries: (id) =>
        id === root.id
          ? [text, ...markers]
          : [{ ...text, id: `${id}-recovery`, messageID: id, type: "compaction_recovery" }],
      page: () => ({ hasMore: false }),
      process: () => ({ open, working: false }),
    })
    const bodies = rows.filter((row) => row.kind === "body")
    expect(
      bodies.filter((row) => row.message.id === root.id).flatMap((row) => row.parts.map((part) => part.id)),
    ).toEqual([text.id])
    expect(bodies.filter((row) => row.event === "compaction").map((row) => row.message.id)).toEqual(
      open ? attempts.map((message) => message.id) : [],
    )
  }
})

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

test("Render visuals and their final explanation stay visible when process history is closed", () => {
  const before = { ...parts[0], id: "before", type: "text" } as SessionPartSummary
  const visual = { ...parts[0], id: "visual", tool: "render", status: "completed" }
  const after = { ...before, id: "after" }
  for (const open of [false, true]) {
    const rows = buildConversationRows({
      timeline: [root],
      messagesFor: () => [{ ...reply, finish: "stop" } as Message],
      summaries: (id) => (id === reply.id ? [before, visual, after] : []),
      page: () => ({ hasMore: false }),
      process: () => ({ open, working: false }),
      activity: () => false,
    })
    const bodies = rows.filter((row) => row.kind === "body")
    expect(bodies.map((row) => row.parts[0].id)).toEqual(["before", "visual", "after"])
    expect(bodies.every((row) => !row.processBody && !row.activity)).toBe(true)
    expect(rows.find((row) => row.kind === "process")?.process?.hasContent).toBe(false)
  }
})

test("Render receipts split bounded activity chunks without changing their identities", () => {
  for (const status of ["pending", "running", "completed", "error"]) {
    const values = [
      { ...parts[0], id: "read-before", tool: "read" },
      { ...parts[0], id: "visual", tool: "render", status },
      { ...parts[0], id: "read-after", tool: "read" },
    ]
    const input = {
      timeline: [root],
      messagesFor: () => [reply],
      summaries: (id: string) => (id === reply.id ? values : []),
      page: () => ({ hasMore: false }),
      process: () => ({ open: true, working: false }),
    }
    const expanded = buildConversationRows(input)
    expect(expanded.filter((row) => row.kind === "activity").map((row) => row.activity.parts)).toEqual([
      ["read-before"],
      ["read-after"],
    ])
    const collapsed = buildConversationRows({
      ...input,
      previous: expanded,
      process: () => ({ open: false, working: false }),
    })
    const visible = collapsed.filter((row) => row.kind === "body")
    expect(visible.map((row) => row.key)).toEqual([`${reply.id}:visual`])
    expect(visible[0].processBody).toBe(false)
    expect(visible[0].activity).toBeUndefined()
  }
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
  expect(grown.find((row) => row.kind === "activity")?.key).toBe(initial.find((row) => row.kind === "activity")?.key)
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

test("a running parallel call keeps its earlier batch active and summaries count only confirmed success", () => {
  const input = processFixture()
  const original = input.summaries
  const rows = buildConversationRows({
    ...input,
    messagesFor: () => input.messagesFor().slice(0, 2),
    summaries: (id) => {
      const items = original(id).map((part) =>
        part.type === "tool" ? { ...part, tool: "bash", status: id === "work" ? "running" : "error" } : part,
      )
      return id === "more" ? [{ ...items[0], id: "boundary", type: "text" }, ...items] : items
    },
    process: () => ({ open: true, working: true }),
  })
  const blocks = rows.filter((row) => row.kind === "activity" && row.activity.tools)
  expect(blocks.map((row) => [row.activity!.tools, row.activity!.active, row.activity!.facts])).toEqual([
    [1, true, []],
    [1, true, []],
  ])
})

test("final resource references replace delivery galleries using summaries without hydrating history", () => {
  const image = "asset://0123456789abcdef.png"
  const document = "asset://fedcba9876543210.docx"
  const work = { ...reply, id: "work", finish: "tool-calls" } as Message
  const final = { ...reply, id: "final", finish: "stop" } as Message
  const output = {
    ...parts[0],
    id: "create",
    messageID: work.id,
    tool: "bash",
    display: "activity",
    attachments: { evidence: 1, deliverable: 2, references: [image, document] },
  } as SessionPartSummary
  const input = {
    timeline: [root],
    messagesFor: () => [work, final],
    page: () => ({ hasMore: false }),
    process: () => ({ open: false, working: false }),
  }
  const rows = (references: string[]) =>
    buildConversationRows({
      ...input,
      summaries: (id) =>
        id === work.id ? [output] : id === final.id ? [{ ...parts[0], id: "answer", type: "text", references }] : [],
    })
  expect(
    rows([])
      .filter((row) => row.kind === "body")
      .map((row) => row.key),
  ).toEqual(["work:create:attachments", "final:answer"])
  const partial = rows([image]).find((row) => row.kind === "body" && row.toolAttachments === "only")
  expect(partial?.kind === "body" && partial.hiddenAttachments?.create).toEqual([image])
  expect(
    rows([image, document])
      .filter((row) => row.kind === "body")
      .map((row) => row.key),
  ).toEqual(["final:answer"])
  output.attachments!.deliverable = 3
  expect(rows([image, document]).some((row) => row.kind === "body" && row.toolAttachments === "only")).toBe(true)
})
