import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import DESCRIPTION from "./session-send.txt"

const parameters = z.object({
  target: z.string().describe("Target session. A session ID (ses_xxx)."),
  content: z.string().describe("The text content to send."),
  role: z
    .literal("user", { error: 'session_send only supports role "user". Retry the call with role: "user".' })
    .default("user")
    .describe("Must be 'user'. This is the only supported delivery role."),
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
  formatValidationError(error) {
    if (error.issues.some((issue) => issue.path[0] === "role")) {
      return 'session_send only supports role "user". Retry the call with role: "user".'
    }
    return `The session_send tool was called with invalid arguments: ${error.message}`
  },
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
    const item = await SessionManager.deliver({
      target: session.id,
      mail,
      waitForProcessing: false,
      sourceSessionID: ctx.sessionID,
    })
    if (!item) throw new Error(`Message was not delivered: session ${session.id} is no longer available.`)

    const deliveryState =
      item.mode === "steer"
        ? "queued for the current task's next model call"
        : "queued as a new task; it waits for the current task to finish and for the session to be runnable"
    return {
      title: `Queued for ${params.target}`,
      output: `Message ${deliveryState} in session ${session.id}. Reading is not yet confirmed.`,
      metadata: {
        sessionID: session.id,
        role: "user",
        mode: item.mode,
        itemID: item.id,
        messageID: item.messageID,
        deliveryState,
      },
    }
  },
})
