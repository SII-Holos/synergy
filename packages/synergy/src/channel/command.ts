import z from "zod"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"
import { Session } from "../session"
import { SessionEndpoint } from "../session/endpoint"

export namespace ChannelCommand {
  const log = Log.create({ service: "channel.command" })

  export const Event = {
    Executed: BusEvent.define(
      "channel.command.executed",
      z.object({
        name: z.string(),
        channelType: z.string(),
        accountId: z.string(),
        chatId: z.string(),
        userId: z.string().optional(),
      }),
    ),
  }

  export type Context = {
    channelType: string
    accountId: string
    chatId: string
    senderId?: string
    scopeKey?: string
    messageId: string
    senderName?: string
    mentions?: Array<{ key: string; id?: string; name?: string }>
    wasMentioned?: boolean
    remainder: string
  }

  export type Result = { action: "handled"; reply?: string } | { action: "continue"; text: string } | { action: "skip" }

  type CommandDef = {
    name: string
    triggers: string[]
    execute: (ctx: Context) => Promise<Result>
  }

  function endpointForContext(ctx: Pick<Context, "channelType" | "accountId" | "chatId" | "senderId" | "scopeKey">) {
    return SessionEndpoint.fromChannel({
      type: ctx.channelType,
      accountId: ctx.accountId,
      chatId: ctx.chatId,
      senderId: ctx.senderId,
      scopeKey: ctx.scopeKey,
    })
  }

  const commands: CommandDef[] = [
    {
      name: "new",
      triggers: ["/new", "/reset", "/重置", "/清空", "/新对话"],
      async execute(ctx) {
        await Session.archiveEndpointSession(endpointForContext(ctx))
        log.info("session reset", { channelType: ctx.channelType, chatId: ctx.chatId })

        if (ctx.remainder) {
          return { action: "continue", text: ctx.remainder }
        }
        return {
          action: "handled",
          reply: "✅ Started a new conversation. Send your next message when ready.",
        }
      },
    },
    {
      name: "status",
      triggers: ["/status", "/状态"],
      async execute(ctx) {
        const session = await Session.findForEndpoint(endpointForContext(ctx))
        if (!session) {
          return { action: "handled", reply: "📭 No conversation history yet." }
        }

        const msgs = await Session.messages({ sessionID: session.id, limit: 100 })
        const created = new Date(session.time.created).toLocaleString("en-US")
        const updated = new Date(session.time.updated).toLocaleString("en-US")

        const reply = [
          "📊 Conversation status",
          `Messages: ${msgs.length}`,
          `Created: ${created}`,
          `Updated: ${updated}`,
        ].join("\n")

        return { action: "handled", reply }
      },
    },
    {
      name: "help",
      triggers: ["/help", "/commands"],
      async execute() {
        return {
          action: "handled",
          reply: [
            "Available commands:",
            "/new — start a new conversation",
            "/status — show the current conversation status",
            "/help — show this command list",
          ].join("\n"),
        }
      },
    },
  ]

  function stripLeadingMentions(text: string, mentions?: Context["mentions"]): string {
    const trimmed = text.trim()
    if (!trimmed) return trimmed

    let result = trimmed
    const sortedMentions = [...(mentions ?? [])]
      .map((mention) => `@${mention.name}`.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)

    while (true) {
      const next = result.trimStart()
      const matched = sortedMentions.find((mention) => next.toLowerCase().startsWith(mention.toLowerCase()))
      if (!matched) return result.trim()
      result = next.slice(matched.length).trimStart()
    }
  }

  function parse(
    text: string,
    ctx?: Pick<Context, "mentions" | "wasMentioned">,
  ): { command: CommandDef; remainder: string } | null {
    const candidates = [text.trim()]
    if (ctx?.wasMentioned) {
      const stripped = stripLeadingMentions(text, ctx.mentions)
      if (stripped && stripped !== candidates[0]) candidates.push(stripped)
    }

    for (const candidate of candidates) {
      const lower = candidate.toLowerCase()
      for (const cmd of commands) {
        for (const trigger of cmd.triggers) {
          const triggerLower = trigger.toLowerCase()
          if (lower === triggerLower || lower.startsWith(triggerLower + " ")) {
            const remainder = candidate.slice(trigger.length).trim()
            return { command: cmd, remainder }
          }
        }
      }
    }

    return null
  }

  export async function execute(text: string, ctx: Omit<Context, "remainder">): Promise<Result> {
    const parsed = parse(text, ctx)

    if (!parsed) return { action: "skip" }

    const result = await parsed.command.execute({
      ...ctx,
      remainder: parsed.remainder,
    })

    Bus.publish(Event.Executed, {
      name: parsed.command.name,
      channelType: ctx.channelType,
      accountId: ctx.accountId,
      chatId: ctx.chatId,
      userId: ctx.senderId,
    })

    log.info("command executed", { name: parsed.command.name, action: result.action })
    return result
  }
}
