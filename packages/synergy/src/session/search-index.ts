import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Lock } from "../util/lock"
import { Log } from "../util/log"

/**
 * Versioned per-session search index (session-search P2). The index is an
 * optimization: a query reads one compact record per clean session instead of
 * streaming every message file. Correctness never depends on it — dirty,
 * missing, or stale records fall back to the existing message scan path and
 * are rebuilt write-through.
 *
 * Write path: message/session mutations mark the owning session dirty via a
 * tiny marker file; the next search rebuilds lazily. Part streaming deltas
 * (updatePartDelta) deliberately do NOT mark dirty — text/tool parts settle
 * into a message before Session.updateMessage fires, which is the single hook.
 *
 * Concurrency: markDirty (message writers) and commit/rebuild (search queries)
 * serialize on a per-session lock so a marker can never be cleared after a
 * newer write — the last writer wins and any interleaved rebuild observes it.
 */
export namespace SessionSearchIndex {
  const log = Log.create({ service: "session.search-index" })

  export const VERSION = 1
  export const TOKENIZER_VERSION = 1
  const TOOL_TEXT_CAP = 16 * 1024

  export interface IndexedMessage {
    id: string
    role: string
    created: number
    /** Full non-system text-part content (unbounded; text semantics never regress). */
    text?: string
    /** Tool-call inputs plus completed/error output, excerpt-capped. */
    tool?: string
    toolTruncated?: boolean
    /** Attachment filenames/URLs. */
    attachment?: string
  }

  export interface SearchIndexRecord {
    version: number
    tokenizerVersion: number
    scopeID: string
    sessionID: string
    updatedAt: number
    messages: IndexedMessage[]
  }

  export interface DirtyMarker {
    dirtyAt: number
  }

  function sessionLockKey(scopeID: string, sessionID: string): string {
    return `session-search-index:${scopeID}:${sessionID}`
  }

  /**
   * Lightweight Unicode tokenizer shared by relevance scoring and index
   * consumers. ASCII identifiers/numbers become single tokens; CJK runs become
   * overlapping bigrams (single characters stay single tokens) so mixed zh/en
   * content participates in lexical scoring.
   */
  export function tokenize(text: string): string[] {
    const out: string[] = []
    const re = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g
    for (const match of text.matchAll(re)) {
      const raw = match[0]
      if (/^[A-Za-z0-9_]+$/.test(raw)) {
        out.push(raw.toLowerCase())
        continue
      }
      if (raw.length === 1) {
        out.push(raw)
        continue
      }
      for (let i = 0; i + 1 < raw.length; i++) out.push(raw.slice(i, i + 2))
    }
    return out
  }

  /** Number of distinct pattern tokens present in text (deterministic, >= 0). */
  export function overlapScore(text: string, patternTokens: string[]): number {
    if (patternTokens.length === 0) return 0
    const present = new Set(tokenize(text))
    let score = 0
    for (const token of patternTokens) {
      if (present.has(token)) score++
    }
    return score
  }

  /** Full non-system text-part content of a message (default text semantics). */
  function textPartContent(parts: MessageV2.Part[]): string {
    return MessageV2.extractText(parts)
  }

  /** Tool-call inputs plus completed/error output, capped per message. */
  function toolPartContent(parts: MessageV2.Part[]): { tool: string; truncated: boolean } | undefined {
    const chunks: string[] = []
    let truncated = false
    for (const part of parts) {
      if (part.type !== "tool") continue
      const state = part.state
      if (state.input && Object.keys(state.input).length > 0) chunks.push(JSON.stringify(state.input))
      if (state.status === "completed" && state.output) chunks.push(state.output)
      else if (state.status === "error" && "error" in state && state.error) chunks.push(String(state.error))
    }
    if (chunks.length === 0) return undefined
    const joined = chunks.join("\n")
    if (joined.length <= TOOL_TEXT_CAP) return { tool: joined, truncated: false }
    return { tool: joined.slice(0, TOOL_TEXT_CAP), truncated: true }
  }

  function attachmentPartContent(parts: MessageV2.Part[]): string | undefined {
    const chunks: string[] = []
    for (const part of parts) {
      if (part.type !== "attachment") continue
      if (part.filename) chunks.push(part.filename)
      if (part.url) chunks.push(part.url)
    }
    return chunks.length > 0 ? chunks.join("\n") : undefined
  }

  /** Build the indexable entry for one message from its hydrated parts. */
  export function messageEntryFromParts(
    info: Pick<MessageV2.Info, "id" | "role" | "time">,
    parts: MessageV2.Part[],
  ): IndexedMessage {
    const entry: IndexedMessage = { id: info.id, role: info.role, created: info.time.created }
    const text = textPartContent(parts)
    if (text) entry.text = text
    const tool = toolPartContent(parts)
    if (tool) {
      entry.tool = tool.tool
      if (tool.truncated) entry.toolTruncated = true
    }
    const attachment = attachmentPartContent(parts)
    if (attachment) entry.attachment = attachment
    return entry
  }

  /** Searchable text for a message's parts under a content mode (scan-path parity). */
  export function partsSearchText(parts: MessageV2.Part[], content: "text" | "tool" | "all"): string {
    const chunks: string[] = []
    const text = textPartContent(parts)
    if (text) chunks.push(text)
    if (content === "tool" || content === "all") {
      const tool = toolPartContent(parts)
      if (tool) chunks.push(tool.tool)
    }
    if (content === "all") {
      const attachment = attachmentPartContent(parts)
      if (attachment) chunks.push(attachment)
    }
    return chunks.join("\n").trim()
  }

