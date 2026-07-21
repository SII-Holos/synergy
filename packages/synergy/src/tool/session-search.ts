import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionMemoryPressure } from "../session/memory-pressure"
import { Scope } from "@/scope"
import { ScopeContext } from "@/scope/context"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import DESCRIPTION from "./session-search.txt"
import path from "node:path"

const parameters = z.object({
  pattern: z.string().describe("Regex pattern to search for in message text content."),
  scope: z
    .enum(["all", "current"])
    .default("all")
    .describe("Which scope to search: 'all' (all projects) or 'current' (current project only)."),
  since: z
    .string()
    .optional()
    .describe(
      "Only include sessions updated on or after this date (ISO 8601, e.g. '2026-03-15' or '2026-03-15T18:00:00').",
    ),
  before: z.string().optional().describe("Only include sessions updated before this date (ISO 8601)."),
  limit: z.coerce.number().default(20).describe("Maximum number of matches to return across all sessions."),
})

const MAX_MATCHES_PER_SESSION = 3
const MAX_TOTAL_MATCHES = 100
const SNIPPET_CHARS = 150

interface Match {
  messageID: string
  role: string
  time: number
  snippet: string
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

async function collectSessionCandidates(
  scope: string,
  sinceMs?: number,
  beforeMs?: number,
): Promise<SessionCandidate[]> {
  const scopes = scope === "current" ? [ScopeContext.current.scope] : await Scope.list()
  const candidates: SessionCandidate[] = []

  for (const s of scopes) {
    const scopeID = Identifier.asScopeID(s.id)
    const index = await Session.readPageIndex(scopeID)
    for (const entry of index.entries) {
      if (entry.archived) continue
      if (entry.parentID) continue
      if (sinceMs !== undefined && entry.updated < sinceMs) continue
      if (beforeMs !== undefined && entry.updated >= beforeMs) continue
      candidates.push({
        scopeID,
        sessionID: Identifier.asSessionID(entry.id),
        updated: entry.updated,
      })
    }
  }

  candidates.sort((a, b) => b.updated - a.updated)
  return candidates
}

async function readCandidateSession(candidate: SessionCandidate): Promise<Session.Info | undefined> {
  const session = await Storage.read<Session.Info>(StoragePath.sessionInfo(candidate.scopeID, candidate.sessionID))
  if (!session || !session.scope || session.parentID) return undefined
  return session
}

function searchMessage(msg: MessageV2.WithParts, regex: RegExp): Match | undefined {
  const text = MessageV2.extractText(msg.parts)

  if (!text) return undefined

  const match = regex.exec(text)
  if (!match) return undefined

  return {
    messageID: msg.info.id,
    role: msg.info.role,
    time: msg.info.time.created,
    snippet: buildSnippet(text, match.index, match[0].length),
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

  for (const match of result.matches) {
    const time = formatLocalDateTime(match.time)
    lines.push(`  [${match.messageID}] ${match.role} (${time}):`)
    lines.push(`    ${match.snippet}`)
  }

  return lines.join("\n")
}

async function searchSessions(params: z.infer<typeof parameters>, ctx: Tool.Context) {
  let regex: RegExp
  try {
    regex = new RegExp(params.pattern, "i")
  } catch {
    return {
      title: "Invalid pattern",
      output: `"${params.pattern}" is not a valid regex pattern.`,
      metadata: {} as Record<string, any>,
    }
  }

  const sinceMs = params.since ? new Date(params.since).getTime() : undefined
  const beforeMs = params.before ? new Date(params.before).getTime() : undefined
  const candidates = await collectSessionCandidates(params.scope, sinceMs, beforeMs)
  const clampedLimit = Math.max(0, Math.min(params.limit, MAX_TOTAL_MATCHES))

  const results: SessionResult[] = []
  let totalMatches = 0
  let sessionsSearched = 0
  let messagesSearched = 0

  for (const candidate of candidates) {
    if (totalMatches >= clampedLimit) break
    ctx.abort.throwIfAborted()

    const session = await readCandidateSession(candidate)
    if (!session) continue

    sessionsSearched++
    const matches: Match[] = []

    for await (const msg of MessageV2.stream({ scopeID: session.scope.id, sessionID: session.id })) {
      ctx.abort.throwIfAborted()
      if (matches.length >= MAX_MATCHES_PER_SESSION) break
      if (totalMatches + matches.length >= clampedLimit) break

      messagesSearched++
      const match = searchMessage(msg, regex)
      if (match) {
        matches.push(match)
      }

      SessionMemoryPressure.signalRelease({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        phase: "tool.session_search.progress",
      })
    }

    if (matches.length > 0) {
      matches.reverse()
      results.push({ session, matches })
      totalMatches += matches.length
    }
  }

  if (results.length === 0) {
    return {
      title: "No matches",
      output: `No messages matching "${params.pattern}" found across ${sessionsSearched} searched session${sessionsSearched === 1 ? "" : "s"}.`,
      metadata: {
        sessionsSearched,
        messagesSearched,
        sessionsMatched: 0,
        matches: 0,
        candidateSessions: candidates.length,
      } as Record<string, any>,
    }
  }

  const header = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${results.length} session${results.length === 1 ? "" : "s"} (searched ${sessionsSearched} of ${candidates.length} candidate session${candidates.length === 1 ? "" : "s"}):`
  const formatted = results.map(formatResult)

  return {
    title: `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${results.length} session${results.length === 1 ? "" : "s"}`,
    output: `${header}\n\n${formatted.join("\n\n")}`,
    metadata: {
      sessionsSearched,
      messagesSearched,
      matches: totalMatches,
      sessions: results.length,
      sessionsMatched: results.length,
      candidateSessions: candidates.length,
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
