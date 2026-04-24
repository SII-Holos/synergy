import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Scope } from "@/scope"
import { Instance } from "@/scope/instance"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import DESCRIPTION from "./session-search.txt"

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

function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const half = Math.floor(SNIPPET_CHARS / 2)
  const start = Math.max(0, matchIndex - half)
  const end = Math.min(text.length, matchIndex + matchLength + half)
  let snippet = text.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < text.length) snippet = snippet + "..."
  return snippet
}

async function collectSessions(scope: string, sinceMs?: number, beforeMs?: number): Promise<Session.Info[]> {
  const scopes = scope === "current" ? [Instance.scope] : await Scope.list()
  const allSessions: Session.Info[] = []

  for (const s of scopes) {
    const scopeID = Identifier.asScopeID(s.id)
    const index = await Session.readPageIndex(scopeID)
    const filtered = index.entries.filter((entry) => {
      if (entry.archived) return false
      if (sinceMs && entry.updated < sinceMs) return false
      if (beforeMs && entry.updated >= beforeMs) return false
      return true
    })
    if (filtered.length === 0) continue
    const keys = filtered.map((entry) => StoragePath.sessionInfo(scopeID, Identifier.asSessionID(entry.id)))
    const sessions = await Storage.readMany<Session.Info>(keys)
    for (const session of sessions) {
      if (!session || !session.scope || session.parentID) continue
      allSessions.push(session)
    }
  }

  allSessions.sort((a, b) => b.time.updated - a.time.updated)
  return allSessions
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
  const scopeLabel = scope.type === "global" ? "Home" : (scope.name ?? scope.directory?.split("/").pop() ?? scope.id)
  const updated = new Date(result.session.time.updated).toISOString()
  const lines = [`[${result.session.id}] "${result.session.title}" — ${scopeLabel} (updated ${updated})`]

  for (const match of result.matches) {
    const time = new Date(match.time).toISOString()
    lines.push(`  [${match.messageID}] ${match.role} (${time}):`)
    lines.push(`    ${match.snippet}`)
  }

  return lines.join("\n")
}

export const SessionSearchTool = Tool.define("session_search", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
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
    const sessions = await collectSessions(params.scope, sinceMs, beforeMs)
    const clampedLimit = Math.min(params.limit, 100)

    const results: SessionResult[] = []
    let totalMatches = 0

    for (const session of sessions) {
      if (totalMatches >= clampedLimit) break

      const scopeID = (session.scope as Scope).id
      const matches: Match[] = []

      for await (const msg of MessageV2.stream({ scopeID, sessionID: session.id })) {
        if (matches.length >= MAX_MATCHES_PER_SESSION) break
        if (totalMatches + matches.length >= clampedLimit) break

        const match = searchMessage(msg, regex)
        if (match) {
          matches.push(match)
          regex.lastIndex = 0
        }
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
        output: `No messages matching "${params.pattern}" found across ${sessions.length} sessions.`,
        metadata: { sessionsSearched: sessions.length, matches: 0 } as Record<string, any>,
      }
    }

    const header = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${results.length} session${results.length === 1 ? "" : "s"} (searched ${sessions.length}):`
    const formatted = results.map(formatResult)

    return {
      title: `${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${results.length} session${results.length === 1 ? "" : "s"}`,
      output: `${header}\n\n${formatted.join("\n\n")}`,
      metadata: { sessionsSearched: sessions.length, matches: totalMatches, sessions: results.length } as Record<
        string,
        any
      >,
    }
  },
})
