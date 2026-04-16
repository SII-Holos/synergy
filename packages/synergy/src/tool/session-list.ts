import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
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

interface LastExchange {
  user?: { text: string; time: number }
  assistant?: { text: string; time: number }
}

async function getLastExchange(sessionID: string, scopeID: string): Promise<LastExchange> {
  const exchange: LastExchange = {}
  for await (const msg of MessageV2.stream({ scopeID, sessionID })) {
    if (!exchange.assistant && msg.info.role === "assistant") {
      const text = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.ignored && !p.synthetic)
        .map((p) => p.text)
        .join("\n")
      if (text) {
        exchange.assistant = { text: text.slice(0, 200), time: msg.info.time.created }
      }
    }
    if (!exchange.user && msg.info.role === "user") {
      const text = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.ignored && !p.synthetic)
        .map((p) => p.text)
        .join("\n")
      if (text) {
        exchange.user = { text: text.slice(0, 200), time: msg.info.time.created }
      }
    }
    if (exchange.user && exchange.assistant) break
  }
  return exchange
}

function formatExchange(exchange: LastExchange): string {
  const lines: string[] = []
  if (exchange.user) {
    lines.push(`  Last user: ${exchange.user.text}`)
  }
  if (exchange.assistant) {
    lines.push(`  Last assistant: ${exchange.assistant.text}`)
  }
  return lines.join("\n")
}

function formatScopeLabel(scope: Scope): string {
  if (scope.type === "global") return `Home [${scope.id}]`
  const name = scope.name ?? scope.directory.split("/").pop() ?? scope.id
  return `${name} [${scope.id}] — ${scope.directory}`
}

function formatSessionEntry(session: Session.Info, exchange: LastExchange, extra?: string): string {
  const scope = session.scope as Scope
  const pinned = session.pinned ? " [pinned]" : ""
  const updated = new Date(session.time.updated).toISOString()
  const parts = [`- [${session.id}] "${session.title}"${pinned} — updated ${updated}`]
  parts.push(`  Scope: ${formatScopeLabel(scope)}`)
  if (extra) parts.push(`  ${extra}`)
  const ex = formatExchange(exchange)
  if (ex) parts.push(ex)
  return parts.join("\n")
}

function filterByTime(sessions: Session.Info[], filter: TimeFilter): Session.Info[] {
  if (!filter.sinceMs && !filter.beforeMs) return sessions
  return sessions.filter((s) => {
    if (filter.sinceMs && s.time.updated < filter.sinceMs) return false
    if (filter.beforeMs && s.time.updated >= filter.beforeMs) return false
    return true
  })
}

async function listProject(limit: number, offset: number, filter: TimeFilter) {
  const scopes = await Scope.list()
  const allSessions: Session.Info[] = []

  for (const scope of scopes) {
    const scopeID = Identifier.asScopeID(scope.id)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scopeID))
    const keys = ids.map((id) => StoragePath.sessionInfo(scopeID, Identifier.asSessionID(id)))
    const sessions = await Storage.readMany<Session.Info>(keys)
    for (const s of sessions) {
      if (s && s.scope && !s.parentID && !s.time.archived) allSessions.push(s)
    }
  }

  const filtered = filterByTime(allSessions, filter)
  filtered.sort((a, b) => b.time.updated - a.time.updated)

  const total = filtered.length
  const page = filtered.slice(offset, offset + limit)
  const entries: string[] = []
  for (const session of page) {
    const exchange = await getLastExchange(session.id, (session.scope as Scope).id)
    entries.push(formatSessionEntry(session, exchange))
  }
  return { entries, total, shown: page.length }
}

async function listHome() {
  const session = await AppChannel.session()
  const homeSession = { ...session, title: "Home" }
  const exchange = await getLastExchange(session.id, (session.scope as Scope).id)
  return {
    entries: [formatSessionEntry(homeSession, exchange)],
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
      const exchange = await getLastExchange(session.id, (session.scope as Scope).id)
      const ex = formatExchange(exchange)
      entries.push(ex ? `${header}\n  Session: ${session.id}\n${ex}` : `${header}\n  Session: ${session.id}`)
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
  const sessions = filterByTime(
    all.filter(
      (s): s is Session.Info =>
        s != null && !!s.scope && !s.parentID && !s.time.archived && SessionEndpoint.type(s.endpoint) === "feishu",
    ),
    filter,
  )
  sessions.sort((a, b) => b.time.updated - a.time.updated)

  const total = sessions.length
  const page = sessions.slice(offset, offset + limit)
  const entries: string[] = []
  for (const session of page) {
    const exchange = await getLastExchange(session.id, scopeID)
    entries.push(formatSessionEntry(session, exchange))
  }
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
