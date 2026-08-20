import type { AssistantMessage, Message as MessageType, UserMessage } from "@ericsanchezok/synergy-sdk/client"

/**
 * Single-pass turn projection over a session's message window.
 *
 * Every rendered SessionTurn used to derive its own turn members by scanning
 * the whole window (`collectMessagesForTurnLifecycle`), so any new message
 * invalidated every rendered turn's memos — O(turns × window). This module
 * builds the same per-root membership once per window change in O(window) and
 * lets each turn consume its own slice.
 *
 * Input note: the projection is built from the session page's `messages()`
 * memo, which applies `messagesHiddenByRollback` (`session-message-order.ts`).
 * During an active rollback state the timeline is trimmed at the cut point, so
 * turn members align with the trimmed timeline — post-cut messages no longer
 * surface in earlier turns. The legacy per-turn collectors in `session-turn.tsx`
 * scanned the raw store and could still see those messages; this projection is
 * therefore a consistency *improvement* over the legacy behavior, and the
 * equivalence tests cover unfiltered arrays.
 *
 * Semantics for an unfiltered window are intentionally identical to the legacy
 * per-turn collectors in `session-turn.tsx`:
 * - `roots` matches `rootMessages().filter(visible !== false)`.
 * - `turnMessagesFor(anchor)` matches
 *   `collectMessagesForTurnLifecycle(messages, anchor.id)`: for a root anchor
 *   it returns every later message with the same rootID; for a non-root user
 *   anchor (steer / guided) it returns the members after that anchor.
 * - `compactionParentIDs` matches `collectCompactionParentIDs(messages)`.
 */

export type TurnDisplayMessage = AssistantMessage | UserMessage

export type SessionTurnProjection = {
  roots: UserMessage[]
  byRoot: Map<string, TurnDisplayMessage[]>
  memberIndex: Map<string, number>
  compactionParentIDs: Set<string>
  turnMessagesFor(anchor: UserMessage | undefined): TurnDisplayMessage[]
}

export function buildSessionTurnProjection(messages: readonly MessageType[]): SessionTurnProjection {
  const roots: UserMessage[] = []
  const byRoot = new Map<string, TurnDisplayMessage[]>()
  const memberIndex = new Map<string, number>()
  const compactionParentIDs = new Set<string>()

  for (const message of messages) {
    if (message.role === "user") {
      const user = message as UserMessage

      const metadata = user.metadata
      const parentID = metadata?.compactionParentID
      if (metadata?.compactionBoundary === true && typeof parentID === "string" && parentID) {
        compactionParentIDs.add(parentID)
      }

      if (user.isRoot === true) {
        if (user.visible !== false) roots.push(user)
        const rootID = user.rootID ?? user.id
        if (!byRoot.has(rootID)) byRoot.set(rootID, [])
        continue
      }

      // Non-root user (steer / guided / system-injected): belongs to its root's
      // turn. Entries are only created when the root is encountered, so a
      // message preceding its root (anomalous data) is skipped — mirroring the
      // legacy collector's root-relative scan.
      const rootID = user.rootID
      const members = rootID ? byRoot.get(rootID) : undefined
      if (members) {
        memberIndex.set(user.id, members.length)
        members.push(user)
      }
      continue
    }

    const rootID = message.rootID
    const members = rootID ? byRoot.get(rootID) : undefined
    if (members) members.push(message as TurnDisplayMessage)
  }

  const turnMessagesFor = (anchor: UserMessage | undefined): TurnDisplayMessage[] => {
    if (!anchor) return []
    const rootID = anchor.rootID ?? anchor.id
    const members = byRoot.get(rootID)
    if (!members) return []
    if (anchor.isRoot === true) return members
    const index = memberIndex.get(anchor.id)
    if (index === undefined) return []
    return members.slice(index + 1)
  }

  return { roots, byRoot, memberIndex, compactionParentIDs, turnMessagesFor }
}
