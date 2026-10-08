import type { Message, SessionPartSummary } from "@ericsanchezok/synergy-sdk"
import { isActivityGroupableTool } from "@ericsanchezok/synergy-util/activity"
import { attachmentSuppression } from "@ericsanchezok/synergy-util/markdown-assets"

const isExecutionPart = (part: SessionPartSummary) =>
  part.type === "reasoning" ||
  (part.type === "tool" && (part.display ? part.display === "activity" : isActivityGroupableTool(part.tool ?? "")))

const separatesDeliverables = (part: SessionPartSummary) =>
  part.type === "tool" && isExecutionPart(part) && (part.attachments?.deliverable ?? 0) > 0

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
  motion?: { kind: "enter" | "exit" }
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
      reasoningAnchors?: Record<string, string>
      processBody?: boolean
      toolAttachments?: "only" | "omit"
      hiddenAttachments?: Readonly<Record<string, readonly string[]>>
      event?: "agent-delivery" | "compaction"
    }
  | { kind: "activity"; activity: ConversationActivity }
  | { kind: "process" }
  | { kind: "footer" }
  | { kind: "load"; more: boolean; older?: boolean }
)

// Provenance: docs/postmortem/0059-cold-process-disclosure-jank.md
// Local adaptation: Pending process bodies reserve compact summary lines until accepted content can be measured.
export const estimateConversationRowSize = (row: ConversationRow) =>
  28 * (row.kind === "body" ? Math.max(1, row.parts.length) : 1)

