import {
  applyLatestPage,
  prependOlderPage,
  type MessageRef,
  type MessageWindowMetadata,
  type MessageWindowResult,
  type MessageWindowState,
} from "./session-message-window"
import { findLatestSessionContextUsageMessage, type SessionContextUsageMessage } from "./session-context-usage"

type PartRef = { id: string }
type MessagePageItem<M extends MessageRef, P extends PartRef> = { info: M; parts: P[] }

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
}): MessagePageApplyPlan<M, P> {
  const items = input.page.items.filter((item) => !!item?.info?.id)
  const referencedRoots = input.page.referencedRoots.filter((item) => !!item?.info?.id)
  const current = input.current ?? { messages: [], mode: "latest", pendingLatest: false, pendingLatestIds: [] }
  const result =
    input.mode === "history"
      ? prependOlderPage(
          current,
          [...referencedRoots, ...items].map((item) => item.info),
          input.cap,
        )
      : applyLatestPage(
          items.map((item) => item.info),
          referencedRoots.map((item) => item.info),
          input.cap,
        )
  const keepIds = new Set(result.window.messages.map((message) => message.id))
  const droppedIds = new Set(result.droppedIds)
  for (const message of current.messages) {
    if (!keepIds.has(message.id)) droppedIds.add(message.id)
  }

  const parts: Record<string, P[]> = {}
  for (const item of [...referencedRoots, ...items]) {
    if (!keepIds.has(item.info.id)) continue
    parts[item.info.id] = item.parts
      .filter((part) => !!part?.id)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  return {
    window: result.window,
    droppedIds: Array.from(droppedIds),
    metadata: {
      nextCursor: input.page.nextCursor,
      hasMore: input.page.hasMore,
      total:
        input.mode === "history"
          ? Math.max(0, input.page.total - result.window.pendingLatestIds.length)
          : input.page.total,
      mode: result.window.mode,
      pendingLatest: result.window.pendingLatest,
      pendingLatestIds: result.window.pendingLatestIds,
    },
    parts,
    latestContextMessage:
      input.mode === "history" ? undefined : findLatestSessionContextUsageMessage(items.map((item) => item.info)),
  }
}
