import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"

export type RawSessionMessage = {
  info: Message
  parts: Part[]
}

export type RawMessageRecord = {
  message: Message
  parts: Part[]
}
export type RawMessagePresentation = {
  roles: Record<Message["role"], string>
  hiddenFlag: string
  excludedFlag: string
}

export async function loadRawMessages(input: {
  sessionID: string
  limit: number
  fetch: (request: { sessionID: string; raw: true; limit: number }) => Promise<{ data?: RawSessionMessage[] }>
}) {
  const result = await input.fetch({ sessionID: input.sessionID, raw: true, limit: input.limit })
  return sortRawSessionMessages(result.data ?? [])
}

export function rawMessagePreview(message: RawSessionMessage, presentation: RawMessagePresentation): string {
  return presentation.roles[message.info.role]
}

export function rawMessageShortID(message: RawSessionMessage): string {
  const id = message.info.id
  if (id.length <= 16) return id
  return `…${id.slice(-8)}`
}

export function rawMessageFlags(message: RawSessionMessage, presentation: RawMessagePresentation): string[] {
  const flags: string[] = []
  if (message.info.visible === false) flags.push(presentation.hiddenFlag)
  if (message.info.includeInContext === false) flags.push(presentation.excludedFlag)
  return flags
}

export function rawMessageCreatedAt(message: RawSessionMessage): number {
  return message.info.time.created
}

export function rawMessageRecord(message: RawSessionMessage): RawMessageRecord {
  return { message: message.info, parts: message.parts }
}

export function rawMessageJson(message: RawSessionMessage | undefined): string {
  if (!message) return ""
  return JSON.stringify(rawMessageRecord(message), null, 2)
}

export function sortRawSessionMessages(messages: RawSessionMessage[]): RawSessionMessage[] {
  return messages
    .slice()
    .sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
}

export function compactSessionMessagesForCopy(messages: RawSessionMessage[], selectedIds?: Set<string>): string {
  const selected = selectedIds ? messages.filter((message) => selectedIds.has(message.info.id)) : messages
  return JSON.stringify(sortRawSessionMessages(selected).map(rawMessageRecord), null, 2)
}

export function toggleRawMessageSelection(selected: ReadonlySet<string>, messageID: string): Set<string> {
  const next = new Set(selected)
  if (next.has(messageID)) next.delete(messageID)
  else next.add(messageID)
  return next
}

export function selectAllRawMessages(messages: RawSessionMessage[]): Set<string> {
  return new Set(messages.map((message) => message.info.id))
}

export function summarizeRawMessageSelection(messages: RawSessionMessage[], selectedIds: ReadonlySet<string>) {
  const ids = new Set(messages.map((message) => message.info.id).filter((id) => selectedIds.has(id)))
  return {
    ids,
    count: ids.size,
    all: messages.length > 0 && ids.size === messages.length,
    partial: ids.size > 0 && ids.size < messages.length,
  }
}

export function reconcileRawMessageState(input: {
  messages: RawSessionMessage[]
  selectedIds: ReadonlySet<string>
  previewId: string | undefined
}) {
  const selection = summarizeRawMessageSelection(input.messages, input.selectedIds)
  const loadedIds = new Set(input.messages.map((message) => message.info.id))
  return {
    selectedIds: selection.ids,
    previewId: input.previewId && loadedIds.has(input.previewId) ? input.previewId : undefined,
  }
}

export function isRawMessageHistoryComplete(input: {
  previousLimit: number
  previousLoaded: number
  previousComplete: boolean
  requestedLimit: number
  loaded: number
}) {
  if (input.loaded < input.requestedLimit) return true
  if (input.requestedLimit > input.previousLimit && input.loaded <= input.previousLoaded) return true
  if (input.previousComplete && input.requestedLimit <= input.previousLimit && input.loaded <= input.previousLoaded)
    return true
  return false
}

export function nextRawMessagesLimit(limit: number) {
  return limit + 100
}
