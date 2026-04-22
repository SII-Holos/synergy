import { Identifier } from "@/id/id"

type ScopeID = Identifier.ScopeID
type SessionID = Identifier.SessionID
type MessageID = Identifier.MessageID
type PartID = Identifier.PartID

export namespace StoragePath {
  const endpointSessionStorageKey = (endpointKey: string) => encodeURIComponent(endpointKey)

  export const metaVersion = () => ["meta", "version"]
  export const metaMigrationLog = () => ["meta", "migration", "log"]

  export const scopeRoot = () => ["projects"]
  export const scope = (scopeID: ScopeID) => ["projects", scopeID as string]

  export const sessionIndexRoot = () => ["session_index"]
  export const sessionIndex = (sessionID: SessionID) => ["session_index", sessionID as string]

  export const endpointSessionRoot = (endpointKey: string) => [
    "endpoint_session",
    endpointSessionStorageKey(endpointKey),
  ]
  export const endpointSession = (endpointKey: string, sessionID: SessionID) => [
    "endpoint_session",
    endpointSessionStorageKey(endpointKey),
    sessionID as string,
  ]

  export const sessionsRoot = (scopeID: ScopeID) => ["sessions", scopeID as string]

  export const sessionRoot = (scopeID: ScopeID, sessionID: SessionID) => [
    "sessions",
    scopeID as string,
    sessionID as string,
  ]
  export const sessionInfo = (scopeID: ScopeID, sessionID: SessionID) => [...sessionRoot(scopeID, sessionID), "info"]
  export const sessionSummary = (scopeID: ScopeID, sessionID: SessionID) => [
    ...sessionRoot(scopeID, sessionID),
    "summary",
  ]
  export const sessionTodo = (scopeID: ScopeID, sessionID: SessionID) => [...sessionRoot(scopeID, sessionID), "todo"]
  export const sessionDag = (scopeID: ScopeID, sessionID: SessionID) => [...sessionRoot(scopeID, sessionID), "dag"]
  export const sessionMessagesRoot = (scopeID: ScopeID, sessionID: SessionID) => [
    ...sessionRoot(scopeID, sessionID),
    "messages",
  ]

  export const messageInfo = (scopeID: ScopeID, sessionID: SessionID, messageID: MessageID) => [
    ...sessionMessagesRoot(scopeID, sessionID),
    messageID as string,
    "info",
  ]

  export const messageParts = (scopeID: ScopeID, sessionID: SessionID, messageID: MessageID) => [
    ...sessionMessagesRoot(scopeID, sessionID),
    messageID as string,
    "parts",
  ]

  export const messagePart = (scopeID: ScopeID, sessionID: SessionID, messageID: MessageID, partID: PartID) => [
    ...messageParts(scopeID, sessionID, messageID),
    partID as string,
  ]

  export const permission = (scopeID: ScopeID) => ["permissions", scopeID as string]

  export const share = (shareID: string) => ["shares", shareID]

  export const agendaItemsRoot = (scopeID: ScopeID) => ["agenda", "items", scopeID as string]
  export const agendaItem = (scopeID: ScopeID, itemID: string) => ["agenda", "items", scopeID as string, itemID]
  export const agendaRunsRoot = (scopeID: ScopeID, itemID: string) => ["agenda", "runs", scopeID as string, itemID]
  export const agendaRun = (scopeID: ScopeID, itemID: string, runID: string) => [
    "agenda",
    "runs",
    scopeID as string,
    itemID,
    runID,
  ]

  export const agendaSessionsRoot = (itemID: string) => ["agenda", "sessions", itemID]
  export const agendaSession = (itemID: string, sessionID: string) => ["agenda", "sessions", itemID, sessionID]

  export const notesRoot = (scopeID: ScopeID) => ["notes", scopeID as string]
  export const note = (scopeID: ScopeID, noteID: string) => ["notes", scopeID as string, noteID]

  export const holosProfile = () => ["holos", "profile"]

  export const holosContactsRoot = () => ["holos", "contacts"]
  export const holosContact = (id: string) => ["holos", "contacts", id]

  export const holosFriendRequestsRoot = () => ["holos", "friend_requests"]
  export const holosFriendRequest = (id: string) => ["holos", "friend_requests", id]

  export const holosMessageQueueRoot = () => ["holos", "message_queue"]
  export const holosMessageQueueItem = (id: string) => ["holos", "message_queue", id]

  export const holosFriendReplyRoot = (sessionID: string) => ["holos", "friend_reply", sessionID]
  export const holosFriendReply = (sessionID: string, triggerMessageID: string) => [
    "holos",
    "friend_reply",
    sessionID,
    triggerMessageID,
  ]
  export const holosAutoTurnCount = (contactId: string) => ["holos", "auto_turns", contactId]

  // Stats
  export const statsRoot = () => ["stats"]
  export const statsWatermark = () => ["stats", "watermark"]
  export const statsSnapshot = () => ["stats", "snapshot"]
  /** Per-session digest: stats/digests/{sessionID} */
  export const statsDigestsRoot = () => ["stats", "digests"]
  export const statsDigest = (sessionID: SessionID) => ["stats", "digests", sessionID as string]
  /** Daily buckets: stats/daily/{YYYY-MM-DD} */
  export const statsDailyRoot = () => ["stats", "daily"]
  export const statsDaily = (day: string) => ["stats", "daily", day]
}