  /** Searchable text for an indexed message under a content mode. */
  export function recordMessageText(msg: IndexedMessage, content: "text" | "tool" | "all"): string {
    const chunks: string[] = []
    if (msg.text) chunks.push(msg.text)
    if ((content === "tool" || content === "all") && msg.tool) chunks.push(msg.tool)
    if (content === "all" && msg.attachment) chunks.push(msg.attachment)
    return chunks.join("\n").trim()
  }

  function recordKey(scopeID: Identifier.ScopeID, sessionID: Identifier.SessionID): string[] {
    return StoragePath.sessionSearchIndex(scopeID, sessionID)
  }

  function dirtyKey(scopeID: Identifier.ScopeID, sessionID: Identifier.SessionID): string[] {
    return StoragePath.sessionSearchDirty(scopeID, sessionID)
  }

  export async function readRecord(
    scopeID: Identifier.ScopeID,
    sessionID: Identifier.SessionID,
  ): Promise<SearchIndexRecord | undefined> {
    return Storage.read<SearchIndexRecord>(recordKey(scopeID, sessionID), { silentNotFound: true }).catch(
      () => undefined,
    )
  }

  export async function isDirty(scopeID: Identifier.ScopeID, sessionID: Identifier.SessionID): Promise<boolean> {
    const marker = await Storage.read<DirtyMarker>(dirtyKey(scopeID, sessionID), { silentNotFound: true }).catch(
      () => undefined,
    )
    return marker !== undefined
  }

  /** Record that the session's searchable content changed. Never throws. */
  export async function markDirty(scopeID: Identifier.ScopeID, sessionID: Identifier.SessionID): Promise<void> {
    try {
      using _ = await Lock.write(sessionLockKey(scopeID, sessionID))
      await Storage.write(dirtyKey(scopeID, sessionID), { dirtyAt: Date.now() } satisfies DirtyMarker, {
        compact: true,
      })
    } catch (error) {
      log.warn("failed to mark session search dirty", { scopeID, sessionID, error: String(error) })
    }
  }

  async function clearDirtyLocked(scopeID: Identifier.ScopeID, sessionID: Identifier.SessionID): Promise<void> {
    await Storage.remove(dirtyKey(scopeID, sessionID))
  }

  /**
   * Persist a rebuilt record and clear the dirty marker — but only when no
   * write landed after the rebuild started. `sinceMs` is the timestamp the
   * caller began collecting; a marker newer than it means a mutation raced in
   * during the rebuild, so the marker must survive to trigger another pass.
   * Never throws.
   */
  export async function commitRebuild(
    scopeID: Identifier.ScopeID,
    sessionID: Identifier.SessionID,
    messages: IndexedMessage[],
    opts?: { sinceMs?: number },
  ): Promise<void> {
    try {
      using _ = await Lock.write(sessionLockKey(scopeID, sessionID))
      const record: SearchIndexRecord = {
        version: VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
        scopeID,
        sessionID,
        updatedAt: Date.now(),
        messages,
      }
      await Storage.write(recordKey(scopeID, sessionID), record, { compact: true })
      if (opts?.sinceMs === undefined) {
        await clearDirtyLocked(scopeID, sessionID)
        return
      }
      const marker = await Storage.read<DirtyMarker>(dirtyKey(scopeID, sessionID), {
        silentNotFound: true,
      }).catch(() => undefined)
      if (!marker || marker.dirtyAt <= opts.sinceMs) await clearDirtyLocked(scopeID, sessionID)
    } catch (error) {
      log.warn("failed to commit session search index", { scopeID, sessionID, error: String(error) })
    }
  }

  /** Delete a session's index record and dirty marker. Never throws. */
  export async function removeRecords(scopeID: Identifier.ScopeID, sessionID: Identifier.SessionID): Promise<void> {
    try {
      using _ = await Lock.write(sessionLockKey(scopeID, sessionID))
      await Storage.remove(recordKey(scopeID, sessionID))
      await Storage.remove(dirtyKey(scopeID, sessionID))
    } catch (error) {
      log.warn("failed to remove session search index", { scopeID, sessionID, error: String(error) })
    }
  }

  /**
   * Rebuild a session's index record from its persisted messages and parts via
   * the canonical MessageV2 read path, then clear its dirty marker (guarded by
   * the rebuild start time). Returns the fresh record.
   */
  export async function rebuildSession(
    scopeID: Identifier.ScopeID,
    sessionID: Identifier.SessionID,
  ): Promise<SearchIndexRecord> {
    const startedAt = Date.now()
    const infos = await MessageV2.readInfoList({ scopeID, sessionID })
    const messages: IndexedMessage[] = []
    for (const info of infos) {
      const parts = await MessageV2.parts({ scopeID, sessionID, messageID: info.id })
      messages.push(messageEntryFromParts(info, parts))
    }
    await commitRebuild(scopeID, sessionID, messages, { sinceMs: startedAt })
    log.debug("rebuilt session search index", { scopeID, sessionID, messages: messages.length })
    return {
      version: VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      scopeID,
      sessionID,
      updatedAt: Date.now(),
      messages,
    }
  }
}
