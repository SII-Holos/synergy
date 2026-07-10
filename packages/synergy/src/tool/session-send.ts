import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionManager } from "../session/manager"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import DESCRIPTION from "./session-send.txt"

const parameters = z.object({
  target: z.string().describe("Target session. A session ID (ses_xxx)."),
  content: z.string().describe("The text content to send."),
  role: z
    .enum(["user", "assistant"])
    .default("user")
    .describe(
      "'user' = deliver as a user message (triggers the target session's agent to respond), " +
        "'assistant' = deliver as an assistant message (no response triggered).",
    ),
  sourceName: z
    .string()
    .optional()
    .describe("Display name for the source of this message. Shown in the target session's UI."),
})

async function resolveSession(target: string): Promise<Session.Info> {
  if (target.startsWith("ses_")) {
    return SessionManager.requireSession(target)
  }
  throw new Error(`Unknown session target "${target}". Expected a session ID (ses_xxx).`)
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
      source: "session_send",
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
      await ctx.ask({
        permission: "identity_act",
        patterns: [`session_send role=user to ${params.target}`],
        metadata: {
          nonBypassable: true,
          action: "session_send",
          role: "user",
          target: params.target,
        },
      })
      const mail: SessionManager.SessionMail.User = {
        type: "user",
        parts: [textPart],
        metadata: mailMetadata,
      }
      await SessionManager.deliver({ target: session.id, mail, waitForProcessing: false })
    }

    const deliveryState = params.role === "user" ? "queued and scheduled for asynchronous processing" : "delivered"
    return {
      title: `Sent to ${params.target}`,
      output: `Message ${deliveryState} in session ${session.id} as ${params.role}. The session_send tool call is complete.`,
      metadata: { sessionID: session.id, role: params.role, deliveryState } as Record<string, any>,
    }
  },
})
