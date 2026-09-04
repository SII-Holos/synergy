import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionMemoryPressure } from "../session/memory-pressure"
import { SessionSearchIndex } from "../session/search-index"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import DESCRIPTION from "./session-search.txt"
import path from "node:path"

const parameters = z
  .object({
    pattern: z.string().describe("Regex pattern to search for in message content."),
    scope: z
      .enum(["all", "current", "project", "home"])
      .default("all")
      .describe(
        "Which scopes to search: 'all' (default, all project scopes plus the Home scope with channel sessions), " +
          "'project' (all project scopes, or one project selected with scopeID), 'home' (Home scope only), or " +
          "'current' (the current scope only).",
      ),
    scopeID: z
      .string()
      .trim()
      .min(1, "scopeID cannot be empty")
      .optional()
      .describe(
        "When scope is 'project', filter to one project using an id from scope_list. " +
          "Omit to search across all projects.",
      ),
    includeChildren: z
      .boolean()
      .default(false)
      .describe(
        "Include child sessions (delegated/Cortex/background sessions with a parentID). " +
          "Defaults to false — only top-level sessions are searched.",
      ),
    timeField: z
      .enum(["session", "message"])
      .default("session")
      .describe(
        "Which timestamp the since/before filters apply to: 'session' (default, session last-updated time, " +
          "matching session_list) or 'message' (each message's creation time).",
      ),
    content: z
      .enum(["text", "tool", "all"])
      .default("text")
      .describe(
        "Which message content to search: 'text' (default, message text parts only), 'tool' (text plus tool-call " +
          "inputs and completed tool outputs, excerpt-level), or 'all' (text, tool payloads, and attachment " +
          "filenames/URLs, excerpt-level).",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "Only include content updated/created on or after this date (ISO 8601, e.g. '2026-03-15' or " +
          "'2026-03-15T18:00:00'), interpreted by timeField.",
      ),
    before: z
      .string()
      .optional()
      .describe("Only include content before this date (ISO 8601), interpreted by timeField."),
    limit: z.coerce.number().default(20).describe("Maximum number of matches to return across all sessions."),
  })
  .refine((data) => !data.scopeID || data.scope === "project", {
    message: "scopeID can only be used with scope='project'",
    path: ["scopeID"],
  })

const MAX_MATCHES_PER_SESSION = 3
const MAX_TOTAL_MATCHES = 100
const SNIPPET_CHARS = 150
const MAX_PATTERN_CHARS = 2048

interface Match {
  messageID: string
  role: string
  time: number
  snippet: string
  score: number
}

interface SessionResult {
  session: Session.Info
  matches: Match[]
}

interface SessionCandidate {
  scopeID: Identifier.ScopeID
  sessionID: Identifier.SessionID
  updated: number
}

function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const half = Math.floor(SNIPPET_CHARS / 2)
  const start = Math.max(0, matchIndex - half)
  const end = Math.min(text.length, matchIndex + matchLength + half)
  const middle = text.slice(start, end).replace(/\n/g, " ")
  const prefix = start > 0 ? "..." : ""
  const suffix = end < text.length ? "..." : ""
  return prefix + middle + suffix
}

/** Distinct literal tokens from a user regex pattern, for deterministic scoring. */
function patternTokens(pattern: string): string[] {
  return Array.from(new Set(SessionSearchIndex.tokenize(pattern)))
}

/**
 * Conservative pre-check for catastrophic-backtracking patterns. JS regexes
 * cannot be preempted mid-execution, so suspicious shapes are rejected before
 * they run against arbitrarily long message text. This is a guard, not a
 * proof: genuinely novel ReDoS shapes may still pass.
 */
function isPotentiallyCatastrophicPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_CHARS) return true
  const stripped = pattern.replace(/\\./g, "x")
  // A quantified group whose body itself ends in a quantifier (e.g. (a+)+,
  // (a*)*, (?:a+)+, ((a+)+)) allows exponential backtracking. Unwrap nested
  // groups a bounded number of times to catch deeper nesting.
  let probe = stripped
  for (let depth = 0; depth < 8; depth++) {
    if (/\([^()]*[*+?][^()]*\)[*+?]/.test(probe)) return true
    probe = probe.replace(/\([^()]*\)/g, "G")
  }
  return false
}

