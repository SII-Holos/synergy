import type { Part, SessionInboxItem } from "@ericsanchezok/synergy-sdk"
import { extractPromptDraft, type PromptDraftSnapshot } from "@/utils/prompt"

export function pendingMessageText(item: SessionInboxItem): string {
  return (item.message?.parts ?? [])
    .filter(
      (part) => part.type === "text" && (part.origin === "user" || (part.origin === undefined && !part.synthetic)),
    )
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n\n")
}

export async function takePendingMessage(input: {
  removed(): Promise<SessionInboxItem | undefined>
  remove(): Promise<void>
  restore(): Promise<void>
  eligible(): boolean
  unavailable(): Error
}): Promise<SessionInboxItem> {
  const existing = await input.removed()
  if (existing) return existing
  if (!input.eligible()) throw input.unavailable()
  try {
    await input.remove()
  } catch (error) {
    const confirmed = await input.removed().catch(() => undefined)
    if (confirmed) return confirmed
    throw error
  }
  let confirmed: SessionInboxItem | undefined
  try {
    confirmed = await input.removed()
  } catch (error) {
    await input.restore()
    throw error
  }
  if (!confirmed) throw input.unavailable()
  return confirmed
}

export async function editPendingMessage(input: {
  item: SessionInboxItem
  directory?: string
  eligible(): boolean
  draft: {
    ready(): boolean
    dirty(): boolean
    revision(): number
    context: { items(): readonly unknown[] }
    restoreIfUnchanged(revision: number, snapshot: PromptDraftSnapshot): boolean
  }
  take(): Promise<SessionInboxItem>
  requeue(): Promise<void>
}): Promise<"edited" | "draft-not-empty" | "draft-changed" | "unavailable"> {
  if (!input.eligible() || !input.item.message || !input.draft.ready()) return "unavailable"
  if (input.draft.dirty() || input.draft.context.items().length) return "draft-not-empty"
  const revision = input.draft.revision()
  const item = await input.take()
  if (!input.eligible() || !input.draft.ready()) {
    await input.requeue()
    return "unavailable"
  }
  try {
    if (!item.message) throw new Error("The queued message has no editable input")
    const parts: Part[] = [
      {
        id: `${item.id}-text`,
        messageID: item.messageID,
        sessionID: item.sessionID,
        type: "text",
        text: pendingMessageText(item),
      },
      ...item.message.parts
        .filter((part) => part.type === "attachment")
        .map((part, index) => ({
          ...part,
          id: part.id ?? `${item.id}-attachment-${index}`,
          messageID: item.messageID,
          sessionID: item.sessionID,
        })),
    ]
    const snapshot = extractPromptDraft({
      message: { metadata: item.message.metadata },
      parts,
      directory: input.directory,
    })
    if (input.draft.restoreIfUnchanged(revision, snapshot)) return "edited"
  } catch (error) {
    await input.requeue()
    throw error
  }
  await input.requeue()
  return "draft-changed"
}

export type PendingTimelineItemView = {
  frozen: boolean
  primaryAction: "guide" | "queue" | undefined
  canWithdraw: boolean
}

export function selectPendingTimelineItems(
  items: readonly SessionInboxItem[] | undefined,
  messages: ReadonlyArray<{ id: string }>,
): SessionInboxItem[] {
  if (!items?.length) return []
  const materializedMessageIDs = new Set(messages.map((message) => message.id))
  return items
    .filter((item) => item.mode === "task" || item.mode === "steer")
    .filter((item) => item.message?.visible !== false)
    .filter((item) => (item.message?.origin?.type ?? item.source?.type) === "user")
    .filter((item) => !materializedMessageIDs.has(item.messageID))
}

export function pendingTimelineItemView(
  mode: SessionInboxItem["mode"],
  rollbackActive: boolean,
  options?: { hasCanonicalRoot?: boolean; status?: SessionInboxItem["status"] },
): PendingTimelineItemView {
  const firstTaskLocked = mode === "task" && options?.hasCanonicalRoot === false && options.status !== "failed"
  if (rollbackActive || firstTaskLocked || (mode !== "task" && mode !== "steer")) {
    return {
      frozen: rollbackActive || firstTaskLocked,
      primaryAction: undefined,
      canWithdraw: false,
    }
  }

  return {
    frozen: false,
    primaryAction: options?.status === "failed" ? undefined : mode === "steer" ? "queue" : "guide",
    canWithdraw: true,
  }
}
