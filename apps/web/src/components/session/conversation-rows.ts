import type { Message, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

export type ConversationActivity = {
  key: string
  parts: string[]
  tools: number
  reasoning: number
  active: boolean
  open: boolean
}

export type ConversationRow = {
  key: string
  root: Message
  message: Message
  activity?: ConversationActivity
  exiting?: boolean
  process?: { open: boolean; working: boolean; hasContent: boolean; hasTurnContent: boolean }
} & (
  | {
      kind: "body"
      parts: SessionPartSummary[]
      before: boolean
      after: boolean
      beforeTool: boolean
      beforeReasoning: boolean
      processBody?: boolean
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
  const boundaries = new Set(input.previous?.filter((row) => row.kind === "body").map((row) => row.key))
  for (const root of input.timeline) {
    const messages =
      root.role === "assistant"
        ? [root]
        : [root, ...input.messagesFor(root).filter((message) => message.id !== root.id)]
    const processState = root.role === "user" ? input.process?.(root) : undefined
    const lastAssistant = messages.findLast((message) => message.role === "assistant")
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
        const parts = input.summaries(message.id).filter((part) => part.render !== false)
        return parts.some((_, index) => isProcessPart(message, parts, index))
      }),
    }
    let header = false
    for (const message of messages) {
      if (process && message.role === "assistant" && !header) {
        rows.push({ key: `${root.id}:process`, root, message: root, kind: "process", process })
        header = true
      }
      const parts = input.summaries(message.id).filter((part) => part.render !== false)
      const page = input.page(message.id)
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
        if (process && processBody && !process.open) continue
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
  return groupActivities(rows, input.activity)
}

function groupActivities(
  rows: ConversationRow[],
  expanded?: (block: ConversationActivity) => boolean,
): ConversationRow[] {
  const result: ConversationRow[] = []
  const blocks: ConversationActivity[] = []
  let block: ConversationActivity | undefined
  for (const row of rows) {
    if (
      row.process &&
      row.kind === "body" &&
      row.message.role === "assistant" &&
      row.parts.every((part) => part.type === "tool" || part.type === "reasoning")
    ) {
      if (!block) {
        block = {
          key: `${row.root.id}:activity:${row.parts[0].id}`,
          parts: [],
          tools: 0,
          reasoning: 0,
          active: row.process.working,
          open: true,
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
      for (const part of row.parts) {
        block.parts.push(part.id)
        if (part.type === "tool") block.tools++
        else block.reasoning++
      }
      row.activity = block
    } else if (row.kind !== "process") {
      if (block && (row.kind === "load" || (row.kind === "body" && (row.processBody || row.message.role === "user"))))
        block.active = false
      block = undefined
    }
    result.push(row)
  }
  for (const block of blocks) block.open = expanded?.(block) ?? true
  return result.filter((row) => row.kind !== "body" || !row.activity || row.activity.open)
}