async function resolveScopeSelection(
  scope: "all" | "current" | "project" | "home",
  scopeID?: string,
): Promise<{ ids: string[]; kinds: string[] }> {
  if (scope === "current") {
    const current = ScopeContext.current.scope
    return { ids: [current.id], kinds: [current.type === "home" ? "home" : "project"] }
  }
  if (scope === "home") return { ids: ["home"], kinds: ["home"] }
  if (scope === "project") {
    if (scopeID) return { ids: [scopeID], kinds: ["project"] }
    const projects = await Scope.list()
    return { ids: projects.map((project) => project.id), kinds: ["project"] }
  }
  // scope === "all": every project scope plus the Home scope.
  const projects = await Scope.list()
  return { ids: [...projects.map((project) => project.id), "home"], kinds: ["project", "home"] }
}

async function collectSessionCandidates(
  scopeSelection: { ids: string[] },
  opts: { sinceMs?: number; beforeMs?: number; includeChildren: boolean; filterByMessageTime: boolean },
): Promise<SessionCandidate[]> {
  const candidates: SessionCandidate[] = []

  for (const scopeID of scopeSelection.ids) {
    const sid = Identifier.asScopeID(scopeID)
    const index = await Session.readPageIndex(sid)
    for (const entry of index.entries) {
      if (entry.archived) continue
      if (entry.parentID && !opts.includeChildren) continue
      // When filtering by message time the session-level updated stamp is not
      // a safe pre-filter (a session can be updated recently yet contain older
      // messages); the per-message filter handles it during the scan.
      if (opts.filterByMessageTime) {
        candidates.push({ scopeID: sid, sessionID: Identifier.asSessionID(entry.id), updated: entry.updated })
        continue
      }
      if (opts.sinceMs !== undefined && entry.updated < opts.sinceMs) continue
      if (opts.beforeMs !== undefined && entry.updated >= opts.beforeMs) continue
      candidates.push({ scopeID: sid, sessionID: Identifier.asSessionID(entry.id), updated: entry.updated })
    }
  }

  candidates.sort((a, b) => b.updated - a.updated)
  return candidates
}

async function readCandidateSession(candidate: SessionCandidate): Promise<Session.Info | undefined> {
  const session = await Storage.read<Session.Info>(StoragePath.sessionInfo(candidate.scopeID, candidate.sessionID))
  if (!session || !session.scope) return undefined
  return session
}

function messageSearchText(parts: MessageV2.Part[], content: "text" | "tool" | "all"): string {
  return SessionSearchIndex.partsSearchText(parts, content)
}

function searchMessage(
  msg: MessageV2.WithParts,
  regex: RegExp,
  tokens: string[],
  opts: { content: "text" | "tool" | "all"; messageSinceMs?: number; messageBeforeMs?: number },
): Match | undefined {
  const created = msg.info.time.created
  if (opts.messageSinceMs !== undefined && created < opts.messageSinceMs) return undefined
  if (opts.messageBeforeMs !== undefined && created >= opts.messageBeforeMs) return undefined

  const text = messageSearchText(msg.parts, opts.content)
  if (!text) return undefined

  const match = regex.exec(text)
  if (!match) return undefined

  return {
    messageID: msg.info.id,
    role: msg.info.role,
    time: created,
    snippet: buildSnippet(text, match.index, match[0].length),
    score: SessionSearchIndex.overlapScore(text, tokens),
  }
}

function searchIndexedMessage(
  msg: SessionSearchIndex.IndexedMessage,
  regex: RegExp,
  tokens: string[],
  opts: { content: "text" | "tool" | "all"; messageSinceMs?: number; messageBeforeMs?: number },
): Match | undefined {
  if (opts.messageSinceMs !== undefined && msg.created < opts.messageSinceMs) return undefined
  if (opts.messageBeforeMs !== undefined && msg.created >= opts.messageBeforeMs) return undefined

  const text = SessionSearchIndex.recordMessageText(msg, opts.content)
  if (!text) return undefined

  const match = regex.exec(text)
  if (!match) return undefined

  return {
    messageID: msg.id,
    role: msg.role,
    time: msg.created,
    snippet: buildSnippet(text, match.index, match[0].length),
    score: SessionSearchIndex.overlapScore(text, tokens),
  }
}

