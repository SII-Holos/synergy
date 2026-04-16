import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { AppChannel } from "../channel/app"
import { Contact } from "../holos/contact"
import { HolosRuntime } from "../holos/runtime"
import DESCRIPTION from "./session-send.txt"

const parameters = z.object({
  target: z
    .string()
    .describe("Target session. A session ID (ses_xxx), 'home' for the app home session, or a Holos contact/agent ID."),
  content: z.string().describe("The text content to send."),
  role: z
    .enum(["user", "assistant"])
    .default("assistant")
    .describe(
      "'assistant' = deliver as an assistant message (no response triggered), " +
        "'user' = deliver as a user message (triggers the target session's agent to respond).",
    ),
  sourceName: z
    .string()
    .optional()
    .describe("Display name for the source of this message. Shown in the target session's UI."),
})

async function resolveSession(target: string): Promise<Session.Info> {
  if (target === "home") {
    return AppChannel.session()
  }
  if (target.startsWith("ses_")) {
    return SessionManager.requireSession(target)
  }
  // Treat as holos contact ID
  const contact = await Contact.get(target)
  if (!contact) {
    throw new Error(`Contact "${target}" not found.`)
  }
  if (contact.config.blocked) {
    throw new Error(`Contact "${target}" is blocked.`)
  }
  return HolosRuntime.getOrCreateSession(contact.holosId ?? contact.id)
}

export const SessionSendTool = Tool.define("session_send", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await resolveSession(params.target)

    const textPart: MessageV2.TextPart = {
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      type: "text",
      text: params.content,
    }

    const mailMetadata = {
      mailbox: true,
      source: "agent",
      sourceSessionID: ctx.sessionID,
      ...(params.sourceName ? { sourceName: params.sourceName } : {}),
    }

    if (params.role === "assistant") {
      const mail: SessionManager.SessionMail.Assistant = {
        type: "assistant",
        parts: [textPart],
        metadata: mailMetadata,
      }
      await SessionManager.deliver({ target: session.id, mail })
    } else {
      const mail: SessionManager.SessionMail.User = {
        type: "user",
        parts: [textPart],
        metadata: mailMetadata,
      }
      await SessionManager.deliver({ target: session.id, mail })
    }

    return {
      title: `Sent to ${params.target}`,
      output: `Message delivered to session ${session.id} as ${params.role}.`,
      metadata: { sessionID: session.id, role: params.role } as Record<string, any>,
    }
  },
})