export function buildConversationRows(input: {
  previous?: readonly ConversationRow[]
  timeline: readonly Message[]
  messageKey?: (messageID: string) => string
  messagesFor: (root: Message) => readonly Message[]
  summaries: (messageID: string) => readonly SessionPartSummary[]
  page: (messageID: string) => { hasMore: boolean; hasEarlier?: boolean } | undefined
  activity?: (block: ConversationActivity) => boolean
  process?: (root: Message) => { open: boolean; working: boolean }
}): ConversationRow[] {
  const rows: ConversationRow[] = []
  const messageKey = input.messageKey ?? ((id: string) => id)
  const partsFor = (messageID: string) =>
    input.summaries(messageID).filter((part) => part.render !== false && part.type !== "compaction")
  const previousBlocks =
    input.previous?.flatMap((row) =>
      row.kind === "process" ? (row.activities ?? []) : row.kind === "activity" ? [row.activity] : [],
    ) ?? []
  const boundaries = new Set(
    [...previousBlocks.flatMap((block) => block.entries), ...(input.previous ?? [])]
      .filter((row) => row.kind === "body")
      .map((row) => row.key),
  )
  const userRows = input.previous?.filter((row) => row.kind === "body" && row.message.role === "user") ?? []
  const userPartRows = new Map<string, string>()
  const userBoundaries = new Set<string>()
  const usedUserKeys = new Set<string>()
  for (const row of userRows) {
    if (row.kind !== "body") continue
    if (row.parts[0]) userBoundaries.add(`${messageKey(row.message.id)}:${row.parts[0].id}`)
    for (const part of row.parts) userPartRows.set(`${messageKey(row.message.id)}:${part.id}`, row.key)
  }
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
      (isExecutionPart(parts[index]) ||
        (parts[index].type === "attachment" && (parts[index].attachments?.evidence ?? 0) > 0) ||
        (parts[index].type === "text" &&
          (message.id !== lastAssistant?.id ||
            message.finish === "tool-calls" ||
            parts.slice(index + 1).some((part) => part.type === "tool" && isExecutionPart(part)))))
    const process = processState && {
      ...processState,
      hasTurnContent: messages.some((message) => message.role === "assistant" && partsFor(message.id).length > 0),
      hasContent: messages.some((message) => {
        if (eventFor(message)) return true
        const parts = partsFor(message.id)
        return parts.some((_, index) => isProcessPart(message, parts, index))
      }),
    }
    const assistantParts = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => partsFor(message.id))
    const inline =
      lastAssistant && lastAssistant.finish !== "tool-calls"
        ? partsFor(lastAssistant.id).flatMap((part, index, parts) =>
            part.type === "text" && !isProcessPart(lastAssistant, parts, index) ? (part.references ?? []) : [],
          )
        : []
    const hiddenAttachments = attachmentSuppression(
      assistantParts.map((part) => ({ id: part.id, references: part.attachments?.references })),
      inline,
    )
    const allAttachmentsHidden = (part: SessionPartSummary) => {
      const count = part.attachments?.deliverable ?? 0
      const refs = part.attachments?.references ?? []
      return count > 0 && count === refs.length && refs.every((ref) => hiddenAttachments[part.id]?.includes(ref))
    }
    let header = false
    for (const message of messages) {
      const event = eventFor(message)
      if (message.role === "user" && message.metadata?.compactionBoundary === true && !event) continue
      if (process && (message.role === "assistant" || event) && !header) {
        rows.push({ key: `${messageKey(root.id)}:process`, root, message: root, kind: "process", process })
        header = true
      }
      const parts = partsFor(message.id)
      const page = input.page(message.id)
      if (event) {
        if (
          message.role === "assistant" &&
          (message.metadata?.compactionAttempt as { state?: string } | undefined)?.state === "empty"
        )
          continue
        rows.push({
          key: `${messageKey(message.id)}:${event}`,
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
        rows.push({ key: `${messageKey(message.id)}:earlier`, root, message, kind: "load", more: true, older: true })
      const firstTool = parts.findIndex((part) => part.type === "tool"),
        firstReasoning = parts.findIndex((part) => part.type === "reasoning")
      const bodyBytes = (part: SessionPartSummary) =>
        message.role === "user" && part.type === "attachment" ? 0 : (part.content?.bytes ?? 0)
      const reasoningAnchors: Record<string, string> = {}
      let previousReasoning: { identity: string; anchor: string } | undefined
      for (const part of parts) {
        if (part.type !== "reasoning") {
          previousReasoning = undefined
          continue
        }
        const anchor =
          part.reasoningKey && part.reasoningKey === previousReasoning?.identity ? previousReasoning.anchor : part.id
        reasoningAnchors[part.id] = anchor
        previousReasoning = part.reasoningKey ? { identity: part.reasoningKey, anchor } : undefined
      }
      for (let offset = 0; offset < parts.length; ) {
        const first = offset++
        const processBody = isProcessPart(message, parts, first)
        let bytes = bodyBytes(parts[first])
        let texts = parts[first].type === "text" ? 1 : 0
        const userKey = userPartRows.get(`${messageKey(message.id)}:${parts[first].id}`)
        if (message.role === "user") {
          while (
            offset < parts.length &&
            offset - first < 32 &&
            (parts[offset].type !== "text" || texts < 6) &&
            (!userBoundaries.has(`${messageKey(message.id)}:${parts[offset].id}`) ||
              userPartRows.get(`${messageKey(message.id)}:${parts[offset].id}`) === userKey) &&
            bytes + bodyBytes(parts[offset]) <= 128 * 1024
          ) {
            bytes += bodyBytes(parts[offset])
            if (parts[offset].type === "text") texts++
            offset++
          }
        }
        if (process && isExecutionPart(parts[first])) {
          while (
            offset < parts.length &&
            !separatesDeliverables(parts[first]) &&
            !separatesDeliverables(parts[offset]) &&
            offset - first < 6 &&
            !boundaries.has(`${messageKey(message.id)}:${parts[offset].id}`) &&
            isExecutionPart(parts[offset]) &&
            bytes + bodyBytes(parts[offset]) <= 128 * 1024
          ) {
            bytes += bodyBytes(parts[offset])
            offset++
          }
        }
        const key =
          (userKey && !usedUserKeys.has(userKey) ? userKey : undefined) ??
          (message.role === "user" &&
          first === 0 &&
          !page?.hasEarlier &&
          !userRows.some((row) => row.key === `${messageKey(message.id)}:user`)
            ? `${messageKey(message.id)}:user`
            : `${messageKey(message.id)}:${parts[first].id}`)
        if (message.role === "user") usedUserKeys.add(key)
        const splitAttachments = message.role === "assistant" && separatesDeliverables(parts[first])
        const hiddenOutput = message.role === "assistant" && allAttachmentsHidden(parts[first])
        const body: Extract<ConversationRow, { kind: "body" }> = {
          key,
          root,
          message,
          kind: "body",
          parts: parts.slice(first, offset),
          reasoningAnchors: Object.fromEntries(
            parts
              .slice(first, offset)
              .filter((part) => part.type === "reasoning")
              .map((part) => [part.id, reasoningAnchors[part.id]]),
          ),
          process,
          processBody,
          hiddenAttachments,
          toolAttachments: splitAttachments ? "omit" : undefined,
          before: first === 0 && !page?.hasEarlier,
          after: (!splitAttachments || hiddenOutput) && offset >= parts.length && !page?.hasMore,
          beforeTool: !page?.hasEarlier && firstTool >= first && firstTool < offset,
          beforeReasoning: !page?.hasEarlier && firstReasoning >= first && firstReasoning < offset,
        }
        if (!hiddenOutput || parts[first].type !== "attachment") rows.push(body)
        if (splitAttachments && !hiddenOutput)
          rows.push({
            ...body,
            key: `${key}:attachments`,
            toolAttachments: "only",
            processBody: false,
            before: false,
            after: offset >= parts.length && !page?.hasMore,
            beforeTool: false,
            beforeReasoning: false,
          })
      }
      if (!page || page.hasMore)
        rows.push({ key: `${messageKey(message.id)}:load`, root, message, kind: "load", more: !!page })
    }
    if (process && !header)
      rows.push({ key: `${messageKey(root.id)}:process`, root, message: root, kind: "process", process })
    rows.push({ key: `${messageKey(root.id)}:footer`, root, message: root, kind: "footer", process })
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
      row.toolAttachments !== "only" &&
      (row.event || (row.message.role === "assistant" && row.parts.every(isExecutionPart)))
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
        else if (!row.event && part.type === "reasoning" && (row.reasoningAnchors?.[part.id] ?? part.id) === part.id)
          block.reasoning++
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
