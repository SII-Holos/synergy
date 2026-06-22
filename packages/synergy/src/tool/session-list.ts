import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { Scope } from "@/scope"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { SessionNav, type SessionNavEntry } from "../session/nav"
import DESCRIPTION from "./session-list.txt"
import path from "node:path"

const parameters = z.object({
  scope: z
    .enum(["project", "home", "feishu"])
    .describe(
      "'project' = sessions across all projects (each entry includes its scope), " +
        "'home' = sessions in the home scope, " +
        "'feishu' = Feishu/Lark channel sessions.",
    ),
  limit: z.coerce.number().default(20).describe("Maximum number of items to return."),
  offset: z.coerce.number().default(0).describe("Number of items to skip."),
  since: z
    .string()
    .optional()
    .describe(
      "Only include sessions updated on or after this date (ISO 8601, e.g. '2026-03-15' or '2026-03-15T18:00:00').",
    ),
  before: z.string().optional().describe("Only include sessions updated before this date (ISO 8601)."),
})

interface TimeFilter {
  sinceMs?: number
  beforeMs?: number
}
const QueryLimit = 10000

function formatScopeLabel(scope: Scope): string {
  if (scope.type === "global") return `Home [${scope.id}]`
  const name = scope.name ?? path.basename(scope.directory) ?? scope.id
  return `${name} [${scope.id}] — ${scope.directory}`
}

function formatSessionEntry(session: Session.Info, extra?: string): string {
  const scope = session.scope as Scope
  const pinned = session.pinned ? " [pinned]" : ""
  const updated = formatLocalDateTime(session.time.updated)
  const parts = [`- [${session.id}] "${session.title}"${pinned} — updated ${updated}`]
  parts.push(`  Scope: ${formatScopeLabel(scope)}`)
  if (extra) parts.push(`  ${extra}`)
  if (session.lastExchange?.user) parts.push(`  Last user: ${session.lastExchange.user}`)
  if (session.lastExchange?.assistant) parts.push(`  Last assistant: ${session.lastExchange.assistant}`)
  return parts.join("\n")
}
async function loadSessions(entries: SessionNavEntry[]): Promise<Session.Info[]> {
  if (entries.length === 0) return []
  const keys = entries.map((e) =>
    StoragePath.sessionInfo(Identifier.asScopeID(e.scopeID), Identifier.asSessionID(e.id)),
  )
  const sessions = await Storage.readMany<Session.Info>(keys)
  return sessions.filter((s): s is Session.Info => s != null && !!s.scope && !s.parentID)
}

function applyTimeFilter(entries: SessionNavEntry[], filter: TimeFilter): SessionNavEntry[] {
  const { sinceMs, beforeMs } = filter
  let result = entries
  if (sinceMs != null) result = result.filter((e) => e.lastActivityAt >= sinceMs)
  if (beforeMs != null) result = result.filter((e) => e.lastActivityAt < beforeMs)
  return result
}

async function listProject(limit: number, offset: number, filter: TimeFilter) {
  const result = await SessionNav.queryGlobal({ limit: QueryLimit })
  const filtered = applyTimeFilter(result.items, filter)
  const total = filtered.length
  const page = filtered.slice(offset, offset + limit)
  const sessions = await loadSessions(page)
  const entries = sessions.map((s) => formatSessionEntry(s))
  return { entries, total, shown: entries.length }
}

async function listHome(limit: number, offset: number, filter: TimeFilter) {
  const result = await SessionNav.queryScope("global", { category: "home", limit: QueryLimit })
  const filtered = applyTimeFilter(result.items, filter)
  const total = filtered.length
  const page = filtered.slice(offset, offset + limit)
  const sessions = await loadSessions(page)
  const entries = sessions.map((s) => formatSessionEntry(s))
  return { entries, total, shown: entries.length }
}

async function listFeishu(limit: number, offset: number, filter: TimeFilter) {
  const result = await SessionNav.queryScope("global", { category: "channel", limit: QueryLimit })
  const filtered = applyTimeFilter(result.items, filter)
  const total = filtered.length
  const page = filtered.slice(offset, offset + limit)
  const sessions = await loadSessions(page)
  const entries = sessions.map((s) => formatSessionEntry(s))
  return { entries, total, shown: entries.length }
}

export const SessionListTool = Tool.define("session_list", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const { scope, limit, offset } = params
    const clampedLimit = Math.min(limit, 50)
    const filter: TimeFilter = {
      sinceMs: params.since ? new Date(params.since).getTime() : undefined,
      beforeMs: params.before ? new Date(params.before).getTime() : undefined,
    }

    let result: { entries: string[]; total: number; shown: number }

    switch (scope) {
      case "project":
        result = await listProject(clampedLimit, offset, filter)
        break
      case "home":
        result = await listHome(clampedLimit, offset, filter)
        break
      case "feishu":
        result = await listFeishu(clampedLimit, offset, filter)
        break
    }

    if (result.total === 0) {
      return {
        title: `No ${scope} sessions`,
        output: `No sessions found for scope "${scope}".`,
        metadata: { scope, total: 0 } as Record<string, any>,
      }
    }

    const rangeStart = offset + 1
    const rangeEnd = offset + result.shown
    const header = `Found ${result.total} item${result.total === 1 ? "" : "s"} (showing ${rangeStart}-${rangeEnd}):`

    return {
      title: `${result.total} ${scope} session${result.total === 1 ? "" : "s"}`,
      output: `${header}\n\n${result.entries.join("\n\n")}`,
      metadata: { scope, total: result.total, shown: result.shown } as Record<string, any>,
    }
  },
})
