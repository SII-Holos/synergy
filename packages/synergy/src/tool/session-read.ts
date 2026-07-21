import { formatLocalDateTime } from "@/util/time-format"
import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { SessionHistory } from "../session/history"
import { SessionMemoryPressure } from "../session/memory-pressure"
import { Scope } from "@/scope"
import { Identifier } from "../id/id"
import DESCRIPTION from "./session-read.txt"

const parameters = z.object({
  target: z.string().describe("Session to read. A session ID (ses_xxx)."),
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
  if (target.startsWith("ses_")) {
    return SessionManager.requireSession(target)
  }
  throw new Error(`Unknown target "${target}". Use a session ID (ses_xxx).`)
}

function extractMessageText(parts: MessageV2.Part[]): string {
  return parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !MessageV2.isSystemPart(p))
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
  const time = formatLocalDateTime(msg.info.time.created)
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

async function hydrateMessages(input: {
  infos: MessageV2.Info[]
  scopeID: Identifier.ScopeID
  sessionID: Identifier.SessionID
  abort: AbortSignal
}) {
  const messages: MessageV2.WithParts[] = []
  for (const info of input.infos) {
    input.abort.throwIfAborted()
    messages.push({
      info,
      parts: await MessageV2.parts({
        scopeID: input.scopeID,
        sessionID: input.sessionID,
        messageID: info.id,
      }),
    })
  }
  return messages
}

async function readSession(params: z.infer<typeof parameters>, ctx: Tool.Context) {
  const session = await resolveSession(params.target)
  if (!session.scope) {
    return {
      title: "Legacy session",
      output: `Session ${session.id} uses a legacy format and cannot be read.`,
      metadata: { sessionID: session.id } as Record<string, any>,
    }
  }
  const scopeID = Identifier.asScopeID((session.scope as Scope).id)
  const sessionID = session.id as Identifier.SessionID
  const clampedLimit = Math.max(0, Math.min(params.limit, 50))
  const allMessageInfos = (await SessionHistory.messageInfos(session.id)).reverse()
  const total = allMessageInfos.length
  const updated = formatLocalDateTime(session.time.updated)
  const header = `Session: ${session.id} — "${session.title}" (updated ${updated})`

  if (params.around) {
    const anchorIndex = allMessageInfos.findIndex((message) => message.id === params.around)
    if (anchorIndex < 0) {
      return {
        title: session.title,
        output: `${header}\n\nMessage ${params.around} not found in this session.`,
        metadata: { sessionID: session.id, total } as Record<string, any>,
      }
    }

    const half = Math.floor(clampedLimit / 2)
    let start = Math.max(0, anchorIndex - half)
    const end = Math.min(total, start + clampedLimit)
    if (end - start < clampedLimit) {
      start = Math.max(0, end - clampedLimit)
    }

    const page = await hydrateMessages({
      infos: allMessageInfos.slice(start, end),
      scopeID,
      sessionID,
      abort: ctx.abort,
    })
    const formatted = page.map((message) => formatMessage(message, message.info.id === params.around))
    const pagination = `Showing messages ${start + 1}-${end} of ${total} (centered on ${params.around}):`

    return {
      title: session.title,
      output: `${header}\n${pagination}\n\n${formatted.join("\n\n---\n\n")}`,
      metadata: { sessionID: session.id, total, shown: page.length, anchorIndex: start } as Record<string, any>,
    }
  }

  const page = await hydrateMessages({
    infos: allMessageInfos.slice(params.offset, params.offset + clampedLimit),
    scopeID,
    sessionID,
    abort: ctx.abort,
  })

  if (page.length === 0) {
    return {
      title: session.title,
      output: `${header}\n\nNo messages found.`,
      metadata: { sessionID: session.id, total } as Record<string, any>,
    }
  }

  const rangeStart = params.offset + 1
  const rangeEnd = params.offset + page.length
  const pagination = `Showing messages ${rangeStart}-${rangeEnd} of ${total} (newest first):`
  const formatted = page.map((message) => formatMessage(message))

  return {
    title: session.title,
    output: `${header}\n${pagination}\n\n${formatted.join("\n\n---\n\n")}`,
    metadata: { sessionID: session.id, total, shown: page.length } as Record<string, any>,
  }
}

export const SessionReadTool = Tool.define("session_read", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    try {
      return await readSession(params, ctx)
    } finally {
      await SessionMemoryPressure.maybeCollect({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        phase: "tool.session_read.complete",
        forceFull: true,
      })
    }
  },
})
