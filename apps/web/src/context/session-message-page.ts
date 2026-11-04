import {
  applyLatestPage,
  prependOlderPage,
  reconcileMessage,
  retainPendingLatestIds,
  type MessageRef,
  type MessageWindowMetadata,
  type MessageWindowResult,
  type MessageWindowState,
} from "./session-message-window"
import { findLatestSessionContextUsageMessage, type SessionContextUsageMessage } from "./session-context-usage"
import { isOptimisticMessagePending } from "./session-optimistic-message"

type PartRef = { id: string }
type MessagePageItem<M extends MessageRef, P extends PartRef> = {
  info: M
  parts?: P[]
  order?: string
  version?: string
}

type MessagePage<M extends MessageRef, P extends PartRef> = {
  items: MessagePageItem<M, P>[]
  referencedRoots: MessagePageItem<M, P>[]
  nextCursor: string | null
  hasMore: boolean
  total: number
}

export type MessagePageApplyPlan<M extends MessageRef, P extends PartRef> = MessageWindowResult<M> & {
  metadata: MessageWindowMetadata
  parts: Record<string, P[]>
  latestContextMessage: M | null | undefined
}

export function planMessagePageApply<M extends MessageRef & SessionContextUsageMessage, P extends PartRef>(input: {
  page: MessagePage<M, P>
  current?: MessageWindowState<M>
  mode?: "latest" | "history"
  cap?: number
  replace?: boolean
}): MessagePageApplyPlan<M, P> {
  const items = input.page.items.filter((item) => !!item?.info?.id)
  const referencedRoots = input.page.referencedRoots.filter((item) => !!item?.info?.id)
  const current = input.current ?? {
    messages: [],
    mode: "latest",
    pendingLatest: false,
    pendingLatestIds: [],
    tailMissingLatest: false,
  }
  let result =
    input.mode === "history"
      ? prependOlderPage(
          input.replace ? { ...current, messages: [], tailMissingLatest: true } : current,
          [...referencedRoots, ...items].map((item) => item.info),
          input.cap,
        )
      : applyLatestPage(
          items.map((item) => item.info),
          referencedRoots.map((item) => item.info),
          input.cap,
        )
  const pageIDs = new Set([...referencedRoots, ...items].map((item) => item.info.id))
  const droppedIds = new Set(result.droppedIds)
  if (input.mode !== "history") {
    for (const message of current.messages) {
      if (pageIDs.has(message.id) || !isOptimisticMessagePending(message)) continue
      const pending = reconcileMessage(result.window, message, input.cap)
      result = pending
      for (const messageID of pending.droppedIds) droppedIds.add(messageID)
    }
  }
  const keepIds = new Set(result.window.messages.map((message) => message.id))
  const preservedPendingCount = current.messages.filter(
    (message) => !pageIDs.has(message.id) && isOptimisticMessagePending(message) && keepIds.has(message.id),
  ).length
  for (const message of current.messages) {
    if (!keepIds.has(message.id)) droppedIds.add(message.id)
  }

  const parts: Record<string, P[]> = {}
  for (const item of [...referencedRoots, ...items]) {
    if (!keepIds.has(item.info.id)) continue
    if (!item.parts) continue
    parts[item.info.id] = item.parts
      .filter((part) => !!part?.id)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  const pendingLatestIds =
    input.mode === "history"
      ? retainPendingLatestIds(
          result.window.pendingLatestIds,
          [
            ...current.messages,
            ...referencedRoots.map((item) => item.info),
            ...items.map((item) => item.info),
          ],
          result.window.messages,
        )
      : result.window.pendingLatestIds
  const window: MessageWindowState<M> = {
    ...result.window,
    pendingLatest: pendingLatestIds.length > 0,
    pendingLatestIds,
  }

  return {
    window,
    droppedIds: Array.from(droppedIds),
    metadata: {
      nextCursor: input.page.nextCursor,
      hasMore: input.page.hasMore,
      total:
        input.mode === "history"
          ? Math.max(0, input.page.total - pendingLatestIds.length)
          : input.page.total + preservedPendingCount,
      mode: window.mode,
      pendingLatest: window.pendingLatest,
      pendingLatestIds,
      tailMissingLatest: window.tailMissingLatest,
    },
    parts,
    latestContextMessage:
      input.mode === "history" ? undefined : findLatestSessionContextUsageMessage(items.map((item) => item.info)),
  }
}
