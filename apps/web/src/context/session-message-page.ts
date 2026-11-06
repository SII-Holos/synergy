import {
  applyLatestPage,
  insertInOrder,
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

export type AppliedMessagePagePlan<M extends MessageRef, P extends PartRef> = MessageWindowResult<M> & {
  outcome: "applied"
  metadata: MessageWindowMetadata
  parts: Record<string, P[]>
  latestContextMessage: M | null | undefined
}

export type PreservedHistoryMessagePagePlan<M extends MessageRef> = {
  outcome: "preserved-history"
  latestContextMessage: M | null | undefined
}

export type MessagePageApplyPlan<M extends MessageRef, P extends PartRef> =
  AppliedMessagePagePlan<M, P> | PreservedHistoryMessagePagePlan<M>

type MessagePageApplyInput<M extends MessageRef, P extends PartRef> = {
  page: MessagePage<M, P>
  current?: MessageWindowState<M>
  cap?: number
  replace?: boolean
}

function retainOptimisticMessage<M extends MessageRef>(
  window: MessageWindowState<M>,
  message: M,
): MessageWindowState<M> {
  const messages = insertInOrder(
    window.messages.filter((item) => item.id !== message.id),
    message,
  )
  return { ...window, messages }
}

export function planMessagePageApply<M extends MessageRef & SessionContextUsageMessage, P extends PartRef>(
  input: MessagePageApplyInput<M, P> & { mode: "latest" | "history" },
): AppliedMessagePagePlan<M, P>
export function planMessagePageApply<M extends MessageRef & SessionContextUsageMessage, P extends PartRef>(
  input: MessagePageApplyInput<M, P>,
): MessagePageApplyPlan<M, P>
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
  // Named latest/history applies own the window. An omitted mode is a shared
  // latest page (Kanban, prefetch) and must not replace history.
  if (input.mode === undefined && current.mode === "history") {
    return {
      outcome: "preserved-history",
      latestContextMessage: findLatestSessionContextUsageMessage(items.map((item) => item.info)),
    }
  }
  const pageInfos = [...referencedRoots, ...items].map((item) => item.info)
  let result =
    input.mode === "history"
      ? prependOlderPage(
          input.replace ? { ...current, messages: [], tailMissingLatest: true } : current,
          pageInfos,
          input.cap,
        )
      : applyLatestPage(
          items.map((item) => item.info),
          referencedRoots.map((item) => item.info),
          input.cap,
        )
  const pageIDs = new Set(pageInfos.map((info) => info.id))
  const droppedIds = new Set(result.droppedIds)
  if (input.mode === "history" && input.replace) {
    for (const message of current.messages) {
      if (pageIDs.has(message.id) || !isOptimisticMessagePending(message)) continue
      result = { window: retainOptimisticMessage(result.window, message), droppedIds: result.droppedIds }
    }
  }
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
          [...current.messages, ...referencedRoots.map((item) => item.info), ...items.map((item) => item.info)],
          result.window.messages,
        )
      : result.window.pendingLatestIds
  const window: MessageWindowState<M> = {
    ...result.window,
    pendingLatest: pendingLatestIds.length > 0,
    pendingLatestIds,
  }

  return {
    outcome: "applied",
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
