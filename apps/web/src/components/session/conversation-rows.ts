import type { Message, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

export type ConversationRow = {
  key: string
  root: Message
  message: Message
} & (
  | {
      kind: "body"
      parts: SessionPartSummary[]
      before: boolean
      after: boolean
      beforeTool: boolean
      beforeReasoning: boolean
    }
  | { kind: "footer" }
  | { kind: "load"; more: boolean; older?: boolean }
)

export function buildConversationRows(input: {
  timeline: readonly Message[]
  messagesFor: (root: Message) => readonly Message[]
  summaries: (messageID: string) => readonly SessionPartSummary[]
  page: (messageID: string) => { hasMore: boolean; hasEarlier?: boolean } | undefined
}): ConversationRow[] {
  const rows: ConversationRow[] = []
  for (const root of input.timeline) {
    const messages =
      root.role === "assistant"
        ? [root]
        : [root, ...input.messagesFor(root).filter((message) => message.id !== root.id)]
    for (const message of messages) {
      const parts = input.summaries(message.id).filter((part) => part.render !== false)
      const page = input.page(message.id)
      if (page?.hasEarlier)
        rows.push({ key: `${message.id}:earlier`, root, message, kind: "load", more: true, older: true })
      const firstTool = parts.findIndex((part) => part.type === "tool"),
        firstReasoning = parts.findIndex((part) => part.type === "reasoning")
      for (let offset = 0; offset < parts.length; offset++) {
        rows.push({
          key: `${message.id}:${parts[offset].id}`,
          root,
          message,
          kind: "body",
          parts: [parts[offset]],
          before: offset === 0 && !page?.hasEarlier,
          after: offset + 1 >= parts.length && !page?.hasMore,
          beforeTool: !page?.hasEarlier && firstTool === offset,
          beforeReasoning: !page?.hasEarlier && firstReasoning === offset,
        })
      }
      if (!page || page.hasMore) rows.push({ key: `${message.id}:load`, root, message, kind: "load", more: !!page })
    }
    rows.push({ key: `${root.id}:footer`, root, message: root, kind: "footer" })
  }
  return rows
}