function compareMatches(a: Match, b: Match): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.time !== b.time) return b.time - a.time
  return b.messageID.localeCompare(a.messageID)
}

/** Keep the highest-ranked matches (score desc, then newest) within cap. */
function considerMatch(list: Match[], next: Match, cap: number): void {
  if (list.length < cap) {
    list.push(next)
    list.sort(compareMatches)
    return
  }
  const worst = list[list.length - 1]
  if (compareMatches(next, worst) < 0) {
    list[list.length - 1] = next
    list.sort(compareMatches)
  }
}

function formatResult(result: SessionResult): string {
  const scope = result.session.scope as Scope
  const scopeLabel =
    scope.type === "home"
      ? "Home"
      : (scope.name ?? (scope.directory ? path.basename(scope.directory) : undefined) ?? scope.id)
  const updated = formatLocalDateTime(result.session.time.updated)
  const lines = [`[${result.session.id}] "${result.session.title}" — ${scopeLabel} (updated ${updated})`]

  // Display matches oldest-first within a session, mirroring session_read order.
  const display = [...result.matches].sort((a, b) => a.time - b.time || a.messageID.localeCompare(b.messageID))
  for (const match of display) {
    const time = formatLocalDateTime(match.time)
    lines.push(`  [${match.messageID}] ${match.role} (${time}):`)
    lines.push(`    ${match.snippet}`)
  }

  return lines.join("\n")
}

/** Indexed content to persist for one message while scanning (write-through). */
function indexEntryFromMessage(msg: MessageV2.WithParts): SessionSearchIndex.IndexedMessage {
  return SessionSearchIndex.messageEntryFromParts(msg.info, msg.parts)
}

