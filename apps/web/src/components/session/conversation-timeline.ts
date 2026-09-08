import type { Message } from "@ericsanchezok/synergy-sdk"

export type ConversationTimelineSnapshot = {
  keys: string[]
  map: Map<string, Message>
}

/**
 * Builds id-keyed timeline entries for the conversation list.
 *
 * Solid's `For` keys rows by item identity, so replacing message objects
 * (window reload, reconnect replay, rollback copies, `message.updated`
 * reconcile) destroys and recreates every row whose reference changed. Each
 * abandoned row keeps its Solid owner graph alive even after its DOM is
 * detached — heap snapshots of the renderer showed 5–10 detached
 * SessionTurn trees per message accumulating over a session (V8 OOM after
 * ~33h). Keying rows by the stable message id keeps rows mounted across
 * object replacement; the per-row getter reads the current snapshot so
 * updated message data still flows through.
 */
export function buildConversationTimelineSnapshot(messages: readonly Message[]): ConversationTimelineSnapshot {
  const keys: string[] = []
  const map = new Map<string, Message>()
  for (const message of messages) {
    keys.push(message.id)
    map.set(message.id, message)
  }
  return { keys, map }
}
