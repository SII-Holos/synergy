import { planMessagePageApply, type MessagePageApplyPlan } from "../session-message-page"
import type { MessageRef } from "../session-message-window"
import type { SessionContextUsageMessage } from "../session-context-usage"
import type { SessionPartSnapshotAction } from "../session-part-snapshot-freshness"

type PartRef = { id: string }

type PrefetchPageItem<M, P extends PartRef> = { info: M; parts: P[] }

type PrefetchPage<M, P extends PartRef> = {
  items: PrefetchPageItem<M, P>[]
  referencedRoots: PrefetchPageItem<M, P>[]
  nextCursor: string | null
  hasMore: boolean
  total: number
}

export type PrefetchApplyPlan<M extends MessageRef & SessionContextUsageMessage, P extends PartRef> =
  | { status: "retry" }
  | {
      status: "applied"
      window: { messages: M[] }
      metadata: MessagePageApplyPlan<M, P>["metadata"]
      parts: Record<string, P[]>
      latestContextMessage: M | null | undefined
    }

/**
 * Plan a background-prefetch message-page apply under the same per-message
 * part-snapshot freshness gate the foreground loader uses: a message whose
 * local part bucket was mutated after the request was captured keeps its
 * live bucket (`preserve`), and any message that requires a newer snapshot
 * (`retry`) voids the opportunistic prefetch entirely — the next foreground
 * load owns convergence. Without this gate a prefetch response captured
 * before a streaming mutation overwrites the accumulated part text with the
 * older snapshot, visibly shrinking a streaming segment.
 */
export function planPrefetchApply<M extends MessageRef & SessionContextUsageMessage, P extends PartRef>(input: {
  page: PrefetchPage<M, P>
  partSnapshotAction: (messageID: string) => SessionPartSnapshotAction
}): PrefetchApplyPlan<M, P> {
  const plan = planMessagePageApply<M, P>({ page: input.page })
  const parts: Record<string, P[]> = {}
  for (const [messageID, messageParts] of Object.entries(plan.parts)) {
    const action = input.partSnapshotAction(messageID)
    if (action === "retry") return { status: "retry" }
    if (action === "preserve") continue
    parts[messageID] = messageParts
  }
  return {
    status: "applied",
    window: { messages: plan.window.messages },
    metadata: plan.metadata,
    parts,
    latestContextMessage: plan.latestContextMessage,
  }
}
