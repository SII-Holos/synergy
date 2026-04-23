import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionManager } from "../session/manager"
import { Scope } from "@/scope"
import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { AppChannel } from "../channel/app"
import { Contact } from "../holos/contact"
import { Presence } from "../holos/presence"
import DESCRIPTION from "./session-list.txt"

const parameters = z.object({
  scope: z
    .enum(["project", "home", "contacts", "feishu"])
    .describe(
      "'project' = sessions across all projects (each entry includes its scope), " +
        "'home' = the app home session, " +
        "'contacts' = Holos conversation sessions, " +
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

function formatScopeLabel(scope: Scope): string {
  if (scope.type === "global") return `Home [${scope.id}]`
  const name = scope.name ?? scope.directory.split("/").pop() ?? scope.id
  return `${name} [${scope.id}] — ${scope.directory}`
}

function formatSessionEntry(session: Session.Info, extra?: string): string {
  const scope = session.scope as Scope
  const pinned = session.pinned ? " [pinned]" : ""
  const updated = new Date(session.time.updated).toISOString()
  const parts = [`- [${session.id}] "${session.title}"${pinned} — updated ${updated}`]
  parts.push(`  Scope: ${formatScopeLabel(scope)}`)
  if (extra) parts.push(`  ${extra}`)
  if (session.lastExchange?.user) parts.push(`  Last user: ${session.lastExchange.user}`)
  if (session.lastExchange?.assistant) parts.push(`  Last assistant: ${session.lastExchange.assistant}`)
  return parts.join("\n")
}

async function listProject(limit: number, offset: number, filter: TimeFilter) {
  const scopes = await Scope.list()
  const allEntries: Array<Session.PageIndex["entries"][number] & { scopeID: Identifier.ScopeID }> = []

  for (const scope of scopes) {
    const scopeID = Identifier.asScopeID(scope.id)
    const index = await Session.readPageIndex(scopeID)
    for (const entry of index.entries) {
      if (entry.archived) continue
      if (filter.sinceMs && entry.updated < filter.sinceMs) continue
      if (filter.beforeMs && entry.updated >= filter.beforeMs) continue
      allEntries.push({ ...entry, scopeID })
    }
  }

  allEntries.sort((a, b) => b.updated - a.updated)
  const total = allEntries.length
  const page = allEntries.slice(offset, offset + limit)

  const keys = page.map((e) => StoragePath.sessionInfo(e.scopeID, Identifier.asSessionID(e.id)))
  const sessions = await Storage.readMany<Session.Info>(keys)

  const entries: string[] = []
  for (const s of sessions) {
    if (s && s.scope && !s.parentID) entries.push(formatSessionEntry(s))
  }
  return { entries, total, shown: entries.length }
}

async function listHome() {
  const session = await AppChannel.session()
  const homeSession = { ...session, title: "Home" }
  return {
    entries: [formatSessionEntry(homeSession)],
    total: 1,
    shown: 1,
  }
}

async function listContacts(limit: number, offset: number) {
  const contacts = await Contact.list()
  const sorted = contacts.sort((a, b) => b.addedAt - a.addedAt)
  const total = sorted.length
  const page = sorted.slice(offset, offset + limit)
  const entries: string[] = []

  for (const contact of page) {
    const online = contact.holosId ? Presence.get(contact.holosId) : "unknown"
    const statusLabel = contact.status === "blocked" ? "blocked" : online
    const header = `- [${contact.id}] ${contact.name} (${statusLabel})`

    const endpoint = SessionEndpoint.holos(contact.holosId ?? contact.id)
    const session = await SessionManager.getSession(endpoint)
    if (session && session.scope && !session.time.archived) {
      const ex = session.lastExchange
      const exLines: string[] = []
      if (ex?.user) exLines.push(`  Last user: ${ex.user}`)
      if (ex?.assistant) exLines.push(`  Last assistant: ${ex.assistant}`)
      const exText = exLines.join("\n")
      entries.push(exText ? `${header}\n  Session: ${session.id}\n${exText}` : `${header}\n  Session: ${session.id}`)
    } else {
      entries.push(`${header}\n  No conversation yet`)
    }
  }

  return { entries, total, shown: page.length }
}

async function listFeishu(limit: number, offset: number, filter: TimeFilter) {
  const scopeID = Identifier.asScopeID(Scope.global().id)
  const ids = await Storage.scan(StoragePath.sessionsRoot(scopeID))
  const keys = ids.map((id) => StoragePath.sessionInfo(scopeID, Identifier.asSessionID(id)))
  const all = await Storage.readMany<Session.Info>(keys)
  const sessions = all
    .filter(
      (s): s is Session.Info =>
        s != null && !!s.scope && !s.parentID && !s.time.archived && SessionEndpoint.type(s.endpoint) === "feishu",
    )
    .filter((s) => {
      if (filter.sinceMs && s.time.updated < filter.sinceMs) return false
      if (filter.beforeMs && s.time.updated >= filter.beforeMs) return false
      return true
    })
  sessions.sort((a, b) => b.time.updated - a.time.updated)

  const total = sessions.length
  const page = sessions.slice(offset, offset + limit)
  const entries = page.map((s) => formatSessionEntry(s))
  return { entries, total, shown: page.length }
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
        result = await listHome()
        break
      case "contacts":
        result = await listContacts(clampedLimit, offset)
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
