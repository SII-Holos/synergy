import type { Message, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

import {
  ACTIVITY_FAMILY_ORDER,
  activityFamilyForTool,
  semanticCategoryForKnownTool,
  type ActivityFamily,
} from "@ericsanchezok/synergy-util/activity"

export type ConversationActivity = {
  key: string
  parts: string[]
  facts: { family: ActivityFamily; count: number }[]
  fileReadOperations: number
  searchOperations: number
  inspectionOperations: number
  tools: number
  reasoning: number
  active: boolean
  open: boolean
  entries: ConversationRow[]
}

export type ConversationRow = {
  key: string
  root: Message
  message: Message
  activity?: ConversationActivity
  activities?: ConversationActivity[]
  exiting?: boolean
  process?: {
    open: boolean
    working: boolean
    hasContent: boolean
    hasTurnContent: boolean
  }
} & (
  | {
      kind: "body"
      parts: SessionPartSummary[]
      before: boolean
      after: boolean
      beforeTool: boolean
      beforeReasoning: boolean
      processBody?: boolean
      event?: "agent-delivery" | "compaction"
    }
  | { kind: "activity"; activity: ConversationActivity }
  | { kind: "process" }
  | { kind: "footer" }
  | { kind: "load"; more: boolean; older?: boolean }
)

export function buildConversationRows(input: {
  previous?: readonly ConversationRow[]
  timeline: readonly Message[]
  messagesFor: (root: Message) => readonly Message[]
  summaries: (messageID: string) => readonly SessionPartSummary[]
  page: (messageID: string) => { hasMore: boolean; hasEarlier?: boolean } | undefined
  activity?: (block: ConversationActivity) => boolean
  process?: (root: Message) => { open: boolean; working: boolean }
}): ConversationRow[] {
  const rows: ConversationRow[] = []
  const previousBlocks =
    input.previous?.flatMap((row) =>
      row.kind === "process" ? (row.activities ?? []) : row.kind === "activity" ? [row.activity] : [],
    ) ?? []
  const boundaries = new Set(
    [...previousBlocks.flatMap((block) => block.entries), ...(input.previous ?? [])]
      .filter((row) => row.kind === "body")
      .map((row) => row.key),
  )
  for (const root of input.timeline) {
    const messages =
      root.role === "assistant"
        ? [root]
        : [root, ...input.messagesFor(root).filter((message) => message.id !== root.id)]
    const processState = root.role === "user" ? input.process?.(root) : undefined
    const lastAssistant = messages.findLast((message) => message.role === "assistant")
    const isCompaction = (message: Message) =>
      message.role === "assistant" &&
      (message.metadata?.compactionAttempt ||
        message.mode === "compaction" ||
        message.agent === "compaction" ||
        input.summaries(message.id).some((part) => part.type === "compaction_recovery"))
    const hasCompaction = messages.some(isCompaction)
    const eventFor = (message: Message) => {
      if (
        message.role === "user" &&
        message.isRoot === false &&
        ["cortex", "agent"].includes(message.origin?.type ?? "")
      )
        return "agent-delivery" as const
      if (
        isCompaction(message) ||
        (message.role === "user" && message.metadata?.compactionBoundary === true && !hasCompaction)
      )
        return "compaction" as const
    }
    const isProcessPart = (message: Message, parts: readonly SessionPartSummary[], index: number) =>
      message.role === "assistant" &&
      (parts[index].type === "tool" ||
        parts[index].type === "reasoning" ||
        (parts[index].type === "text" &&
          (message.id !== lastAssistant?.id ||
            message.finish === "tool-calls" ||
            parts.slice(index + 1).some((part) => part.type === "tool"))))
    const process = processState && {
      ...processState,
      hasTurnContent: messages.some(
        (message) => message.role === "assistant" && input.summaries(message.id).some((part) => part.render !== false),
      ),
      hasContent: messages.some((message) => {
        if (eventFor(message)) return true
        const parts = input.summaries(message.id).filter((part) => part.render !== false)
        return parts.some((_, index) => isProcessPart(message, parts, index))
      }),
    }
    let header = false
    for (const message of messages) {
      const event = eventFor(message)
      if (message.role === "user" && message.metadata?.compactionBoundary === true && !event) continue
      if (process && (message.role === "assistant" || event) && !header) {
        rows.push({ key: `${root.id}:process`, root, message: root, kind: "process", process })
        header = true
      }
      const parts = input.summaries(message.id).filter((part) => part.render !== false)
      const page = input.page(message.id)
      if (event) {
        if (
          message.role === "assistant" &&
          (message.metadata?.compactionAttempt as { state?: string } | undefined)?.state === "empty"
        )
          continue
        rows.push({
          key: `${message.id}:${event}`,
          root,
          message,
          kind: "body",
          parts,
          before: true,
          after: true,
          beforeTool: false,
          beforeReasoning: false,
          process,
          processBody: true,
          event,
        })
        continue
      }
      if (page?.hasEarlier)
        rows.push({ key: `${message.id}:earlier`, root, message, kind: "load", more: true, older: true })
      const firstTool = parts.findIndex((part) => part.type === "tool"),
        firstReasoning = parts.findIndex((part) => part.type === "reasoning")
      for (let offset = 0; offset < parts.length; ) {
        const first = offset++
        const processBody = isProcessPart(message, parts, first)
        let bytes = parts[first].content?.bytes ?? 0
        if (process && ["tool", "reasoning"].includes(parts[first].type)) {
          while (
            offset < parts.length &&
            offset - first < 6 &&
            !boundaries.has(`${message.id}:${parts[offset].id}`) &&
            ["tool", "reasoning"].includes(parts[offset].type) &&
            bytes + (parts[offset].content?.bytes ?? 0) <= 128 * 1024
          ) {
            bytes += parts[offset].content?.bytes ?? 0
            offset++
          }
        }
        rows.push({
          key: `${message.id}:${parts[first].id}`,
          root,
          message,
          kind: "body",
          parts: parts.slice(first, offset),
          process,
          processBody,
          before: first === 0 && !page?.hasEarlier,
          after: offset >= parts.length && !page?.hasMore,
          beforeTool: !page?.hasEarlier && firstTool >= first && firstTool < offset,
          beforeReasoning: !page?.hasEarlier && firstReasoning >= first && firstReasoning < offset,
        })
      }
      if (!page || page.hasMore) rows.push({ key: `${message.id}:load`, root, message, kind: "load", more: !!page })
    }
    if (process && !header) rows.push({ key: `${root.id}:process`, root, message: root, kind: "process", process })
    rows.push({ key: `${root.id}:footer`, root, message: root, kind: "footer", process })
  }
  return groupActivities(rows, input.activity, previousBlocks).filter(
    (row) => !row.process || row.process.open || (row.kind !== "activity" && !(row.kind === "body" && row.processBody)),
  )
}

function groupActivities(
  rows: ConversationRow[],
  expanded?: (block: ConversationActivity) => boolean,
  previous: readonly ConversationActivity[] = [],
): ConversationRow[] {
  const result: ConversationRow[] = []
  const blocks: ConversationActivity[] = []
  let block: ConversationActivity | undefined
  for (const row of rows) {
    if (
      row.process &&
      row.kind === "body" &&
      (row.event ||
        (row.message.role === "assistant" &&
          row.parts.every((part) => part.type === "tool" || part.type === "reasoning")))
    ) {
      if (!block) {
        block = {
          key: `${row.root.id}:activity:${row.event ? row.key : row.parts[0].id}`,
          parts: [],
          tools: 0,
          facts: [],
          fileReadOperations: 0,
          searchOperations: 0,
          inspectionOperations: 0,
          reasoning: 0,
          active: row.process.working,
          open: true,
          entries: [],
        }
        blocks.push(block)
        result.push({
          key: block.key,
          root: row.root,
          message: row.message,
          kind: "activity",
          process: row.process,
          activity: block,
        })
      }
      block.entries.push(row)
      for (const part of row.parts) {
        block.parts.push(part.id)
        if (!row.event && part.type === "tool") block.tools++
        else if (!row.event && part.type === "reasoning") block.reasoning++
      }
      row.activity = block
    } else if (row.kind !== "process") {
      if (block && (row.kind === "load" || (row.kind === "body" && (row.processBody || row.message.role === "user"))))
        block.active = false
      block = undefined
    }
    result.push(row)
  }
  const priorKeys = new Map(previous.flatMap((block) => block.parts.map((id) => [id, block.key] as const)))
  const used = new Set<string>()
  for (const block of blocks) {
    const key = block.parts.map((id) => priorKeys.get(id)).find((key) => key && !used.has(key))
    if (key) block.key = key
    used.add(block.key)
    const counts = new Map<ActivityFamily, number>()
    for (const row of block.entries) {
      if (row.kind !== "body" || row.event) continue
      for (const part of row.parts) {
        if (part.type !== "tool") continue
        if (row.process?.working && ["pending", "generating", "running"].includes(part.status ?? ""))
          block.active = true
        if (part.status !== "completed" || !part.tool) continue
        const family = activityFamilyForTool(part.tool)
        counts.set(family, (counts.get(family) ?? 0) + 1)
        if (family !== "inspect-local") continue
        const category = semanticCategoryForKnownTool(part.tool)
        if (category === "file-read" && part.tool !== "list") block.fileReadOperations++
        else if (category === "search") block.searchOperations++
        else block.inspectionOperations++
      }
    }
    block.facts = ACTIVITY_FAMILY_ORDER.flatMap((family) => {
      const count = counts.get(family) ?? 0
      return count ? [{ family, count }] : []
    })
    block.open = expanded?.(block) ?? true
  }
  for (const row of result) {
    if (row.kind === "activity") row.key = row.activity.key
    if (row.kind === "process" && row.process)
      row.activities = blocks.filter((block) => block.entries[0]?.root.id === row.root.id)
  }
  return result.filter((row) => row.kind !== "body" || !row.activity || row.activity.open)
}
