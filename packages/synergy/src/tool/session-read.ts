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
import DESCRIPTION from "./session-read.txt"

const parameters = z.object({
  target: z
    .string()
    .describe("Session to read. A session ID (ses_xxx), 'home' for the app home session, or a Holos contact/agent ID."),
  limit: z.coerce.number().default(20).describe("Number of messages to return."),
  offset: z.coerce.number().default(0).describe("Number of messages to skip (0 = most recent)."),
  around: z
    .string()
    .optional()
    .describe(
      "Message ID to center the view around. When provided, returns messages surrounding this message instead of using offset. Useful after session_search to read context around a match.",
    ),
})

async function resolveSession(target: string): Promise<Session.Info> {
  if (target === "home") {
    return AppChannel.session()
  }
  if (target.startsWith("ses_")) {
    return SessionManager.requireSession(target)
  }
  const session = await SessionManager.getSession(SessionEndpoint.holos(target))
  if (!session) {
    throw new Error(`No session found for contact "${target}". The contact may not have an active conversation.`)
  }
  return session
}

function extractMessageText(parts: MessageV2.Part[]): string {
  return parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.ignored && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
}

function extractToolSummaries(parts: MessageV2.Part[]): Array<{ name: string; status: string; title?: string }> {
  return parts
    .filter((p): p is MessageV2.ToolPart => p.type === "tool")
    .map((p) => ({
      name: p.tool,
      status: p.state.status,
      title: "title" in p.state ? (p.state.title as string) : undefined,
    }))
}

function formatMessage(msg: MessageV2.WithParts, highlight?: boolean): string {
  const text = extractMessageText(msg.parts)
  const time = new Date(msg.info.time.created).toISOString()
  const marker = highlight ? " ◀" : ""

  if (msg.info.role === "user") {
    return `[${msg.info.id}] user (${time})${marker}:\n${text || "(empty)"}`
  }

  const assistant = msg.info as MessageV2.Assistant
  const tools = extractToolSummaries(msg.parts)
  const lines = [`[${msg.info.id}] assistant/${assistant.agent} (${time})${marker}:`]

  if (text) lines.push(text)

  if (tools.length > 0) {
    const toolLines = tools.map((t) => {
      const title = t.title ? ` — ${t.title}` : ""
      return `  • ${t.name} [${t.status}]${title}`
    })
    lines.push(`Tools:\n${toolLines.join("\n")}`)
  }

  if (assistant.error) {
    lines.push(
      `Error: ${"data" in assistant.error && "message" in assistant.error.data ? assistant.error.data.message : assistant.error.name}`,
    )
  }

  return lines.join("\n")
}

export const SessionReadTool = Tool.define("session_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const session = await resolveSession(params.target)
    if (!session.scope) {
      return {
        title: "Legacy session",
        output: `Session ${session.id} uses a legacy format and cannot be read.`,
        metadata: { sessionID: session.id } as Record<string, any>,
      }
    }
    const scopeID = (session.scope as Scope).id
    const sessionID = session.id as Identifier.SessionID
    const clampedLimit = Math.min(params.limit, 50)

    const allMessageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(Identifier.asScopeID(scopeID), sessionID))
    const total = allMessageIDs.length

    // Collect messages via stream (newest first)
    const allMessages: MessageV2.WithParts[] = []
    for await (const msg of MessageV2.stream({ scopeID, sessionID })) {
      allMessages.push(msg)
    }

    const updated = new Date(session.time.updated).toISOString()
    const header = `Session: ${session.id} — "${session.title}" (updated ${updated})`

    if (params.around) {
      // Anchor mode: center around a specific message
      const anchorIndex = allMessages.findIndex((m) => m.info.id === params.around)
      if (anchorIndex < 0) {
        return {
          title: session.title,
          output: `${header}\n\nMessage ${params.around} not found in this session.`,
          metadata: { sessionID: session.id, total } as Record<string, any>,
        }
      }

      const half = Math.floor(clampedLimit / 2)
      let start = Math.max(0, anchorIndex - half)
      let end = Math.min(allMessages.length, start + clampedLimit)
      if (end - start < clampedLimit) {
        start = Math.max(0, end - clampedLimit)
      }

      const page = allMessages.slice(start, end)
      const formatted = page.map((m) => formatMessage(m, m.info.id === params.around))
      const pagination = `Showing messages ${start + 1}-${end} of ${total} (centered on ${params.around}):`

      return {
        title: session.title,
        output: `${header}\n${pagination}\n\n${formatted.join("\n\n---\n\n")}`,
        metadata: { sessionID: session.id, total, shown: page.length, anchorIndex: start } as Record<string, any>,
      }
    }

    // Browse mode: offset from newest
    const page = allMessages.slice(params.offset, params.offset + clampedLimit)

    if (page.length === 0) {
      return {
        title: session.title,
        output: `${header}\n\nNo messages found.`,
        metadata: { sessionID: session.id, total: 0 } as Record<string, any>,
      }
    }

    const rangeStart = params.offset + 1
    const rangeEnd = params.offset + page.length
    const pagination = `Showing messages ${rangeStart}-${rangeEnd} of ${total} (newest first):`

    const formatted = page.map((m) => formatMessage(m))

    return {
      title: session.title,
      output: `${header}\n${pagination}\n\n${formatted.join("\n\n---\n\n")}`,
      metadata: { sessionID: session.id, total, shown: page.length } as Record<string, any>,
    }
  },
})