async function searchSessions(params: z.infer<typeof parameters>, ctx: Tool.Context): Promise<Tool.ExecutionResult> {
  if (isPotentiallyCatastrophicPattern(params.pattern)) {
    return {
      title: "Invalid pattern",
      output:
        `"${params.pattern}" was rejected as a potentially catastrophic regular expression. ` +
        "Nested quantifiers (e.g. `(a+)+`) and other shapes that can cause exponential backtracking are " +
        "blocked because JavaScript cannot preempt a running regex. " +
        "Rewrite the pattern with a bounded, non-nested form.",
      metadata: { pattern: params.pattern, rejected: "catastrophic-backtracking" },
    }
  }

  let regex: RegExp
  try {
    regex = new RegExp(params.pattern, "i")
  } catch {
    return {
      title: "Invalid pattern",
      output: `"${params.pattern}" is not a valid regex pattern.`,
      metadata: { pattern: params.pattern, rejected: "invalid-regex" },
    }
  }

  const sinceMs = params.since ? new Date(params.since).getTime() : undefined
  const beforeMs = params.before ? new Date(params.before).getTime() : undefined
  const filterByMessageTime = params.timeField === "message"
  const scopeSelection = await resolveScopeSelection(params.scope, params.scopeID)
  const tokens = patternTokens(params.pattern)
  const candidates = await collectSessionCandidates(scopeSelection, {
    sinceMs,
    beforeMs,
    includeChildren: params.includeChildren,
    filterByMessageTime,
  })
  const clampedLimit = Math.max(0, Math.min(params.limit, MAX_TOTAL_MATCHES))

  const results: SessionResult[] = []
  let totalMatches = 0
  let sessionsSearched = 0
  let messagesSearched = 0
  let indexedSessions = 0
  let scannedSessions = 0

  for (const candidate of candidates) {
    if (totalMatches >= clampedLimit) break
    ctx.abort.throwIfAborted()

    const session = await readCandidateSession(candidate)
    if (!session) continue
    if (session.parentID && !params.includeChildren) continue

    sessionsSearched++
    const matches: Match[] = []
    const scopeID = Identifier.asScopeID(session.scope.id)
    const sessionID = Identifier.asSessionID(session.id)

    // Fast path: a clean per-session index record carries every message's
    // searchable content in one file; no per-message part reads are needed.
    const [record, dirty] = await Promise.all([
      SessionSearchIndex.readRecord(scopeID, sessionID),
      SessionSearchIndex.isDirty(scopeID, sessionID),
    ])
    if (record && !dirty) {
      indexedSessions++
      for (const msg of record.messages) {
        ctx.abort.throwIfAborted()
        if (totalMatches >= clampedLimit) break
        messagesSearched++
        const match = searchIndexedMessage(msg, regex, tokens, {
          content: params.content,
          messageSinceMs: filterByMessageTime ? sinceMs : undefined,
          messageBeforeMs: filterByMessageTime ? beforeMs : undefined,
        })
        if (match) considerMatch(matches, match, MAX_MATCHES_PER_SESSION)
        SessionMemoryPressure.signalRelease({
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          phase: "tool.session_search.progress",
        })
      }
    } else {
      // Fallback / write-through path: stream messages exactly as before and
      // rebuild the index record when the scan is complete (never when the
      // global limit cut the scan short, which would persist a partial record
      // and hide the remaining messages on later queries).
      scannedSessions++
      const startedAt = Date.now()
      const indexEntries: SessionSearchIndex.IndexedMessage[] = []
      let fullScan = true
      for await (const msg of MessageV2.stream({ scopeID, sessionID })) {
        ctx.abort.throwIfAborted()
        if (totalMatches >= clampedLimit) {
          fullScan = false
          break
        }
        messagesSearched++
        const match = searchMessage(msg, regex, tokens, {
          content: params.content,
          messageSinceMs: filterByMessageTime ? sinceMs : undefined,
          messageBeforeMs: filterByMessageTime ? beforeMs : undefined,
        })
        if (match) considerMatch(matches, match, MAX_MATCHES_PER_SESSION)
        indexEntries.push(indexEntryFromMessage(msg))
        SessionMemoryPressure.signalRelease({
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          phase: "tool.session_search.progress",
        })
      }
      if (fullScan) {
        await SessionSearchIndex.commitRebuild(scopeID, sessionID, indexEntries, { sinceMs: startedAt })
      }
    }

    if (matches.length > 0) {
      // Keep only what remains of the global budget, always highest-ranked.
      const remaining = clampedLimit - totalMatches
      const kept = matches.slice(0, Math.max(0, remaining))
      if (kept.length > 0) {
        results.push({ session, matches: kept })
        totalMatches += kept.length
      }
    }
  }

  const baseMetadata: Record<string, unknown> = {
    sessionsSearched,
    messagesSearched,
    sessionsMatched: results.length,
    matches: totalMatches,
    candidateSessions: candidates.length,
    candidatesTotal: candidates.length,
    scopeSearched: scopeSelection.kinds,
    indexed: indexedSessions,
    scanned: scannedSessions,
    freshness: scannedSessions > 0 ? "possibly_stale" : "fresh",
  }

  if (results.length === 0) {
    return {
      title: "No matches",
      output: `No messages matching "${params.pattern}" found across ${sessionsSearched} searched session${sessionsSearched === 1 ? "" : "s"}.`,
      metadata: { ...baseMetadata, matches: 0, sessionsMatched: 0 } as Record<string, any>,
    }
  }

  const header = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${results.length} session${results.length === 1 ? "" : "s"} (searched ${sessionsSearched} of ${candidates.length} candidate session${candidates.length === 1 ? "" : "s"}):`
  const formatted = results.map(formatResult)

  return {
    title: `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${results.length} session${results.length === 1 ? "" : "s"}`,
    output: `${header}\n\n${formatted.join("\n\n")}`,
    metadata: {
      ...baseMetadata,
      sessions: results.length,
      sessionsMatched: results.length,
    } as Record<string, any>,
  }
}

export const SessionSearchTool = Tool.define("session_search", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    try {
      return await searchSessions(params, ctx)
    } finally {
      SessionMemoryPressure.signalRelease({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        phase: "tool.session_search.complete",
      })
    }
  },
})
