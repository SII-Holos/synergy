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
 * Semantics are intentionally identical to the legacy per-turn collectors in
 * `session-turn.tsx`:
 * - `roots` matches `rootMessages().filter(visible !== false)`.
 * - `turnMessagesFor(anchor)` matches
 *   `collectMessagesForTurnLifecycle(messages, anchor.id)`: for a root anchor
 *   it returns every later message with the same rootID; for a non-root user
 *   anchor (steer / guided) it returns the members after that anchor.
 * - `compactionParentIDs` matches `collectCompactionParentIDs(messages)`.
 * - `lastUserMessageID` matches the legacy tail scan (last user message).
 */

export type TurnDisplayMessage = AssistantMessage | UserMessage

export type SessionTurnProjection = {
  roots: UserMessage[]
  byRoot: Map<string, TurnDisplayMessage[]>
  memberIndex: Map<string, number>
  compactionParentIDs: Set<string>
  lastUserMessageID: string | undefined
  turnMessagesFor(anchor: UserMessage): TurnDisplayMessage[]
}

export function isProjectedCompactionAttempt(message: AssistantMessage): boolean {
  if (message.mode !== "compaction" && message.agent !== "compaction") return false
  const attempt = message.metadata?.compactionAttempt as { state?: unknown } | undefined
  return attempt?.state === "running" || attempt?.state === "failed"
}

export function keepForTurnDisplay(message: TurnDisplayMessage): boolean {
  if (message.visible !== false) return true
  return message.role === "assistant" && isProjectedCompactionAttempt(message)
}

export function buildSessionTurnProjection(messages: readonly MessageType[]): SessionTurnProjection {
  const roots: UserMessage[] = []
  const byRoot = new Map<string, TurnDisplayMessage[]>()
  const memberIndex = new Map<string, number>()
  const compactionParentIDs = new Set<string>()
  let lastUserMessageID: string | undefined

  for (const message of messages) {
    if (message.role === "user") {
      const user = message as UserMessage
      lastUserMessageID = user.id

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

  const turnMessagesFor = (anchor: UserMessage): TurnDisplayMessage[] => {
    const rootID = anchor.rootID ?? anchor.id
    const members = byRoot.get(rootID)
    if (!members) return []
    if (anchor.isRoot === true) return members
    const index = memberIndex.get(anchor.id)
    if (index === undefined) return []
    return members.slice(index + 1)
  }

  return { roots, byRoot, memberIndex, compactionParentIDs, lastUserMessageID, turnMessagesFor }
}
